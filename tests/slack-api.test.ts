import { describe, expect, it, vi } from "vitest";
import { openModal, respondToAction } from "../src/slack-api.js";

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

  it("opens Slack modals with trigger id and view payload", async () => {
    const ctx = makeCtx(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await openModal(ctx as never, "xoxb-test", "trigger-123", {
      type: "modal",
      title: { type: "plain_text", text: "Request changes" },
      blocks: [],
    });

    expect(result).toEqual({ ok: true });
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/views.open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          trigger_id: "trigger-123",
          view: {
            type: "modal",
            title: { type: "plain_text", text: "Request changes" },
            blocks: [],
          },
        }),
      }),
    );
  });
});
