import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackSocketModeClient, type SocketModeHandlers } from "../src/socket-mode.js";

type WsListener = (event: Record<string, unknown>) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  sent: string[] = [];
  closeCount = 0;
  readyState = 0;
  private listeners: Record<string, WsListener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, fn: WsListener): void {
    (this.listeners[event] ??= []).push(fn);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }

  fire(event: string, data: Record<string, unknown> = {}): void {
    if (event === "open") this.readyState = 1;
    if (event === "close") this.readyState = 3;
    for (const fn of this.listeners[event] ?? []) fn(data);
  }

  fireMessage(payload: Record<string, unknown>): void {
    this.fire("message", { data: JSON.stringify(payload) });
  }
}

function makeCtx() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    http: {
      fetch: vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, url: "wss://socket.slack.test/link" }),
      }),
    },
  } as any;
}

function makeHandlers(overrides: Partial<SocketModeHandlers> = {}): SocketModeHandlers {
  return {
    onEventCallback: vi.fn().mockResolvedValue(undefined),
    onSlashCommand: vi.fn().mockResolvedValue(undefined),
    onInteractive: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeClient(
  ctx = makeCtx(),
  handlers = makeHandlers(),
  options: Record<string, unknown> = {},
) {
  return new SlackSocketModeClient(ctx, "xapp-test-token", handlers, {
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    reconnectBaseDelayMs: 10,
    maxReconnectDelayMs: 40,
    healthyConnectionResetMs: 50,
    tooManyWebSocketsCooldownMs: 100,
    ...options,
  });
}

describe("SlackSocketModeClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens Socket Mode with the app token", async () => {
    const ctx = makeCtx();
    const client = makeClient(ctx);

    await client.start();

    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/apps.connections.open",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer xapp-test-token",
        }),
      }),
    );
    expect(MockWebSocket.instances[0].url).toBe("wss://socket.slack.test/link");

    client.stop();
  });

  it("does not open a second websocket while one is active", async () => {
    const ctx = makeCtx();
    const client = makeClient(ctx);

    await client.start();
    await client.start();

    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);

    client.stop();
  });

  it("acks envelopes before handler work completes", async () => {
    let releaseHandler: () => void = () => {};
    const handlers = makeHandlers({
      onEventCallback: vi.fn(() => new Promise<void>((resolve) => {
        releaseHandler = resolve;
      })),
    });
    const client = makeClient(makeCtx(), handlers);

    await client.start();
    MockWebSocket.instances[0].fireMessage({
      envelope_id: "env-123",
      type: "events_api",
      payload: { type: "event_callback", event: { type: "message" } },
    });

    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ envelope_id: "env-123" }));
    releaseHandler();
    await Promise.resolve();

    client.stop();
  });

  it("dispatches events_api, slash_commands, and interactive envelopes", async () => {
    const handlers = makeHandlers();
    const client = makeClient(makeCtx(), handlers);

    await client.start();
    const ws = MockWebSocket.instances[0];
    ws.fireMessage({
      envelope_id: "env-event",
      type: "events_api",
      payload: { type: "event_callback", event: { type: "app_mention" } },
    });
    ws.fireMessage({
      envelope_id: "env-slash",
      type: "slash_commands",
      payload: { command: "/clip", text: "status" },
    });
    ws.fireMessage({
      envelope_id: "env-interactive",
      type: "interactive",
      payload: { type: "block_actions", actions: [] },
    });
    await Promise.resolve();

    expect(handlers.onEventCallback).toHaveBeenCalledWith({ type: "event_callback", event: { type: "app_mention" } });
    expect(handlers.onSlashCommand).toHaveBeenCalledWith({ command: "/clip", text: "status" });
    expect(handlers.onInteractive).toHaveBeenCalledWith({ type: "block_actions", actions: [] });

    client.stop();
  });

  it("reconnects with bounded backoff on disconnect", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const client = makeClient(ctx);

    await client.start();
    MockWebSocket.instances[0].fire("close", { code: 1006, reason: "network" });

    await vi.advanceTimersByTimeAsync(10);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances).toHaveLength(2);

    client.stop();
  });

  it("does not reset reconnect backoff for connections that close immediately", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const client = makeClient(ctx);

    await client.start();
    MockWebSocket.instances[0].fire("close", { code: 1006, reason: "network" });
    await vi.advanceTimersByTimeAsync(10);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(2);

    MockWebSocket.instances[1].fire("open");
    MockWebSocket.instances[1].fire("close", { code: 1006, reason: "network" });
    await vi.advanceTimersByTimeAsync(19);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(3);

    client.stop();
  });

  it("resets reconnect backoff only after a healthy connection window", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const client = makeClient(ctx);

    await client.start();
    MockWebSocket.instances[0].fire("close", { code: 1006, reason: "network" });
    await vi.advanceTimersByTimeAsync(10);

    MockWebSocket.instances[1].fire("open");
    await vi.advanceTimersByTimeAsync(50);
    MockWebSocket.instances[1].fire("close", { code: 1006, reason: "network" });
    await vi.advanceTimersByTimeAsync(10);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(3);

    client.stop();
  });

  it("acks and reconnects when Slack sends a disconnect envelope", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const client = makeClient(ctx);

    await client.start();
    const ws = MockWebSocket.instances[0];
    ws.fireMessage({
      envelope_id: "env-disconnect",
      type: "disconnect",
      reason: "refresh_requested",
    });

    expect(ws.sent).toContain(JSON.stringify({ envelope_id: "env-disconnect" }));
    expect(ws.closeCount).toBe(1);

    await vi.advanceTimersByTimeAsync(10);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(2);

    client.stop();
  });

  it("backs off for too_many_websockets disconnects", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const client = makeClient(ctx);

    await client.start();
    const ws = MockWebSocket.instances[0];
    ws.fireMessage({
      envelope_id: "env-disconnect",
      type: "disconnect",
      reason: "too_many_websockets",
    });

    await vi.advanceTimersByTimeAsync(99);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(ctx.http.fetch).toHaveBeenCalledTimes(2);

    client.stop();
  });
});
