import {
  definePlugin,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { EscalationManager, type EscalationRequest, type EscalationRecord } from "@paperclipai/chat-core";
import { WEBHOOK_KEYS } from "./constants.js";
import { postMessage, respondToAction, respondEphemeral } from "./slack-api.js";
import type { SlackMessage } from "./slack-api.js";
import { SlackAdapter } from "./adapter.js";
import {
  handleAcpSlashCommand,
  handleAcpOutput,
  routeMessageToAcp,
  handleHandoffTool,
  handleHandoffAction,
  handleDiscussWithAgentTool,
  handleDiscussionAction,
  setAcpToken,
} from "./acp-bridge.js";
import {
  setBaseUrl,
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
  escalationChatId: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentConnected: boolean;
  notifyOnBudgetThreshold: boolean;
  enableDailyDigest: boolean;
  escalationTimeoutMs: number;
  escalationDefaultAction: string;
  escalationHoldMessage: string;
  paperclipBaseUrl: string;
  maxAgentsPerThread: number;
};

let pluginCtx: PluginContext;
let pluginToken: string;
let pluginConfig: SlackConfig;
let escalationManager: EscalationManager;
let slackAdapter: SlackAdapter;

function formatEscalationMessage(escalation: EscalationRecord): SlackMessage {
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Escalation from ${escalation.agentName ?? "Agent"}` },
  });

  const fields: Array<{ type: string; text: string }> = [
    { type: "mrkdwn", text: `*Reason*\n${escalation.reason}` },
  ];
  if (escalation.confidence != null) {
    fields.push({ type: "mrkdwn", text: `*Confidence*\n${escalation.confidence}` });
  }
  blocks.push({ type: "section", fields });

  if (escalation.conversationHistory && escalation.conversationHistory.length > 0) {
    const lastMessages = escalation.conversationHistory.slice(-5);
    const historyText = lastMessages
      .map((msg: { role: string; text: string }) => `${msg.role}: ${msg.text}`)
      .join("\n");
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*Recent conversation*\n${historyText.slice(0, 2000)}` },
      ],
    });
  }

  if (escalation.agentReasoning) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Agent reasoning*\n${escalation.agentReasoning}`,
      },
    });
  }

  if (escalation.suggestedReply) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Suggested reply*\n> ${escalation.suggestedReply}`,
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Use Suggested Reply" },
        style: "primary",
        action_id: "escalation_use_suggested",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reply to Customer" },
        action_id: "escalation_reply",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Override Agent" },
        action_id: "escalation_override",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Dismiss" },
        style: "danger",
        action_id: "escalation_dismiss",
        value: escalation.id,
      },
    ],
  });

  return {
    text: `Escalation from ${escalation.agentName ?? "Agent"}: ${escalation.reason}`,
    blocks,
  };
}

function formatEscalationResolved(
  escalationId: string,
  action: string,
  userId: string,
): SlackMessage {
  const emoji = action === "dismiss" ? ":x:" : ":white_check_mark:";
  const label = action === "escalation_use_suggested"
    ? "Used suggested reply"
    : action === "escalation_override"
      ? "Overrode agent"
      : action === "escalation_dismiss"
        ? "Dismissed"
        : "Replied";

  return {
    text: `Escalation ${label} by ${userId}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *Escalation ${label}* by <@${userId}>`,
        },
      },
    ],
  };
}

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

function parseSlashCommand(rawBody: string): { command: string; text: string; responseUrl: string; userId: string; channelId: string } {
  const params = new URLSearchParams(rawBody);
  return {
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
    responseUrl: params.get("response_url") ?? "",
    userId: params.get("user_id") ?? "",
    channelId: params.get("channel_id") ?? "",
  };
}

function statusBadge(status: string): string {
  const badges: Record<string, string> = {
    active: ":large_green_circle:",
    running: ":large_green_circle:",
    idle: ":white_circle:",
    paused: ":double_vertical_bar:",
    error: ":red_circle:",
    pending_approval: ":hourglass:",
    terminated: ":black_circle:",
  };
  return badges[status] ?? ":white_circle:";
}

async function handleSlashCommand(ctx: PluginContext, rawBody: string): Promise<void> {
  const { text, responseUrl } = parseSlashCommand(rawBody);
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";
  const arg = parts[1]?.toLowerCase() ?? "";

  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id ?? "";

  try {
    switch (subcommand) {
      case "status":
        await handleStatusCommand(ctx, companyId, responseUrl);
        break;
      case "help":
      case "":
        await handleHelpCommand(ctx, responseUrl);
        break;
      case "agents":
        await handleAgentsCommand(ctx, companyId, responseUrl);
        break;
      case "issues":
        await handleIssuesCommand(ctx, companyId, responseUrl, arg);
        break;
      case "approve":
        await handleApproveCommand(ctx, responseUrl, arg);
        break;
      case "acp": {
        const slashParams = new URLSearchParams(rawBody);
        const channel = slashParams.get("channel_id") ?? "";
        const threadTs = slashParams.get("thread_ts") ?? "";
        const acpText = parts.slice(1).join(" ");
        await handleAcpSlashCommand(ctx, {
          channel,
          threadTs,
          text: acpText,
          companyId,
        });
        break;
      }
      default:
        await respondEphemeral(ctx, responseUrl, {
          text: `Unknown command: \`${subcommand}\`. Use \`/clip help\` to see available commands.`,
        });
    }
    await ctx.metrics.write("slack.commands.handled", 1, { command_name: subcommand || "help" });
  } catch (err) {
    ctx.logger.warn("Slash command failed", { subcommand, err });
    await respondEphemeral(ctx, responseUrl, {
      text: "Something went wrong processing your command. Please try again.",
    });
  }
}

async function handleStatusCommand(ctx: PluginContext, companyId: string, responseUrl: string): Promise<void> {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  const activeAgents = agents.filter((a) => a.status === "active" || a.status === "running");
  const recentDone = await ctx.issues.list({ companyId, status: "done", limit: 5, offset: 0 });

  const agentSummary = activeAgents.length > 0
    ? activeAgents.map((a) => `${statusBadge(a.status)} ${a.name}`).join("\n")
    : "_No active agents_";

  const issueSummary = recentDone.length > 0
    ? recentDone.map((i) => `:white_check_mark: ${i.title}`).join("\n")
    : "_No recent completions_";

  await respondEphemeral(ctx, responseUrl, {
    text: `Status: ${activeAgents.length} active agents, ${recentDone.length} recent completions`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Paperclip Status" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Active Agents (${activeAgents.length})*\n${agentSummary}` },
          { type: "mrkdwn", text: `*Recent Completions*\n${issueSummary}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Dashboard" },
            url: pluginConfig.paperclipBaseUrl,
            action_id: "view_dashboard",
          },
        ],
      },
    ],
  });
}

async function handleHelpCommand(ctx: PluginContext, responseUrl: string): Promise<void> {
  await respondEphemeral(ctx, responseUrl, {
    text: "Available /clip commands",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Paperclip Slash Commands" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "`/clip status` - Show active agents and recent completions",
            "`/clip agents` - List all agents with status badges",
            "`/clip issues [open|done]` - List issues filtered by status",
            "`/clip approve <id>` - Approve a pending approval",
            "`/clip acp bind <agentId>` - Bind an ACP agent to this thread",
            "`/clip acp unbind` - Unbind the ACP agent from this thread",
            "`/clip acp spawn <agent> [display]` - Add an agent to this thread (multi-agent)",
            "`/clip acp status` - Show all agents in this thread",
            "`/clip acp close [name]` - Close a specific agent (or most recent)",
            "`/clip help` - Show this help message",
          ].join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `<${pluginConfig.paperclipBaseUrl}|Open Paperclip Dashboard>` },
        ],
      },
    ],
  });
}

async function handleAgentsCommand(ctx: PluginContext, companyId: string, responseUrl: string): Promise<void> {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });

  if (agents.length === 0) {
    await respondEphemeral(ctx, responseUrl, { text: "No agents found." });
    return;
  }

  const lines = agents.map((a) => `${statusBadge(a.status)} *${a.name}* - \`${a.status}\``);

  await respondEphemeral(ctx, responseUrl, {
    text: `${agents.length} agents`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Agents (${agents.length})` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

async function handleIssuesCommand(ctx: PluginContext, companyId: string, responseUrl: string, filter: string): Promise<void> {
  const status = filter === "done" ? "done" as const : filter === "open" ? "todo" as const : undefined;
  const issues = await ctx.issues.list({ companyId, status, limit: 10, offset: 0 });

  if (issues.length === 0) {
    await respondEphemeral(ctx, responseUrl, { text: `No ${status ?? ""} issues found.` });
    return;
  }

  const lines = issues.map((i) => {
    const badge = i.status === "done" ? ":white_check_mark:" : ":blue_book:";
    return `${badge} *${i.title}* - \`${i.status}\``;
  });

  await respondEphemeral(ctx, responseUrl, {
    text: `${issues.length} issues`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Issues${status ? ` (${status})` : ""} - showing ${issues.length}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

async function handleApproveCommand(ctx: PluginContext, responseUrl: string, approvalId: string): Promise<void> {
  if (!approvalId) {
    await respondEphemeral(ctx, responseUrl, { text: "Usage: `/clip approve <approval-id>`" });
    return;
  }

  try {
    await ctx.http.fetch(
      `${pluginConfig.paperclipBaseUrl}/api/approvals/${approvalId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedByUserId: "slack:command" }),
      },
    );
    await respondEphemeral(ctx, responseUrl, { text: `:white_check_mark: Approval \`${approvalId}\` approved.` });
    await ctx.metrics.write("slack.approvals.decided", 1, { decision: "approve" });
  } catch (err) {
    ctx.logger.warn("Approve command failed", { approvalId, err });
    await respondEphemeral(ctx, responseUrl, { text: `:x: Failed to approve \`${approvalId}\`. Check the ID and try again.` });
  }
}

export default definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const config = rawConfig as unknown as SlackConfig;

    pluginCtx = ctx;
    pluginConfig = config;

    if (config.paperclipBaseUrl) {
      setBaseUrl(config.paperclipBaseUrl);
    }

    if (!config.slackTokenRef) {
      ctx.logger.warn("No slackTokenRef configured, notifications disabled");
      return;
    }

    const token = await ctx.secrets.resolve(config.slackTokenRef);
    pluginToken = token;
    setAcpToken(token);

    // --- Notification helper (supports per-type channel override + threading) ---
    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent) => SlackMessage,
      overrideChannelId?: string,
      opts?: { threadTs?: string },
    ) => {
      const fallback = overrideChannelId || config.defaultChannelId;
      const channelId = await resolveChannel(ctx, event.companyId, fallback);
      if (!channelId) return;
      const result = await postMessage(ctx, token, channelId, formatter(event), opts);
      if (result.ok) {
        await ctx.activity.log({
          companyId: event.companyId,
          message: `Forwarded ${event.eventType} to Slack`,
          entityType: "plugin",
          entityId: event.entityId,
        });
        await ctx.metrics.write("slack.notifications.sent", 1, { event_type: event.eventType });
      } else {
        await ctx.metrics.write("slack.notifications.failed", 1, { event_type: event.eventType, error_code: result.error ?? "unknown" });
      }
      return result;
    };

    // --- Core event subscriptions ---

    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", async (event: PluginEvent) => {
        const result = await notify(event, formatIssueCreated);
        if (result?.ok && result.ts) {
          await ctx.state.set(
            { scopeKind: "company", scopeId: event.companyId, stateKey: `thread-issue-${event.entityId}` },
            result.ts,
          );
        }
      });
    }

    if (config.notifyOnIssueDone) {
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "done") return;
        const threadTs = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: `thread-issue-${event.entityId}`,
        }) as string | null;
        await notify(event, formatIssueDone, undefined, threadTs ? { threadTs } : undefined);
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", async (event: PluginEvent) => {
        await notify(event, formatApprovalCreated, config.approvalsChannelId);
      });
    }

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
        await notify(event, formatAgentError, config.errorsChannelId);
      });
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
        await ctx.metrics.write("slack.budget_alerts.sent", 1, { threshold: String(bucket) });
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
            a.status === "active" || a.status === "running"
          ).length;

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

          // Clean up previous day's cost state
          const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: `daily-cost-${yesterday}`,
          });
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: `daily-agent-costs-${yesterday}`,
          });
        }
        ctx.logger.info("Daily digest posted to Slack");
        await ctx.metrics.write("slack.digest.sent", 1);
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

    // --- Escalation support ---

    slackAdapter = new SlackAdapter(ctx, token);
    escalationManager = new EscalationManager({
      adapter: slackAdapter,
      timeoutMs: config.escalationTimeoutMs ?? 900000,
      defaultAction: (config.escalationDefaultAction as "defer" | "dismiss" | "auto_reply") ?? "defer",
      state: ctx.state,
    });

    ctx.events.on("escalation.created", async (event: PluginEvent) => {
      const payload = event.payload as Record<string, unknown>;
      const escalation = payload as unknown as EscalationRecord;
      const channelId = config.escalationChatId || config.approvalsChannelId || config.defaultChannelId;
      if (!channelId) return;

      const message = formatEscalationMessage(escalation);
      const result = await postMessage(ctx, token, channelId, message);

      if (result.ok && result.ts) {
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: `escalation-ts-${escalation.id}` },
          result.ts,
        );
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: `escalation-channel-${escalation.id}` },
          channelId,
        );
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: `escalation-record-${escalation.id}` },
          { ...escalation, createdAt: new Date().toISOString(), status: "open" },
        );
        await ctx.activity.log({
          companyId: event.companyId,
          message: `Escalation posted to Slack: ${escalation.reason}`,
          entityType: "plugin",
          entityId: escalation.id,
        });
        await ctx.metrics.write("slack.escalations.created", 1);
      }
    });

    ctx.events.on("slack:thread_reply_escalation", async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      const escalationId = String(p.escalationId ?? "");
      const replyText = String(p.text ?? "");
      const userId = String(p.userId ?? "unknown");
      if (!escalationId || !replyText) return;

      await escalationManager.resolve(escalationId, {
        action: "human_reply",
        replyText,
        resolvedBy: `slack:${userId}`,
      });

      const record = await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: `escalation-record-${escalationId}`,
      }) as Record<string, unknown> | null;
      if (record) {
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: `escalation-record-${escalationId}` },
          { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolvedBy: `slack:${userId}` },
        );
      }

      await ctx.metrics.write("slack.escalations.resolved", 1, { action: "human_reply" });
    });

    ctx.tools.register("escalate_to_human", {
      displayName: "Escalate to Human",
      description: "Escalates the current conversation to a human operator via the configured Slack escalation channel.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why the agent is escalating" },
          confidence: { type: "number", description: "Agent confidence score (0-1)" },
          agentName: { type: "string", description: "Name of the escalating agent" },
          conversationHistory: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                text: { type: "string" },
              },
            },
            description: "Last N messages of conversation context",
          },
          agentReasoning: { type: "string", description: "Agent's reasoning for the escalation" },
          suggestedReply: { type: "string", description: "Agent's suggested reply for the human to use" },
          companyId: { type: "string", description: "Company ID for scoping" },
        },
        required: ["reason", "companyId"],
      },
      handler: async (params: Record<string, unknown>) => {
        const escalationId = `esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record: EscalationRecord = {
          id: escalationId,
          reason: String(params.reason ?? ""),
          confidence: params.confidence != null ? Number(params.confidence) : undefined,
          agentName: params.agentName != null ? String(params.agentName) : undefined,
          conversationHistory: params.conversationHistory as Array<{ role: string; text: string }> | undefined,
          agentReasoning: params.agentReasoning != null ? String(params.agentReasoning) : undefined,
          suggestedReply: params.suggestedReply != null ? String(params.suggestedReply) : undefined,
          status: "open",
          createdAt: new Date().toISOString(),
        };

        ctx.events.emit("escalation.created", {
          companyId: String(params.companyId),
          ...record,
        });

        if (config.escalationHoldMessage) {
          return { escalationId, holdMessage: config.escalationHoldMessage };
        }
        return { escalationId };
      },
    });

    ctx.tools.register("handoff_to_agent", {
      displayName: "Handoff to Agent",
      description: "Requests a handoff from one agent to another in the same Slack thread. Posts an approval prompt with Approve/Reject buttons.",
      inputSchema: {
        type: "object",
        properties: {
          fromAgent: { type: "string", description: "Name of the agent initiating the handoff" },
          toAgent: { type: "string", description: "Name of the target agent to hand off to" },
          reason: { type: "string", description: "Why the handoff is needed" },
          context: { type: "string", description: "Context to pass to the target agent on approval" },
          channelId: { type: "string", description: "Slack channel ID" },
          threadTs: { type: "string", description: "Slack thread timestamp" },
          companyId: { type: "string", description: "Company ID for scoping" },
        },
        required: ["fromAgent", "toAgent", "reason", "channelId", "threadTs", "companyId"],
      },
      handler: async (params: Record<string, unknown>) => {
        return handleHandoffTool(ctx, token, params);
      },
    });

    ctx.tools.register("discuss_with_agent", {
      displayName: "Discuss with Agent",
      description: "Starts a conversation loop between two agents in a Slack thread. Messages are routed back and forth with agent labels. Pauses at human checkpoints every 5 turns.",
      inputSchema: {
        type: "object",
        properties: {
          initiatorAgent: { type: "string", description: "Name of the agent starting the discussion" },
          targetAgent: { type: "string", description: "Name of the other agent" },
          topic: { type: "string", description: "The topic or question to discuss" },
          maxTurns: { type: "number", description: "Maximum number of turns (default 10)" },
          channelId: { type: "string", description: "Slack channel ID" },
          threadTs: { type: "string", description: "Slack thread timestamp" },
          companyId: { type: "string", description: "Company ID for scoping" },
        },
        required: ["initiatorAgent", "targetAgent", "topic", "channelId", "threadTs", "companyId"],
      },
      handler: async (params: Record<string, unknown>) => {
        return handleDiscussWithAgentTool(ctx, token, params);
      },
    });

    ctx.jobs.register("check-escalation-timeouts", async () => {
      const companies = await ctx.companies.list({ limit: 100, offset: 0 });
      const timeoutMs = config.escalationTimeoutMs ?? 900000;
      const now = Date.now();

      for (const company of companies) {
        const openEscalations = await ctx.state.list({
          scopeKind: "company",
          scopeId: company.id,
          prefix: "escalation-record-",
        });

        for (const entry of openEscalations) {
          const record = entry.value as Record<string, unknown> | null;
          if (!record || record.status !== "open") continue;

          const createdAt = new Date(String(record.createdAt)).getTime();
          if (now - createdAt < timeoutMs) continue;

          const escalationId = String(record.id);
          const defaultAction = config.escalationDefaultAction ?? "defer";

          await escalationManager.resolve(escalationId, {
            action: defaultAction,
            resolvedBy: "system:timeout",
          });

          await ctx.state.set(
            { scopeKind: "company", scopeId: company.id, stateKey: `escalation-record-${escalationId}` },
            { ...record, status: "timed_out", resolvedAt: new Date().toISOString(), resolvedBy: "system:timeout" },
          );

          const channelId = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: `escalation-channel-${escalationId}`,
          }) as string | null;

          const threadTs = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: `escalation-ts-${escalationId}`,
          }) as string | null;

          if (channelId && threadTs) {
            await postMessage(ctx, token, channelId, {
              text: `Escalation timed out - default action: ${defaultAction}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `:hourglass: *Escalation timed out*\nDefault action applied: \`${defaultAction}\``,
                  },
                },
              ],
            }, { threadTs });
          }

          await ctx.metrics.write("slack.escalations.timed_out", 1, { action: defaultAction });
          ctx.logger.info("Escalation timed out", { escalationId, defaultAction });
        }
      }
    });

    // --- ACP bridge ---

    ctx.events.on("acp:output", (event: PluginEvent) =>
      handleAcpOutput(ctx, token, event),
    );

    ctx.events.on("slack:thread_message", async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      const channel = String(p.channel ?? "");
      const threadTs = String(p.threadTs ?? "");
      const text = String(p.text ?? "");
      const replyToMessageTs = p.replyToMessageTs != null ? String(p.replyToMessageTs) : undefined;
      if (!channel || !threadTs || !text) return;
      await routeMessageToAcp(ctx, event.companyId, channel, threadTs, text, replyToMessageTs);
    });

    ctx.logger.info("Slack notifications plugin started (v1.0.0)");
  },

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    const body = input.parsedBody as Record<string, unknown> | undefined;

    if (input.endpointKey === WEBHOOK_KEYS.slackEvents) {
      if (body?.type === "url_verification") {
        return;
      }
    }

    if (input.endpointKey === WEBHOOK_KEYS.slashCommand) {
      await handleSlashCommand(pluginCtx, input.rawBody);
      return;
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

      // --- Approval button handling ---
      if (actionId === "approval_approve" || actionId === "approval_reject") {
        const approved = actionId === "approval_approve";
        const endpoint = approved ? "approve" : "reject";
        try {
          await pluginCtx.http.fetch(
            `${pluginConfig.paperclipBaseUrl}/api/approvals/${approvalId}/${endpoint}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decidedByUserId: `slack:${userId}` }),
            },
          );

          await respondToAction(
            pluginCtx,
            pluginToken,
            responseUrl,
            formatApprovalResolved(approvalId, approved, userId),
          );
          await pluginCtx.metrics.write("slack.approvals.decided", 1, { decision: endpoint });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle approval action", { err, approvalId });
        }
        return;
      }

      // --- Escalation button handling ---
      const escalationId = String(action.value ?? "");
      if (
        actionId === "escalation_use_suggested" ||
        actionId === "escalation_reply" ||
        actionId === "escalation_override" ||
        actionId === "escalation_dismiss"
      ) {
        if (!escalationId) return;

        try {
          const resolveAction = actionId === "escalation_use_suggested"
            ? "use_suggested"
            : actionId === "escalation_reply"
              ? "human_reply"
              : actionId === "escalation_override"
                ? "override"
                : "dismiss";

          await escalationManager.resolve(escalationId, {
            action: resolveAction,
            resolvedBy: `slack:${userId}`,
          });

          const companies = await pluginCtx.companies.list({ limit: 1, offset: 0 });
          const companyId = companies[0]?.id ?? "";

          const record = await pluginCtx.state.get({
            scopeKind: "company",
            scopeId: companyId,
            stateKey: `escalation-record-${escalationId}`,
          }) as Record<string, unknown> | null;
          if (record) {
            await pluginCtx.state.set(
              { scopeKind: "company", scopeId: companyId, stateKey: `escalation-record-${escalationId}` },
              { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolvedBy: `slack:${userId}` },
            );
          }

          await respondToAction(
            pluginCtx,
            pluginToken,
            responseUrl,
            formatEscalationResolved(escalationId, actionId, userId),
          );
          await pluginCtx.metrics.write("slack.escalations.resolved", 1, { action: resolveAction });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle escalation action", { err, escalationId });
        }
        return;
      }

      // --- Handoff button handling ---
      if (actionId === "handoff_approve" || actionId === "handoff_reject") {
        const handoffId = String(action.value ?? "");
        if (!handoffId) return;

        try {
          const approved = actionId === "handoff_approve";
          await handleHandoffAction(pluginCtx, pluginToken, handoffId, approved, userId);

          const emoji = approved ? ":white_check_mark:" : ":x:";
          const label = approved ? "Approved" : "Rejected";
          await respondToAction(pluginCtx, pluginToken, responseUrl, {
            text: `Handoff ${label} by ${userId}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${emoji} *Handoff ${label}* by <@${userId}>`,
                },
              },
            ],
          });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle handoff action", { err, handoffId: action.value });
        }
        return;
      }

      // --- Discussion loop button handling ---
      if (actionId === "discussion_continue" || actionId === "discussion_stop") {
        const discussionId = String(action.value ?? "");
        if (!discussionId) return;

        try {
          const discAction = actionId === "discussion_continue" ? "continue" as const : "stop" as const;
          await handleDiscussionAction(pluginCtx, pluginToken, discussionId, discAction, userId);

          const emoji = discAction === "continue" ? ":arrow_forward:" : ":stop_button:";
          const label = discAction === "continue" ? "Resumed" : "Stopped";
          await respondToAction(pluginCtx, pluginToken, responseUrl, {
            text: `Discussion ${label} by ${userId}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${emoji} *Discussion ${label}* by <@${userId}>`,
                },
              },
            ],
          });
        } catch (err) {
          pluginCtx.logger.warn("Failed to handle discussion action", { err, discussionId: action.value });
        }
        return;
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
