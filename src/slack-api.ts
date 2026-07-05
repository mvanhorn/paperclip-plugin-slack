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

export interface SlackModalView {
  type: "modal";
  callback_id?: string;
  title: { type: "plain_text"; text: string };
  submit?: { type: "plain_text"; text: string };
  close?: { type: "plain_text"; text: string };
  private_metadata?: string;
  blocks: Array<SlackBlock | Record<string, unknown>>;
}

const SLACK_API_BASE = "https://slack.com/api";
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);

function isExpiredInvocationScopeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("invocation scope");
}

async function fetchWithRetry(
  ctx: PluginContext,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      let delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      if (lastResponse?.status === 429) {
        const retryAfter = lastResponse.headers?.get?.("Retry-After");
        if (retryAfter) delay = Math.max(Number(retryAfter) * 1000, delay);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
    let response: Response;
    try {
      response = await ctx.http.fetch(url, init);
    } catch (err) {
      if (!isExpiredInvocationScopeError(err)) throw err;
      response = await fetch(url, init);
    }
    if (!RETRYABLE_STATUS.has(response.status)) return response;
    lastResponse = response;
    ctx.logger.warn("Retryable HTTP error", { url, status: response.status, attempt });
  }
  return lastResponse!;
}

export async function postMessage(
  ctx: PluginContext,
  token: string,
  channelId: string,
  message: SlackMessage,
  opts?: { threadTs?: string },
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const payload: Record<string, unknown> = {
    channel: channelId,
    text: message.text,
    blocks: message.blocks,
  };
  if (opts?.threadTs) {
    payload.thread_ts = opts.threadTs;
  }

  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json() as { ok: boolean; ts?: string; error?: string };

  if (!body.ok) {
    ctx.logger.warn("Slack API error", { error: body.error, channelId });
  }

  return body;
}

export async function updateMessage(
  ctx: PluginContext,
  token: string,
  channelId: string,
  ts: string,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    channel: channelId,
    ts,
    text: message.text,
  };
  if (message.blocks) {
    payload.blocks = message.blocks;
  }

  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/chat.update`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json() as { ok: boolean; error?: string };
  if (!body.ok) {
    ctx.logger.warn("Slack chat.update failed", { error: body.error, channelId, ts });
  }
  return body;
}

export async function respondToAction(
  ctx: PluginContext,
  token: string,
  responseUrl: string,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetchWithRetry(ctx, responseUrl, {
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

  let body: { ok: boolean; error?: string };
  try {
    body = await response.json() as { ok: boolean; error?: string };
  } catch {
    body = response.ok ? { ok: true } : { ok: false, error: String(response.status) };
  }

  if (!body.ok) {
    ctx.logger.warn("Slack action response error", { error: body.error, responseUrl });
  }

  return body;
}

export async function respondEphemeral(
  ctx: PluginContext,
  responseUrl: string,
  message: SlackMessage,
): Promise<void> {
  await fetchWithRetry(ctx, responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      text: message.text,
      blocks: message.blocks,
    }),
  });
}

export async function openModal(
  ctx: PluginContext,
  token: string,
  triggerId: string,
  view: SlackModalView,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/views.open`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view,
    }),
  });

  const body = await response.json() as { ok: boolean; error?: string };
  if (!body.ok) {
    ctx.logger.warn("Slack views.open failed", { error: body.error });
  }
  return body;
}

export async function getFileInfo(
  ctx: PluginContext,
  token: string,
  fileId: string,
): Promise<{ url: string; mimetype: string; name: string } | null> {
  const response = await fetchWithRetry(ctx, `${SLACK_API_BASE}/files.info?file=${fileId}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` },
  });

  const body = await response.json() as {
    ok: boolean;
    file?: { url_private_download?: string; mimetype?: string; name?: string };
  };
  if (!body.ok || !body.file) return null;
  return {
    url: body.file.url_private_download ?? "",
    mimetype: body.file.mimetype ?? "",
    name: body.file.name ?? "",
  };
}

export async function downloadFile(
  ctx: PluginContext,
  token: string,
  url: string,
): Promise<ArrayBuffer | null> {
  const response = await ctx.http.fetch(url, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (response.status !== 200) return null;
  return response.arrayBuffer();
}
