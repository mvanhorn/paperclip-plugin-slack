import {
  definePlugin,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
} from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS } from "./constants.js";
import { postMessage } from "./slack-api.js";
import { formatIssueCreated, formatIssueDone, formatApprovalCreated } from "./formatters.js";

type SlackConfig = {
  slackTokenRef: string;
  defaultChannelId: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
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

export default definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const config = rawConfig as unknown as SlackConfig;

    if (!config.slackTokenRef) {
      ctx.logger.warn("No slackTokenRef configured, notifications disabled");
      return;
    }

    const token = await ctx.secrets.resolve(config.slackTokenRef);

    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", async (event: PluginEvent) => {
        const channelId = await resolveChannel(ctx, event.companyId, config.defaultChannelId);
        if (!channelId) return;
        await postMessage(ctx, token, channelId, formatIssueCreated(event));
      });
    }

    if (config.notifyOnIssueDone) {
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "done") return;
        const channelId = await resolveChannel(ctx, event.companyId, config.defaultChannelId);
        if (!channelId) return;
        await postMessage(ctx, token, channelId, formatIssueDone(event));
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", async (event: PluginEvent) => {
        const channelId = await resolveChannel(ctx, event.companyId, config.defaultChannelId);
        if (!channelId) return;
        await postMessage(ctx, token, channelId, formatApprovalCreated(event));
      });
    }

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

    ctx.logger.info("Slack notifications plugin started");
  },

  async onWebhook(input: PluginWebhookInput) {
    const body = input.parsedBody as Record<string, unknown> | undefined;

    if (input.endpointKey === WEBHOOK_KEYS.slackEvents) {
      if (body?.type === "url_verification") {
        return;
      }
    }

    if (input.endpointKey === WEBHOOK_KEYS.slashCommand) {
      // Slash command payloads come as form-encoded, parsed into rawBody
      // Future: parse command text and dispatch to handlers
    }
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});
