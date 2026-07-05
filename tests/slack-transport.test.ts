import { describe, it, expect, vi } from "vitest";
import { WEBHOOK_KEYS } from "../src/constants.js";
import {
  createSocketModeHandlers,
  dispatchSlackWebhook,
  encodeSlashCommandPayload,
  extractInteractivityPayload,
  type SlackTransportHandlers,
} from "../src/slack-transport.js";

function makeHandlers(): SlackTransportHandlers {
  return {
    handleEventsPayload: vi.fn().mockResolvedValue(undefined),
    handleSlashCommandBody: vi.fn().mockResolvedValue(undefined),
    handleInteractivityPayload: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Slack transport dispatch", () => {
  it("uses the same event handler for webhook and Socket Mode events", async () => {
    const handlers = makeHandlers();
    const socketHandlers = createSocketModeHandlers(handlers);
    const payload = { type: "event_callback", event: { type: "app_mention", text: "<@B> hi" } };

    await dispatchSlackWebhook({
      endpointKey: WEBHOOK_KEYS.slackEvents,
      headers: {},
      rawBody: JSON.stringify(payload),
      parsedBody: payload,
      requestId: "req-1",
    }, handlers);
    await socketHandlers.onEventCallback(payload);

    expect(handlers.handleEventsPayload).toHaveBeenNthCalledWith(1, payload);
    expect(handlers.handleEventsPayload).toHaveBeenNthCalledWith(2, payload);
  });

  it("uses the same slash command handler for webhook and Socket Mode slash commands", async () => {
    const handlers = makeHandlers();
    const socketHandlers = createSocketModeHandlers(handlers);

    await dispatchSlackWebhook({
      endpointKey: WEBHOOK_KEYS.slashCommand,
      headers: {},
      rawBody: "command=%2Fclip&text=status&response_url=https%3A%2F%2Fhooks.slack.test%2Fresp",
      parsedBody: undefined,
      requestId: "req-2",
    }, handlers);
    await socketHandlers.onSlashCommand({
      command: "/clip",
      text: "status",
      response_url: "https://hooks.slack.test/resp",
    });

    expect(handlers.handleSlashCommandBody).toHaveBeenNthCalledWith(
      1,
      "command=%2Fclip&text=status&response_url=https%3A%2F%2Fhooks.slack.test%2Fresp",
    );
    expect(handlers.handleSlashCommandBody).toHaveBeenNthCalledWith(
      2,
      "command=%2Fclip&text=status&response_url=https%3A%2F%2Fhooks.slack.test%2Fresp",
    );
  });

  it("uses the same interactivity handler for webhook and Socket Mode actions", async () => {
    const handlers = makeHandlers();
    const socketHandlers = createSocketModeHandlers(handlers);
    const payload = {
      type: "block_actions",
      response_url: "https://hooks.slack.test/resp",
      actions: [{ action_id: "approval_approve", value: "apr-1" }],
    };

    await dispatchSlackWebhook({
      endpointKey: WEBHOOK_KEYS.interactivity,
      headers: {},
      rawBody: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
      parsedBody: { payload: JSON.stringify(payload) },
      requestId: "req-3",
    }, handlers);
    await socketHandlers.onInteractive(payload);

    expect(handlers.handleInteractivityPayload).toHaveBeenNthCalledWith(1, payload);
    expect(handlers.handleInteractivityPayload).toHaveBeenNthCalledWith(2, payload);
  });

  it("ignores Slack URL verification challenges", async () => {
    const handlers = makeHandlers();

    await dispatchSlackWebhook({
      endpointKey: WEBHOOK_KEYS.slackEvents,
      headers: {},
      rawBody: JSON.stringify({ type: "url_verification", challenge: "abc" }),
      parsedBody: { type: "url_verification", challenge: "abc" },
      requestId: "req-4",
    }, handlers);

    expect(handlers.handleEventsPayload).not.toHaveBeenCalled();
  });
});

describe("Slack payload normalization", () => {
  it("encodes Socket Mode slash command objects as Slack form bodies", () => {
    expect(encodeSlashCommandPayload({
      command: "/clip",
      text: "acp spawn builder",
      response_url: "https://hooks.slack.test/resp",
      channel_id: "C123",
      ignored: { nested: true },
    })).toBe("command=%2Fclip&text=acp+spawn+builder&response_url=https%3A%2F%2Fhooks.slack.test%2Fresp&channel_id=C123");
  });

  it("extracts interactivity payloads from parsed form bodies and raw form bodies", () => {
    const payload = { type: "block_actions", actions: [{ action_id: "handoff_approve", value: "h1" }] };

    expect(extractInteractivityPayload({ payload: JSON.stringify(payload) })).toEqual(payload);
    expect(extractInteractivityPayload(undefined, new URLSearchParams({ payload: JSON.stringify(payload) }).toString())).toEqual(payload);
  });
});
