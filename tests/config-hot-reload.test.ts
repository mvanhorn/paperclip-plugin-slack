import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Tests for config hot-reload (bug #3 in upstream issue #21).
//
// The plugin used to read config once in setup() and gate handler registration
// with `if (config.notifyOnAgentConnected)`. Toggling the flag in the UI had
// no effect until the worker restarted.
//
// The fix: handlers are always registered; each handler calls ctx.config.get()
// at invocation time. These tests replicate that pattern and verify that
// disabling a flag mid-flight silences subsequent events.
// ---------------------------------------------------------------------------

type Config = {
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentConnected: boolean;
  notifyOnBudgetThreshold: boolean;
};

function makeHotReloadEnv(initial: Partial<Config> = {}) {
  // Mutable config store — simulates ctx.config.get() returning live values.
  let current: Config = {
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: true,
    notifyOnAgentError: true,
    notifyOnAgentConnected: true,
    notifyOnBudgetThreshold: true,
    ...initial,
  };

  const getConfig = async (): Promise<Config> => ({ ...current });
  const setConfig = (patch: Partial<Config>) => { current = { ...current, ...patch }; };

  const calls: string[] = [];

  // Simulates the always-registered agent.run.finished handler.
  const agentRunFinishedHandler = async (event: { agentId: string }) => {
    const live = await getConfig();
    if (!live.notifyOnAgentConnected) return;
    calls.push(`milestone:${event.agentId}`);
  };

  // Simulates the always-registered issue.created handler.
  const issueCreatedHandler = async (event: { issueId: string }) => {
    const live = await getConfig();
    if (!live.notifyOnIssueCreated) return;
    calls.push(`issue:${event.issueId}`);
  };

  return { agentRunFinishedHandler, issueCreatedHandler, setConfig, calls };
}

describe("config hot-reload — notifyOnAgentConnected", () => {
  it("fires milestone when flag is on", async () => {
    const { agentRunFinishedHandler, calls } = makeHotReloadEnv({ notifyOnAgentConnected: true });
    await agentRunFinishedHandler({ agentId: "agent-1" });
    expect(calls).toContain("milestone:agent-1");
  });

  it("suppresses milestone when flag starts off", async () => {
    const { agentRunFinishedHandler, calls } = makeHotReloadEnv({ notifyOnAgentConnected: false });
    await agentRunFinishedHandler({ agentId: "agent-1" });
    expect(calls).toHaveLength(0);
  });

  it("suppresses milestone after flag is toggled off mid-flight", async () => {
    const { agentRunFinishedHandler, setConfig, calls } = makeHotReloadEnv({ notifyOnAgentConnected: true });

    // First run fires (flag is on)
    await agentRunFinishedHandler({ agentId: "agent-1" });
    expect(calls).toHaveLength(1);

    // User toggles the setting off — no restart required
    setConfig({ notifyOnAgentConnected: false });

    // Second run is suppressed immediately
    await agentRunFinishedHandler({ agentId: "agent-2" });
    expect(calls).toHaveLength(1);
  });

  it("resumes milestone after flag is toggled back on", async () => {
    const { agentRunFinishedHandler, setConfig, calls } = makeHotReloadEnv({ notifyOnAgentConnected: false });

    await agentRunFinishedHandler({ agentId: "agent-1" });
    expect(calls).toHaveLength(0);

    setConfig({ notifyOnAgentConnected: true });

    await agentRunFinishedHandler({ agentId: "agent-2" });
    expect(calls).toHaveLength(1);
  });
});

describe("config hot-reload — notifyOnIssueCreated", () => {
  it("fires when flag is on", async () => {
    const { issueCreatedHandler, calls } = makeHotReloadEnv({ notifyOnIssueCreated: true });
    await issueCreatedHandler({ issueId: "ISS-1" });
    expect(calls).toContain("issue:ISS-1");
  });

  it("suppresses when flag is toggled off without restart", async () => {
    const { issueCreatedHandler, setConfig, calls } = makeHotReloadEnv({ notifyOnIssueCreated: true });

    await issueCreatedHandler({ issueId: "ISS-1" });
    setConfig({ notifyOnIssueCreated: false });
    await issueCreatedHandler({ issueId: "ISS-2" });

    expect(calls).toEqual(["issue:ISS-1"]);
  });
});
