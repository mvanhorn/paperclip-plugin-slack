import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface SocketModeHandlers {
  onEventCallback: (body: Record<string, unknown>) => Promise<void>;
  onSlashCommand: (payload: Record<string, unknown>) => Promise<void>;
  onInteractive: (payload: Record<string, unknown>) => Promise<void>;
}

export interface SocketModeClientOptions {
  reconnectBaseDelayMs?: number;
  maxReconnectDelayMs?: number;
  healthyConnectionResetMs?: number;
  tooManyWebSocketsCooldownMs?: number;
  WebSocketCtor?: typeof WebSocket;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

interface SocketModeEnvelope {
  envelope_id?: string;
  type: string;
  payload?: Record<string, unknown>;
  reason?: string;
  debug_info?: Record<string, unknown>;
}

const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_HEALTHY_CONNECTION_RESET_MS = 60_000;
const DEFAULT_TOO_MANY_WEBSOCKETS_COOLDOWN_MS = 5 * 60_000;

export class SlackSocketModeClient {
  private readonly ctx: PluginContext;
  private readonly appToken: string;
  private readonly handlers: SocketModeHandlers;
  private readonly reconnectBaseDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly healthyConnectionResetMs: number;
  private readonly tooManyWebSocketsCooldownMs: number;
  private readonly WebSocketCtor?: typeof WebSocket;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthyConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private connectInFlight = false;
  private stopped = true;

  constructor(
    ctx: PluginContext,
    appToken: string,
    handlers: SocketModeHandlers,
    options: SocketModeClientOptions = {},
  ) {
    this.ctx = ctx;
    this.appToken = appToken;
    this.handlers = handlers;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.healthyConnectionResetMs = options.healthyConnectionResetMs ?? DEFAULT_HEALTHY_CONNECTION_RESET_MS;
    this.tooManyWebSocketsCooldownMs =
      options.tooManyWebSocketsCooldownMs ?? DEFAULT_TOO_MANY_WEBSOCKETS_COOLDOWN_MS;
    this.WebSocketCtor = options.WebSocketCtor;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHealthyConnectionTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        this.ctx.logger.warn("Socket Mode: failed to close WebSocket", { err });
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if (this.connectInFlight || this.hasActiveSocket()) return;

    this.connectInFlight = true;
    try {
      const wssUrl = await this.openConnection();
      if (this.stopped) return;

      const WebSocketCtor = this.WebSocketCtor ?? globalThis.WebSocket;
      if (!WebSocketCtor) {
        throw new Error("WebSocket runtime is not available");
      }

      const ws = new WebSocketCtor(wssUrl);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.scheduleHealthyConnectionReset();
        this.ctx.logger.info("Socket Mode connected");
        this.writeMetric("slack.socket.connected");
      });

      ws.addEventListener("message", (event) => {
        const raw = this.coerceMessageData(event.data);
        if (raw) this.handleMessage(ws, raw);
      });

      ws.addEventListener("close", (event) => {
        if (this.ws === ws) this.ws = null;
        this.clearHealthyConnectionTimer();
        this.ctx.logger.info("Socket Mode disconnected", {
          code: event.code,
          reason: event.reason,
        });
        this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        if (this.ws === ws) this.ws = null;
        this.clearHealthyConnectionTimer();
        this.ctx.logger.warn("Socket Mode WebSocket error");
        try {
          ws.close();
        } catch {
          // Close can throw when the underlying socket is already gone.
        }
        this.scheduleReconnect();
      });
    } catch (err) {
      this.ctx.logger.warn("Socket Mode connection failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
    } finally {
      this.connectInFlight = false;
    }
  }

  private async openConnection(): Promise<string> {
    const response = await this.ctx.http.fetch(`${SLACK_API_BASE}/apps.connections.open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const body = await response.json() as {
      ok?: boolean;
      url?: string;
      error?: string;
    };

    if (!body.ok || typeof body.url !== "string" || !body.url.startsWith("wss://")) {
      throw new Error(`apps.connections.open failed: ${body.error ?? "missing wss url"}`);
    }

    return body.url;
  }

  private coerceMessageData(data: unknown): string | null {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return null;
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    let envelope: SocketModeEnvelope;
    try {
      envelope = JSON.parse(raw) as SocketModeEnvelope;
    } catch {
      this.ctx.logger.warn("Socket Mode: unparseable message", { preview: raw.slice(0, 120) });
      return;
    }

    if (envelope.envelope_id) {
      this.ackEnvelope(ws, envelope.envelope_id);
      this.writeMetric("slack.socket.envelope", { envelope_type: envelope.type });
    }

    if (envelope.type === "disconnect") {
      this.handleDisconnectEnvelope(ws, envelope);
      return;
    }

    if (!envelope.envelope_id) {
      return;
    }

    void this.dispatch(envelope).catch((err) => {
      this.ctx.logger.warn("Socket Mode: handler error", {
        type: envelope.type,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeMetric("slack.socket.handler_error", { envelope_type: envelope.type });
    });
  }

  private ackEnvelope(ws: WebSocket, envelopeId: string): void {
    try {
      ws.send(JSON.stringify({ envelope_id: envelopeId }));
    } catch (err) {
      this.ctx.logger.warn("Socket Mode: failed to ack envelope", {
        envelopeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatch(envelope: SocketModeEnvelope): Promise<void> {
    const payload = envelope.payload ?? {};
    switch (envelope.type) {
      case "events_api":
        await this.handlers.onEventCallback(payload);
        break;
      case "slash_commands":
        await this.handlers.onSlashCommand(payload);
        break;
      case "interactive":
        await this.handlers.onInteractive(payload);
        break;
      default:
        this.ctx.logger.info("Socket Mode: ignoring envelope type", { type: envelope.type });
    }
  }

  private handleDisconnectEnvelope(ws: WebSocket, envelope: SocketModeEnvelope): void {
    this.ctx.logger.info("Socket Mode disconnect requested", {
      reason: envelope.reason,
      debugInfo: envelope.debug_info,
    });
    this.writeMetric("slack.socket.disconnect", { reason: envelope.reason ?? "unknown" });
    if (this.ws === ws) this.ws = null;
    this.clearHealthyConnectionTimer();
    try {
      ws.close();
    } catch {
      // Slack may already have closed the underlying socket.
    }
    this.scheduleReconnect(
      envelope.reason === "too_many_websockets"
        ? this.tooManyWebSocketsCooldownMs
        : undefined,
    );
  }

  private scheduleReconnect(delayOverrideMs?: number): void {
    if (this.stopped || this.reconnectTimer) return;

    const delayMs = delayOverrideMs ?? Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.maxReconnectDelayMs,
    );
    if (delayOverrideMs === undefined) this.reconnectAttempt += 1;

    this.ctx.logger.info("Socket Mode: reconnect scheduled", {
      attempt: this.reconnectAttempt,
      delayMs,
    });

    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private hasActiveSocket(): boolean {
    if (!this.ws) return false;
    const readyState = (this.ws as WebSocket & { readyState?: number }).readyState;
    return typeof readyState !== "number" || readyState === 0 || readyState === 1;
  }

  private scheduleHealthyConnectionReset(): void {
    this.clearHealthyConnectionTimer();
    this.healthyConnectionTimer = this.setTimeoutFn(() => {
      this.healthyConnectionTimer = null;
      this.reconnectAttempt = 0;
    }, this.healthyConnectionResetMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHealthyConnectionTimer(): void {
    if (!this.healthyConnectionTimer) return;
    this.clearTimeoutFn(this.healthyConnectionTimer);
    this.healthyConnectionTimer = null;
  }

  private writeMetric(name: string, tags?: Record<string, string>): void {
    if (!this.ctx.metrics?.write) return;
    void this.ctx.metrics.write(name, 1, tags);
  }
}
