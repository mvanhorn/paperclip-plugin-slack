import {
  definePlugin,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS } from "./constants.js";
import { postMessage, respondToAction } from "./slack-api.js";
import type { SlackMessage } from "./slack-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatApprovalResolved,
  formatAgentError,
  formatAgentConnected,
  formatBudgetThreshold,
  formatOnboardingMilestone,
  formatDailyDigest,
} from "./formatters.js";

type SlackConfig = {
  slackTokenRef: string;
  defaultChannelId: string;
  approvalsChannelId: string;
  errorsChannelId: string;
  pipelineChannelId: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentConnected: boolean;
  notifyOnBudgetThreshold: boolean;
  enableDailyDigest: boolean;
};

async function resolveChannel(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "slack-channel",
  });
  return (override as string) ?? fallback ?? null;
}

function parseSlashCommand(rawBody: string): { command: string; text: string; responseUrl: string } {
  const params = new URLSearchParams(rawBody);
  return {
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
    responseUrl: params.get("response_url") ?? "",
  };
}

export default definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const config = rawConfig as unknown as SlackConfig;

    if (!config.slackTokenRef) {
      ctx.logger.warn("No slackTokenRef configured, notifications disabled");
      return;
    }

    const token = await ctx.secrets.resolve(config.slackTokenRef);

    // --- Notification helper (supports per-type channel override) ---
    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent) => SlackMessage,
      overrideChannelId?: string,
    ) => {
      const fallback = overrideChannelId || config.defaultChannelId;
      const channelId = await resolveChannel(ctx, event.companyId, fallback);
      if (!channelId) return;
      const result = await postMessage(ctx, token, channelId, formatter(event));
      if (result.ok) {
        await ctx.activity.log({
          companyId: event.companyId,
          message: `Forwarded ${event.eventType} to Slack`,
          entityType: "plugin",
          entityId: event.entityId,
        });
      }
    };

    // --- Core event subscriptions ---

    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", (event: PluginEvent) =>
        notify(event, formatIssueCreated),
      );
    }

    if (config.notifyOnIssueDone) {
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "done") return;
        await notify(event, formatIssueDone);
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", (event: PluginEvent) =>
        notify(event, formatApprovalCreated, config.approvalsChannelId),
      );
    }

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", (event: PluginEvent) =>
        notify(event, formatAgentError, config.errorsChannelId),
      );
    }

    if (config.notifyOnAgentConnected) {
      ctx.events.on("agent.status_changed", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status === "active" || payload.status === "online") {
          await notify(event, formatAgentConnected, config.pipelineChannelId);
        }
      });

      ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const key = `first-run-notified-${event.entityId}`;
        const alreadyNotified = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: key,
        });
        if (alreadyNotified) return;

        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: key },
          true,
        );
        const milestoneEvent = {
          ...event,
          payload: { ...payload, milestone: "first successful run" },
        };
        await notify(milestoneEvent, formatOnboardingMilestone, config.pipelineChannelId);
      });
    }

    if (config.notifyOnBudgetThreshold) {
      ctx.events.on("cost_event.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const pct = Number(payload.percentUsed ?? 0);
        if (pct < 80) return;

        const bucket = pct >= 100 ? 100 : pct >= 90 ? 90 : 80;
        const key = `budget-alert-${event.entityId}-${bucket}`;
        const alreadySent = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: key,
        });
        if (alreadySent) return;

        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: key },
          true,
        );
        await notify(event, formatBudgetThreshold, config.pipelineChannelId);
      });
    }

    // --- Per-company channel overrides ---

    ctx.data.register("channel-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "slack-channel",
      });
      return { channelId: saved ?? config.defaultChannelId };
    });

    ctx.actions.register("set-channel", async (params) => {
      const companyId = String(params.companyId);
      const channelId = String(params.channelId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: "slack-channel" },
        channelId,
      );
      ctx.logger.info("Updated Slack channel mapping", { companyId, channelId });
      return { ok: true };
    });

    // --- Daily digest job ---

    if (config.enableDailyDigest) {
      ctx.jobs.register("daily-digest", async () => {
        const companies = await ctx.companies.list({ limit: 100, offset: 0 });
        for (const company of companies) {
          const channelId = await resolveChannel(ctx, company.id, config.defaultChannelId);
          if (!channelId) continue;

          const issues = await ctx.issues.list({ companyId: company.id, limit: 200, offset: 0 });
          const now = new Date();
          const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

          let tasksCompleted = 0;
          let tasksCreated = 0;
          for (const issue of issues) {
            const updated = new Date(issue.updatedAt);
            const created = new Date(issue.createdAt);
            if (issue.status === "done" && updated >= dayAgo) tasksCompleted++;
            if (created >= dayAgo) tasksCreated++;
          }

          const agents = await ctx.agents.list({ companyId: company.id, limit: 100, offset: 0 });
          const agentsActive = agents.filter((a) =>
            (a as unknown as Record<string, unknown>).status === "active" ||
            (a as unknown as Record<string, unknown>).status === "online"
          ).length;

          // Cost tracking: read accumulated daily cost from state
          const dateKey = now.toISOString().slice(0, 10);
          const dailyCost = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: `daily-cost-${dateKey}`,
          });
          const totalCost = dailyCost ? String((dailyCost as number).toFixed(2)) : "0.00";

          const topAgentCosts = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: `daily-agent-costs-${dateKey}`,
          });
          let topAgent = "";
          if (topAgentCosts && typeof topAgentCosts === "object") {
            const costs = topAgentCosts as Record<string, number>;
            let maxCost = 0;
            for (const [name, cost] of Object.entries(costs)) {
              if (cost > maxCost) { maxCost = cost; topAgent = name; }
            }
          }

          await postMessage(ctx, token, channelId, formatDailyDigest({
            tasksCompleted,
            tasksCreated,
            agentsActive,
            totalCost,
            topAgent,
          }));
        }
        ctx.logger.info("Daily digest posted to Slack");
      });

      // Accumulate costs from cost events for daily digest
      ctx.events.on("cost_event.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const cost = Number(payload.cost ?? 0);
        if (cost <= 0) return;

        const dateKey = new Date().toISOString().slice(0, 10);
        const currentTotal = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: `daily-cost-${dateKey}`,
        });
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: `daily-cost-${dateKey}` },
          ((currentTotal as number) ?? 0) + cost,
        );

        const agentName = String(payload.agentName ?? payload.name ?? event.entityId);
        const agentCosts = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: `daily-agent-costs-${dateKey}`,
        });
        const costs = (agentCosts as Record<string, number>) ?? {};
        costs[agentName] = (costs[agentName] ?? 0) + cost;
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: `daily-agent-costs-${dateKey}` },
          costs,
        );
      });

      ctx.logger.info("Daily digest job registered (9am daily)");
    }

    ctx.logger.info("Slack notifications plugin started (v0.2.0)");
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    const body = input.parsedBody as Record<string, unknown> | undefined;

    if (input.endpointKey === WEBHOOK_KEYS.slackEvents) {
      if (body?.type === "url_verification") {
        return;
      }
    }

    if (input.endpointKey === WEBHOOK_KEYS.slashCommand) {
      const { text } = parseSlashCommand(input.rawBody);
      const _subcommand = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    }

    // Handle interactive button clicks (approve/reject)
    if (input.endpointKey === WEBHOOK_KEYS.interactivity) {
      const payload = body?.payload
        ? JSON.parse(String(body.payload)) as Record<string, unknown>
        : body;
      if (!payload || payload.type !== "block_actions") return;

      const actions = payload.actions as Array<Record<string, unknown>>;
      const responseUrl = String(payload.response_url ?? "");
      const user = payload.user as Record<string, unknown> | undefined;
      const userId = user ? String(user.id ?? user.username ?? "unknown") : "unknown";

      if (!actions?.length || !responseUrl) return;

      const action = actions[0];
      const actionId = String(action.action_id ?? "");
      const approvalId = String(action.value ?? "");

      if (!approvalId) return;

      const ctx = input as unknown as PluginContext;
      let approved: boolean;
      if (actionId === "approval_approve") {
        approved = true;
      } else if (actionId === "approval_reject") {
        approved = false;
      } else {
        return;
      }

      const endpoint = approved ? "approve" : "reject";
      try {
        const rawConfig = await (input as unknown as { config: { get(): Promise<unknown> } }).config.get();
        const config = rawConfig as unknown as SlackConfig;
        const token = await (input as unknown as { secrets: { resolve(ref: string): Promise<string> } }).secrets.resolve(config.slackTokenRef);

        await (input as unknown as { http: { fetch(url: string, init: RequestInit): Promise<Response> } }).http.fetch(
          `http://localhost:3100/api/approvals/${approvalId}/${endpoint}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decidedByUserId: `slack:${userId}` }),
          },
        );

        await respondToAction(
          input as unknown as PluginContext,
          token,
          responseUrl,
          formatApprovalResolved(approvalId, approved, userId),
        );
      } catch (err) {
        (input as unknown as PluginContext).logger?.warn("Failed to handle approval action", { err, approvalId });
      }
    }
  },

  async onValidateConfig(config) {
    if (!config.slackTokenRef || typeof config.slackTokenRef !== "string") {
      return { ok: false, errors: ["slackTokenRef is required"] };
    }
    if (!config.defaultChannelId || typeof config.defaultChannelId !== "string") {
      return { ok: false, errors: ["defaultChannelId is required"] };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});
