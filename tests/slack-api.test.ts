import { describe, expect, it, vi } from "vitest";
import { respondToAction } from "../src/slack-api.js";

function makeCtx(response: Response) {
  return {
    http: {
      fetch: vi.fn().mockResolvedValue(response),
    },
    logger: {
      warn: vi.fn(),
    },
  };
}

describe("Slack API helpers", () => {
  it("treats plain-text Slack response_url success as ok", async () => {
    const ctx = makeCtx(new Response("ok", { status: 200 }));

    const result = await respondToAction(ctx as never, "xoxb-test", "https://hooks.slack.test/action", {
      text: "Resolved",
    });

    expect(result).toEqual({ ok: true });
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });
});
