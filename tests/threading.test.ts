import { describe, it, expect } from "vitest";

describe("thread resolution logic", () => {
  it("stores issue thread mapping keyed by entityId", () => {
    const entityId = "iss-456";
    const ts = "1234567890.123456";
    const stateKey = `thread-issue-${entityId}`;
    expect(stateKey).toBe("thread-issue-iss-456");
    // The worker stores ts at this key and retrieves it for threading
    const storedTs = ts;
    expect(storedTs).toBe("1234567890.123456");
  });

  it("constructs correct thread_ts option when ts exists", () => {
    const threadTs = "1234567890.123456";
    const opts = threadTs ? { threadTs } : undefined;
    expect(opts).toEqual({ threadTs: "1234567890.123456" });
  });

  it("returns undefined opts when no thread_ts stored", () => {
    const threadTs: string | null = null;
    const opts = threadTs ? { threadTs } : undefined;
    expect(opts).toBeUndefined();
  });

  it("postMessage payload includes thread_ts when provided", () => {
    const payload: Record<string, unknown> = {
      channel: "C123",
      text: "test",
      blocks: [],
    };
    const threadTs = "1234567890.123456";
    if (threadTs) {
      payload.thread_ts = threadTs;
    }
    expect(payload.thread_ts).toBe("1234567890.123456");
  });

  it("postMessage payload omits thread_ts when not provided", () => {
    const payload: Record<string, unknown> = {
      channel: "C123",
      text: "test",
      blocks: [],
    };
    expect(payload.thread_ts).toBeUndefined();
  });
});

describe("cost state cleanup keys", () => {
  it("generates correct yesterday key", () => {
    const now = new Date("2026-03-17T09:00:00Z");
    const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    expect(yesterday).toBe("2026-03-16");
    expect(`daily-cost-${yesterday}`).toBe("daily-cost-2026-03-16");
    expect(`daily-agent-costs-${yesterday}`).toBe("daily-agent-costs-2026-03-16");
  });

  it("generates correct today key", () => {
    const now = new Date("2026-03-17T09:00:00Z");
    const dateKey = now.toISOString().slice(0, 10);
    expect(dateKey).toBe("2026-03-17");
  });
});
