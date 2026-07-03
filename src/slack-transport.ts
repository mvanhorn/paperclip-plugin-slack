import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS } from "./constants.js";
import type { SocketModeHandlers } from "./socket-mode.js";

export interface SlackTransportHandlers {
  handleEventsPayload: (body: Record<string, unknown>) => Promise<void>;
  handleSlashCommandBody: (rawBody: string) => Promise<void>;
  handleInteractivityPayload: (payload: Record<string, unknown>) => Promise<void>;
}

export function encodeSlashCommandPayload(payload: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

export function extractInteractivityPayload(
  body: Record<string, unknown> | undefined,
  rawBody = "",
): Record<string, unknown> | null {
  const bodyPayload = body?.payload;
  if (bodyPayload && typeof bodyPayload === "object" && !Array.isArray(bodyPayload)) {
    return bodyPayload as Record<string, unknown>;
  }
  if (typeof bodyPayload === "string") {
    return parseJsonObject(bodyPayload);
  }
  if (body?.type) {
    return body;
  }

  const rawPayload = new URLSearchParams(rawBody).get("payload");
  return rawPayload ? parseJsonObject(rawPayload) : null;
}

export async function dispatchSlackWebhook(
  input: PluginWebhookInput,
  handlers: SlackTransportHandlers,
): Promise<void> {
  const body = isRecord(input.parsedBody) ? input.parsedBody : undefined;

  if (input.endpointKey === WEBHOOK_KEYS.slackEvents) {
    if (body?.type === "url_verification") return;
    if (body?.type === "event_callback") {
      await handlers.handleEventsPayload(body);
    }
    return;
  }

  if (input.endpointKey === WEBHOOK_KEYS.slashCommand) {
    await handlers.handleSlashCommandBody(input.rawBody);
    return;
  }

  if (input.endpointKey === WEBHOOK_KEYS.interactivity) {
    const payload = extractInteractivityPayload(body, input.rawBody);
    if (payload) {
      await handlers.handleInteractivityPayload(payload);
    }
  }
}

export function createSocketModeHandlers(
  handlers: SlackTransportHandlers,
): SocketModeHandlers {
  return {
    onEventCallback: handlers.handleEventsPayload,
    onSlashCommand: async (payload) => {
      await handlers.handleSlashCommandBody(encodeSlashCommandPayload(payload));
    },
    onInteractive: handlers.handleInteractivityPayload,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
