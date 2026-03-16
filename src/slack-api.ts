import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
  elements?: unknown[];
  accessory?: unknown;
}

export interface SlackMessage {
  text: string;
  blocks?: Array<SlackBlock | Record<string, unknown>>;
}

const SLACK_API_BASE = "https://slack.com/api";

export async function postMessage(
  ctx: PluginContext,
  token: string,
  channelId: string,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  const response = await ctx.http.fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: channelId,
      text: message.text,
      blocks: message.blocks,
    }),
  });

  const body = await response.json() as { ok: boolean; error?: string };

  if (!body.ok) {
    ctx.logger.warn("Slack API error", { error: body.error, channelId });
  }

  return body;
}

export async function respondToAction(
  ctx: PluginContext,
  token: string,
  responseUrl: string,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  const response = await ctx.http.fetch(responseUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replace_original: true,
      text: message.text,
      blocks: message.blocks,
    }),
  });

  const body = await response.json() as { ok: boolean; error?: string };

  if (!body.ok) {
    ctx.logger.warn("Slack action response error", { error: body.error, responseUrl });
  }

  return body;
}
