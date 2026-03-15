import {
  definePlugin,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS } from "./constants.js";
import { postMessage } from "./slack-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatAgentConnected,
  formatBudgetThreshold,
  formatOnboardingMilestone,
  formatDailyDigest,
} from "./formatters.js";

type SlackConfig = {
  slackTokenRef: string;
  defaultChannelId: string;
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

    // --- Notification helper ---
    const notify = async (event: PluginEvent, formatter: (e: PluginEvent) => ReturnType<typeof formatIssueCreated>) => {
      const channelId = await resolveChannel(ctx, event.companyId, config.defaultChannelId);
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
        notify(event, formatApprovalCreated),
      );
    }

    // --- New event subscriptions ---

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", (event: PluginEvent) =>
        notify(event, formatAgentError),
      );
    }

    if (config.notifyOnAgentConnected) {
      ctx.events.on("agent.status_changed", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status === "active" || payload.status === "online") {
          await notify(event, formatAgentConnected);
        }
      });

      // Onboarding milestone: first heartbeat
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
        await notify(milestoneEvent, formatOnboardingMilestone);
      });
    }

    if (config.notifyOnBudgetThreshold) {
      ctx.events.on("cost_event.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const pct = Number(payload.percentUsed ?? 0);
        if (pct < 80) return;

        // Only notify once per threshold crossing (80%, 90%, 100%)
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
        await notify(event, formatBudgetThreshold);
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
        // TODO: query ctx for actual stats when the API supports it
        // For now, post a placeholder that proves the job runs
        const stats = {
          tasksCompleted: 0,
          tasksCreated: 0,
          agentsActive: 0,
          totalCost: "0.00",
          topAgent: "",
        };

        const channelId = config.defaultChannelId;
        if (!channelId) return;

        await postMessage(ctx, token, channelId, formatDailyDigest(stats));
        ctx.logger.info("Daily digest posted to Slack");
      });
      ctx.logger.info("Daily digest job registered (9am daily)");
    }

    ctx.logger.info("Slack notifications plugin started (v0.1.1)");
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
      // Slash command handling: Slack expects an HTTP response within 3 seconds.
      // The host returns the webhook HTTP response, so this handler logs the
      // command for debugging. Full interactive responses (status, help) will
      // use the response_url for deferred replies once the host API supports it.
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
