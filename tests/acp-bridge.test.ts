import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  spawnAgent,
  closeAgent,
  routeMessageToAgent,
  handleAgentOutput,
  buildHandoffBlocks,
  handleHandoffAction,
  startDiscussion,
  handleDiscussionAction,
  handleAcpSlashCommand,
} from "../src/acp-bridge.js";
import { STATE_KEYS } from "../src/constants.js";
import type { SessionEntry, DiscussionLoop } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers (same pattern as discord plugin tests)
// ---------------------------------------------------------------------------

const stateStore = new Map<string, unknown>();

function makeCtx(overrides: Record<string, unknown> = {}) {
  stateStore.clear();
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    agents: {
      list: vi.fn().mockResolvedValue([{ id: "agent-1", name: "CodeBot" }]),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "sess-native-1" }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      },
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
    },
    state: {
      get: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }) => {
        return Promise.resolve(stateStore.get(stateKey) ?? null);
      }),
      set: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }, value: unknown) => {
        stateStore.set(stateKey, value);
        return Promise.resolve(undefined);
      }),
    },
    http: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, ts: "1234.5678" }),
        text: () => Promise.resolve(""),
      }),
    },
    events: { emit: vi.fn(), on: vi.fn() },
    ...overrides,
  } as any;
}

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-1",
    agentId: "agent-1",
    agentName: "agent-1",
    agentDisplayName: "CodeBot",
    transport: "native",
    status: "active",
    spawnedAt: "2026-03-15T12:00:00Z",
    lastActivityAt: "2026-03-15T12:00:00Z",
    ...overrides,
  };
}

function seedSessions(channelId: string, threadTs: string, sessions: SessionEntry[]) {
  stateStore.set(STATE_KEYS.sessionRegistry(channelId, threadTs), sessions);
}

const TOKEN = "xoxb-test-token";
const COMPANY = "co-1";
const CHANNEL = "C-test";
const THREAD = "1700000000.000001";

// ---------------------------------------------------------------------------
// spawnAgent
// ---------------------------------------------------------------------------

describe("spawnAgent", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("creates a native session when ctx.agents.sessions.create succeeds", async () => {
    const entry = await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "bot-a", "Bot A");
    expect(entry).not.toBeNull();
    expect(entry!.transport).toBe("native");
    expect(entry!.sessionId).toBe("sess-native-1");
    expect(entry!.agentName).toBe("bot-a");
    expect(entry!.agentDisplayName).toBe("Bot A");
    expect(entry!.status).toBe("active");
  });

  it("falls back to ACP transport when native session creation fails", async () => {
    ctx.agents.sessions.create.mockRejectedValueOnce(new Error("no native"));
    const entry = await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "bot-a", "Bot A");
    expect(entry).not.toBeNull();
    expect(entry!.transport).toBe("acp");
    expect(ctx.events.emit).toHaveBeenCalledWith("acp-spawn", COMPANY, expect.objectContaining({
      agentId: "bot-a",
    }));
  });

  it("persists session to state store", async () => {
    await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "bot-a", "Bot A");
    const key = STATE_KEYS.sessionRegistry(CHANNEL, THREAD);
    const stored = stateStore.get(key) as SessionEntry[];
    expect(stored).toHaveLength(1);
    expect(stored[0].agentName).toBe("bot-a");
  });

  it("returns null when max agents per thread is reached", async () => {
    const existing = Array.from({ length: 5 }, (_, i) =>
      makeSession({ sessionId: `sess-${i}`, agentId: `agent-${i}`, agentName: `agent-${i}` }),
    );
    seedSessions(CHANNEL, THREAD, existing);

    const entry = await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "agent-new", "New");
    expect(entry).toBeNull();
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("returns existing session if agent already active", async () => {
    const existing = [makeSession({ agentName: "bot-a", agentDisplayName: "Bot A" })];
    seedSessions(CHANNEL, THREAD, existing);

    const entry = await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "bot-a", "Bot A");
    expect(entry).not.toBeNull();
    expect(entry!.sessionId).toBe("sess-1"); // original session
  });

  it("does not count closed sessions toward cap", async () => {
    const existing = Array.from({ length: 5 }, (_, i) =>
      makeSession({ sessionId: `sess-${i}`, agentId: `agent-${i}`, agentName: `agent-${i}`, status: "closed" }),
    );
    seedSessions(CHANNEL, THREAD, existing);

    const entry = await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "agent-new", "New");
    expect(entry).not.toBeNull();
  });

  it("passes reason to native session create", async () => {
    await spawnAgent(ctx, COMPANY, CHANNEL, THREAD, "bot-a", "Bot A", "custom reason");
    expect(ctx.agents.sessions.create).toHaveBeenCalledWith("bot-a", COMPANY, expect.objectContaining({
      reason: "custom reason",
    }));
  });
});

// ---------------------------------------------------------------------------
// closeAgent
// ---------------------------------------------------------------------------

describe("closeAgent", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("closes a named agent by name (case-insensitive)", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "CodeBot" })]);
    const closed = await closeAgent(ctx, COMPANY, CHANNEL, THREAD, "codebot");
    expect(closed).not.toBeNull();
    expect(closed!.status).toBe("closed");
  });

  it("closes most recent active agent when no name given", async () => {
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "BotOld", lastActivityAt: "2026-03-15T10:00:00Z" }),
      makeSession({ sessionId: "sess-2", agentName: "BotNew", lastActivityAt: "2026-03-15T14:00:00Z" }),
    ]);
    const closed = await closeAgent(ctx, COMPANY, CHANNEL, THREAD);
    expect(closed).not.toBeNull();
    expect(closed!.agentName).toBe("BotNew");
  });

  it("returns null when no active agent matches", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "CodeBot", status: "closed" })]);
    const closed = await closeAgent(ctx, COMPANY, CHANNEL, THREAD, "codebot");
    expect(closed).toBeNull();
  });

  it("calls native session close for native transport", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ transport: "native", sessionId: "sess-native" })]);
    await closeAgent(ctx, COMPANY, CHANNEL, THREAD);
    expect(ctx.agents.sessions.close).toHaveBeenCalledWith("sess-native", COMPANY);
  });

  it("does not call native close for ACP transport", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ transport: "acp" })]);
    await closeAgent(ctx, COMPANY, CHANNEL, THREAD);
    expect(ctx.agents.sessions.close).not.toHaveBeenCalled();
  });

  it("persists the closed status to state", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "bot-a" })]);
    await closeAgent(ctx, COMPANY, CHANNEL, THREAD, "bot-a");
    const key = STATE_KEYS.sessionRegistry(CHANNEL, THREAD);
    const stored = stateStore.get(key) as SessionEntry[];
    expect(stored[0].status).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// routeMessageToAgent
// ---------------------------------------------------------------------------

describe("routeMessageToAgent", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("returns false when no active sessions exist", async () => {
    const result = await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "hello");
    expect(result).toBe(false);
  });

  it("routes to agent matching @mention", async () => {
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "alpha", agentDisplayName: "Alpha" }),
      makeSession({ sessionId: "sess-2", agentName: "beta", agentDisplayName: "Beta" }),
    ]);
    const result = await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "@beta do this");
    expect(result).toBe(true);
    // For native transport, sendMessage should be called with the beta session
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith(
      "sess-2", COMPANY, expect.objectContaining({ prompt: "@beta do this" }),
    );
  });

  it("falls back to most recently active when no @mention match", async () => {
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "old-bot", lastActivityAt: "2026-03-15T10:00:00Z" }),
      makeSession({ sessionId: "sess-2", agentName: "new-bot", lastActivityAt: "2026-03-15T14:00:00Z" }),
    ]);
    const result = await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "just a message");
    expect(result).toBe(true);
  });

  it("emits acp-message for ACP transport agents", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ transport: "acp", agentName: "acp-bot" })]);
    const result = await routeMessageToAgent(ctx, COMPANY, CHANNEL, THREAD, "test");
    expect(result).toBe(true);
    expect(ctx.events.emit).toHaveBeenCalledWith("acp-message", COMPANY, expect.objectContaining({
      agentId: "acp-bot",
    }));
  });
});

// ---------------------------------------------------------------------------
// handleAgentOutput
// ---------------------------------------------------------------------------

describe("handleAgentOutput", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("early-returns when channel is missing", async () => {
    await handleAgentOutput(ctx, TOKEN, COMPANY, {
      channel: "",
      threadTs: THREAD,
      text: "hello",
    });
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("early-returns when threadTs is missing", async () => {
    await handleAgentOutput(ctx, TOKEN, COMPANY, {
      channel: CHANNEL,
      threadTs: "",
      text: "hello",
    });
    expect(ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("posts directly in single-agent mode", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "bot-a" })]);
    await handleAgentOutput(ctx, TOKEN, COMPANY, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "output text",
      agentName: "bot-a",
    });
    expect(ctx.http.fetch).toHaveBeenCalled();
    expect(ctx.activity.log).toHaveBeenCalled();
  });

  it("logs activity on successful post", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "bot-a" })]);
    await handleAgentOutput(ctx, TOKEN, COMPANY, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "output",
      agentName: "bot-a",
    });
    expect(ctx.activity.log).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY,
    }));
  });
});

// ---------------------------------------------------------------------------
// buildHandoffBlocks
// ---------------------------------------------------------------------------

describe("buildHandoffBlocks", () => {
  it("returns section and actions blocks", () => {
    const blocks = buildHandoffBlocks("AgentA", "AgentB", "needs help", "hoff-1");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveProperty("type", "section");
    expect(blocks[1]).toHaveProperty("type", "actions");
  });

  it("includes from/to agent names in section text", () => {
    const blocks = buildHandoffBlocks("Alice", "Bob", "complex task", "hoff-2");
    const text = (blocks[0] as any).text.text;
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
    expect(text).toContain("complex task");
  });

  it("includes approve and reject buttons with handoff ID", () => {
    const blocks = buildHandoffBlocks("A", "B", "reason", "hoff-3");
    const actions = (blocks[1] as any).elements;
    expect(actions).toHaveLength(2);
    expect(actions[0].action_id).toBe("handoff_approve");
    expect(actions[0].value).toBe("hoff-3");
    expect(actions[1].action_id).toBe("handoff_reject");
    expect(actions[1].value).toBe("hoff-3");
  });

  it("sets primary style on approve and danger on reject", () => {
    const blocks = buildHandoffBlocks("A", "B", "r", "hoff-4");
    const actions = (blocks[1] as any).elements;
    expect(actions[0].style).toBe("primary");
    expect(actions[1].style).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// handleHandoffAction
// ---------------------------------------------------------------------------

describe("handleHandoffAction", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("warns and returns when handoff record not found", async () => {
    await handleHandoffAction(ctx, TOKEN, COMPANY, "missing-id", true, "U123");
    expect(ctx.logger.warn).toHaveBeenCalledWith("Handoff record not found", expect.any(Object));
    expect(ctx.metrics.write).not.toHaveBeenCalled();
  });

  it("marks handoff as approved and writes metric", async () => {
    const handoffId = "hoff-1";
    stateStore.set(STATE_KEYS.handoff(handoffId), {
      channelId: CHANNEL,
      threadTs: THREAD,
      fromAgent: "AgentA",
      toAgent: "AgentB",
      reason: "needs help",
    });
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "AgentB", sessionId: "sess-b" }),
    ]);

    await handleHandoffAction(ctx, TOKEN, COMPANY, handoffId, true, "U123");
    const stored = stateStore.get(STATE_KEYS.handoff(handoffId)) as any;
    expect(stored.status).toBe("approved");
    expect(stored.resolvedBy).toBe("slack:U123");
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.handoffs.resolved", 1, { decision: "approved" });
  });

  it("marks handoff as rejected and writes metric", async () => {
    const handoffId = "hoff-2";
    stateStore.set(STATE_KEYS.handoff(handoffId), {
      channelId: CHANNEL,
      threadTs: THREAD,
      fromAgent: "AgentA",
      toAgent: "AgentB",
    });

    await handleHandoffAction(ctx, TOKEN, COMPANY, handoffId, false, "U456");
    const stored = stateStore.get(STATE_KEYS.handoff(handoffId)) as any;
    expect(stored.status).toBe("rejected");
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.handoffs.resolved", 1, { decision: "rejected" });
  });

  it("sends message to native target session on approval", async () => {
    const handoffId = "hoff-3";
    stateStore.set(STATE_KEYS.handoff(handoffId), {
      channelId: CHANNEL,
      threadTs: THREAD,
      fromAgent: "AgentA",
      toAgent: "AgentB",
      reason: "context needed",
    });
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "AgentB", sessionId: "sess-b", transport: "native" }),
    ]);

    await handleHandoffAction(ctx, TOKEN, COMPANY, handoffId, true, "U789");
    expect(ctx.agents.sessions.sendMessage).toHaveBeenCalledWith("sess-b", COMPANY, expect.objectContaining({
      reason: "Handoff from AgentA",
    }));
  });

  it("emits acp-message when target is ACP transport", async () => {
    const handoffId = "hoff-4";
    stateStore.set(STATE_KEYS.handoff(handoffId), {
      channelId: CHANNEL,
      threadTs: THREAD,
      fromAgent: "AgentA",
      toAgent: "AgentB",
    });
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "AgentB", transport: "acp" }),
    ]);

    await handleHandoffAction(ctx, TOKEN, COMPANY, handoffId, true, "U111");
    expect(ctx.events.emit).toHaveBeenCalledWith("acp-message", COMPANY, expect.objectContaining({
      agentId: "AgentB",
    }));
  });
});

// ---------------------------------------------------------------------------
// startDiscussion
// ---------------------------------------------------------------------------

describe("startDiscussion", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("returns active status and a discussion ID", async () => {
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "AgentA" }),
      makeSession({ sessionId: "sess-2", agentName: "AgentB" }),
    ]);

    const result = await startDiscussion(ctx, TOKEN, COMPANY, {
      initiatorAgent: "AgentA",
      targetAgent: "AgentB",
      topic: "architecture review",
      channelId: CHANNEL,
      threadTs: THREAD,
      maxTurns: 10,
    });

    expect(result.status).toBe("active");
    expect(result.discussionId).toMatch(/^disc-/);
  });

  it("persists discussion loop to state", async () => {
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "AgentA" }),
      makeSession({ sessionId: "sess-2", agentName: "AgentB" }),
    ]);

    const result = await startDiscussion(ctx, TOKEN, COMPANY, {
      initiatorAgent: "AgentA",
      targetAgent: "AgentB",
      topic: "test topic",
      channelId: CHANNEL,
      threadTs: THREAD,
      maxTurns: 6,
    });

    const loop = stateStore.get(STATE_KEYS.discussion(result.discussionId)) as DiscussionLoop;
    expect(loop).toBeDefined();
    expect(loop.initiatorAgent).toBe("AgentA");
    expect(loop.targetAgent).toBe("AgentB");
    expect(loop.maxTurns).toBe(6);
    expect(loop.turns).toBe(0);
    expect(loop.status).toBe("active");
  });

  it("sets active discussion key for the thread", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "A" }), makeSession({ sessionId: "s2", agentName: "B" })]);

    const result = await startDiscussion(ctx, TOKEN, COMPANY, {
      initiatorAgent: "A",
      targetAgent: "B",
      topic: "t",
      channelId: CHANNEL,
      threadTs: THREAD,
      maxTurns: 4,
    });

    const activeId = stateStore.get(STATE_KEYS.activeDiscussion(CHANNEL, THREAD));
    expect(activeId).toBe(result.discussionId);
  });

  it("posts announcement to Slack channel", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "A" }), makeSession({ sessionId: "s2", agentName: "B" })]);

    await startDiscussion(ctx, TOKEN, COMPANY, {
      initiatorAgent: "A",
      targetAgent: "B",
      topic: "t",
      channelId: CHANNEL,
      threadTs: THREAD,
      maxTurns: 4,
    });

    expect(ctx.http.fetch).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleDiscussionAction
// ---------------------------------------------------------------------------

describe("handleDiscussionAction", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("warns and returns when discussion not found", async () => {
    await handleDiscussionAction(ctx, TOKEN, COMPANY, "disc-missing", "continue", "U1");
    expect(ctx.logger.warn).toHaveBeenCalledWith("Discussion record not found", expect.any(Object));
  });

  it("stops a discussion and clears active discussion key", async () => {
    const discId = "disc-stop-test";
    const loop: DiscussionLoop = {
      id: discId,
      channelId: CHANNEL,
      threadTs: THREAD,
      initiatorAgent: "A",
      targetAgent: "B",
      reason: "test",
      turns: 3,
      maxTurns: 10,
      status: "paused",
      lastTurnAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    stateStore.set(STATE_KEYS.discussion(discId), loop);
    stateStore.set(STATE_KEYS.activeDiscussion(CHANNEL, THREAD), discId);

    await handleDiscussionAction(ctx, TOKEN, COMPANY, discId, "stop", "U1");

    const stored = stateStore.get(STATE_KEYS.discussion(discId)) as DiscussionLoop;
    expect(stored.status).toBe("completed");
    expect(stateStore.get(STATE_KEYS.activeDiscussion(CHANNEL, THREAD))).toBeNull();
    expect(ctx.metrics.write).toHaveBeenCalledWith("slack.discussions.stopped", 1, { by: "U1" });
  });

  it("resumes a paused discussion and re-sets active key", async () => {
    const discId = "disc-resume-test";
    const loop: DiscussionLoop = {
      id: discId,
      channelId: CHANNEL,
      threadTs: THREAD,
      initiatorAgent: "A",
      targetAgent: "B",
      reason: "test",
      turns: 4,
      maxTurns: 10,
      status: "paused",
      lastTurnAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    stateStore.set(STATE_KEYS.discussion(discId), loop);
    seedSessions(CHANNEL, THREAD, [
      makeSession({ agentName: "A" }),
      makeSession({ sessionId: "s2", agentName: "B" }),
    ]);

    await handleDiscussionAction(ctx, TOKEN, COMPANY, discId, "continue", "U2");

    const stored = stateStore.get(STATE_KEYS.discussion(discId)) as DiscussionLoop;
    expect(stored.status).toBe("active");
    expect(stateStore.get(STATE_KEYS.activeDiscussion(CHANNEL, THREAD))).toBe(discId);
  });
});

// ---------------------------------------------------------------------------
// handleAcpSlashCommand
// ---------------------------------------------------------------------------

describe("handleAcpSlashCommand", () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { ctx = makeCtx(); });

  it("spawns an agent with 'spawn <name>'", async () => {
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "spawn my-agent MyAgent",
      companyId: COMPANY,
    });
    const key = STATE_KEYS.sessionRegistry(CHANNEL, THREAD);
    const sessions = stateStore.get(key) as SessionEntry[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentName).toBe("my-agent");
    expect(sessions[0].agentDisplayName).toBe("MyAgent");
  });

  it("uses agent name as display name when display name omitted", async () => {
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "spawn solo-bot",
      companyId: COMPANY,
    });
    const sessions = stateStore.get(STATE_KEYS.sessionRegistry(CHANNEL, THREAD)) as SessionEntry[];
    expect(sessions[0].agentDisplayName).toBe("solo-bot");
  });

  it("warns when spawn has no agent name", async () => {
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "spawn",
      companyId: COMPANY,
    });
    expect(ctx.logger.warn).toHaveBeenCalledWith("acp spawn requires an agent name");
  });

  it("shows status with active agents", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "bot-a", agentDisplayName: "Bot A" })]);
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "status",
      companyId: COMPANY,
    });
    expect(ctx.http.fetch).toHaveBeenCalled();
  });

  it("shows 'no active agents' when none exist", async () => {
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "status",
      companyId: COMPANY,
    });
    expect(ctx.http.fetch).toHaveBeenCalled();
  });

  it("closes agent with 'close <name>'", async () => {
    seedSessions(CHANNEL, THREAD, [makeSession({ agentName: "bot-a" })]);
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "close bot-a",
      companyId: COMPANY,
    });
    const sessions = stateStore.get(STATE_KEYS.sessionRegistry(CHANNEL, THREAD)) as SessionEntry[];
    expect(sessions[0].status).toBe("closed");
  });

  it("warns on unknown subcommand", async () => {
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "foobar",
      companyId: COMPANY,
    });
    expect(ctx.logger.warn).toHaveBeenCalledWith("Unknown /acp subcommand", { sub: "foobar" });
  });

  it("handles empty text as unknown subcommand", async () => {
    await handleAcpSlashCommand(ctx, TOKEN, {
      channel: CHANNEL,
      threadTs: THREAD,
      text: "",
      companyId: COMPANY,
    });
    expect(ctx.logger.warn).toHaveBeenCalledWith("Unknown /acp subcommand", { sub: "" });
  });
});
