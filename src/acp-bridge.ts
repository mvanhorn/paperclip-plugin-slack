import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { SlackBlock, SlackMessage } from "./slack-api.js";
import { postMessage } from "./slack-api.js";

type AcpPayload = Record<string, unknown>;

const ACP_BIND_PREFIX = "acp-bind-";

export function formatAsBlocks(text: string, toolName?: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  if (toolName) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Tool: \`${toolName}\`` },
      ],
    });
  }

  // Split on fenced code blocks to render them separately
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      const inner = trimmed.slice(3, -3).replace(/^\w*\n/, "");
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `\`\`\`${inner}\`\`\`` },
      });
    } else {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: trimmed },
      });
    }
  }

  return blocks;
}

function bindingKey(channel: string, threadTs: string): string {
  return `${ACP_BIND_PREFIX}${channel}-${threadTs}`;
}

export async function handleAcpSlashCommand(
  ctx: PluginContext,
  payload: { channel: string; threadTs: string; text: string; companyId: string },
): Promise<void> {
  const subArgs = payload.text.trim().split(/\s+/);
  const sub = subArgs[0]?.toLowerCase() ?? "";

  if (sub === "bind") {
    const agentId = subArgs[1];
    if (!agentId) {
      ctx.logger.warn("acp bind requires an agent ID");
      return;
    }

    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: payload.companyId,
        stateKey: bindingKey(payload.channel, payload.threadTs),
      },
      agentId,
    );
    ctx.logger.info("ACP session bound", {
      channel: payload.channel,
      threadTs: payload.threadTs,
      agentId,
    });
    return;
  }

  if (sub === "unbind") {
    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: payload.companyId,
        stateKey: bindingKey(payload.channel, payload.threadTs),
      },
      null,
    );
    ctx.logger.info("ACP session unbound", {
      channel: payload.channel,
      threadTs: payload.threadTs,
    });
    return;
  }

  ctx.logger.warn("Unknown /acp subcommand", { sub });
}

export async function routeMessageToAcp(
  ctx: PluginContext,
  companyId: string,
  channel: string,
  threadTs: string,
  text: string,
): Promise<boolean> {
  const agentId = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: bindingKey(channel, threadTs),
  });

  if (!agentId) return false;

  ctx.events.emit("acp:message", {
    agentId: String(agentId),
    channel,
    threadTs,
    text,
    companyId,
  });

  ctx.logger.info("Routed message to ACP agent", {
    agentId: String(agentId),
    channel,
    threadTs,
  });
  return true;
}

export async function handleAcpOutput(
  ctx: PluginContext,
  token: string,
  event: PluginEvent,
): Promise<void> {
  const p = event.payload as AcpPayload;
  const channel = String(p.channel ?? "");
  const threadTs = String(p.threadTs ?? "");
  const text = String(p.text ?? "");
  const toolName = p.toolName != null ? String(p.toolName) : undefined;

  if (!channel || !threadTs) {
    ctx.logger.warn("acp:output missing channel or threadTs", { channel, threadTs });
    return;
  }

  const blocks = formatAsBlocks(text, toolName);
  const message: SlackMessage = {
    text: text.slice(0, 200),
    blocks,
  };

  const result = await postMessage(ctx, token, channel, message, { threadTs });
  if (result.ok) {
    await ctx.activity.log({
      companyId: event.companyId,
      message: "Posted ACP agent output to Slack thread",
      entityType: "plugin",
      entityId: event.entityId,
    });
  }
}
