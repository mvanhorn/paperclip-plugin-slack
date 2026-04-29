import { describe, it, expect, vi, beforeEach } from "vitest";
import { STATE_KEYS } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Minimal stubs that replicate the agent.run.finished handler logic so we
// can test the dedup behaviour without spinning up the full plugin worker.
// ---------------------------------------------------------------------------

type StateStore = Map<string, unknown>;

function makeHandlerEnv(store: StateStore) {
  const postMessageCalls: unknown[] = [];

  const ctx = {
    state: {
      async get({ stateKey }: { stateKey: string }) {
        return store.get(stateKey) ?? null;
      },
      async set({ stateKey }: { stateKey: string }, value: unknown) {
        store.set(stateKey, value);
      },
    },
    activity: { async log() {} },
    metrics: { async write() {} },
    logger: { warn() {}, info() {} },
  };

  // Simplified version of the notify helper — just records the call.
  const notify = async (_event: unknown) => {
    postMessageCalls.push(_event);
    return { ok: true, ts: "ts-1" };
  };

  // Replicates the patched handler from worker.ts (the fix under test).
  const handler = async (event: {
    entityId: string;
    companyId: string;
    payload: Record<string, unknown>;
  }) => {
    const payload = event.payload;
    const agentId = String(payload.agentId ?? event.entityId ?? "");
    const key = STATE_KEYS.firstRunNotified(agentId);
    const alreadyNotified = await ctx.state.get({ stateKey: key } as never);
    if (alreadyNotified) return;
    await ctx.state.set({ stateKey: key } as never, true);
    const milestoneEvent = {
      ...event,
      payload: {
        ...payload,
        agentName: String(payload.agentName ?? payload.name ?? agentId),
        milestone: "first successful run",
      },
    };
    await notify(milestoneEvent);
  };

  return { handler, postMessageCalls, store };
}

// ---------------------------------------------------------------------------

describe("agent.run.finished onboarding dedup", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new Map();
  });

  it("fires exactly once when two runs complete for the same agent", async () => {
    const { handler, postMessageCalls } = makeHandlerEnv(store);

    const agentId = "agent-abc-123";
    const baseEvent = {
      companyId: "co-1",
      payload: { agentId, agentName: "My Agent" },
    };

    // First run — unique run id
    await handler({ ...baseEvent, entityId: "run-uuid-001" });
    // Second run — different run id, same agent
    await handler({ ...baseEvent, entityId: "run-uuid-002" });

    expect(postMessageCalls).toHaveLength(1);
  });

  it("fires once per distinct agent", async () => {
    const { handler, postMessageCalls } = makeHandlerEnv(store);

    await handler({ companyId: "co-1", entityId: "run-001", payload: { agentId: "agent-A", agentName: "Agent A" } });
    await handler({ companyId: "co-1", entityId: "run-002", payload: { agentId: "agent-B", agentName: "Agent B" } });
    // Third run for agent-A — should be suppressed
    await handler({ companyId: "co-1", entityId: "run-003", payload: { agentId: "agent-A", agentName: "Agent A" } });

    expect(postMessageCalls).toHaveLength(2);
  });

  it("uses payload.agentName in the milestone event, not the run UUID", async () => {
    const { handler, postMessageCalls } = makeHandlerEnv(store);

    await handler({
      companyId: "co-1",
      entityId: "run-uuid-999",
      payload: { agentId: "agent-xyz", agentName: "Cool Agent" },
    });

    expect(postMessageCalls).toHaveLength(1);
    const fired = postMessageCalls[0] as { payload: Record<string, unknown> };
    expect(fired.payload.agentName).toBe("Cool Agent");
    expect(fired.payload.agentName).not.toMatch(/^run-uuid/);
  });

  it("falls back to agentId when agentName is missing", async () => {
    const { handler, postMessageCalls } = makeHandlerEnv(store);

    await handler({
      companyId: "co-1",
      entityId: "run-uuid-777",
      payload: { agentId: "agent-no-name" },
    });

    const fired = postMessageCalls[0] as { payload: Record<string, unknown> };
    expect(fired.payload.agentName).toBe("agent-no-name");
  });

  it("dedup key is keyed on agentId, not run entityId", () => {
    const agentId = "agent-dedup-test";
    const runId = "run-uuid-dedup";
    const agentKey = STATE_KEYS.firstRunNotified(agentId);
    const runKey = STATE_KEYS.firstRunNotified(runId);
    expect(agentKey).not.toBe(runKey);
    expect(agentKey).toBe(`first-run-notified-${agentId}`);
  });
});
