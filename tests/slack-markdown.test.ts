import { describe, expect, it } from "vitest";
import {
  ASK_FOLLOW_UP_ACTION_ID,
  buildAskAnswerSlackMessage,
  extractMarkdownTitle,
  markdownToSlackMrkdwn,
} from "../src/slack-markdown.js";

describe("Slack markdown conversion", () => {
  it("extracts the first markdown heading as a title", () => {
    const result = extractMarkdownTitle("## Re-checked against the latest\n\nBody");
    expect(result.title).toBe("Re-checked against the latest");
    expect(result.body).toBe("Body");
  });

  it("converts common markdown into Slack mrkdwn", () => {
    const result = markdownToSlackMrkdwn(
      [
        "**The latest:** [PC-344](/PC/issues/PC-344)",
        "",
        "- stores `result.reason` **structurally**",
        "- keeps comments off",
        "",
        "---",
      ].join("\n"),
      "http://paperclip.local",
    );

    expect(result).toContain("*The latest:* <http://paperclip.local/PC/issues/PC-344|PC-344>");
    expect(result).toContain("• stores `result.reason` *structurally*");
    expect(result).toContain("• keeps comments off");
    expect(result).not.toContain("**");
    expect(result).not.toContain("---");
  });

  it("builds a Slack-native Ask answer card", () => {
    const message = buildAskAnswerSlackMessage({
      issueId: "iss-1",
      issueLabel: "PC-350",
      baseUrl: "http://paperclip.local",
      agentId: "agent-1",
      agentName: "Hackathon PM",
      agentIcon: "target",
      body: [
        "## Verdict: keep disabled",
        "",
        "**Reason:** The structured `result.reason` path is sufficient.",
      ].join("\n"),
    });

    expect(message.text).toContain("PC-350");
    expect(JSON.stringify(message.blocks)).toContain(":dart:");
    expect(JSON.stringify(message.blocks)).toContain("*Hackathon PM answered*");
    expect(JSON.stringify(message.blocks)).toContain(ASK_FOLLOW_UP_ACTION_ID);
    expect(JSON.stringify(message.blocks)).toContain("Ask follow-up");
    expect(JSON.stringify(message.blocks)).toContain("agent-1");
    expect(message.blocks?.[0]).toMatchObject({
      type: "section",
      accessory: {
        type: "button",
        url: "http://paperclip.local/issues/iss-1",
      },
    });
    expect(JSON.stringify(message.blocks)).toContain("*Verdict: keep disabled*");
    expect(JSON.stringify(message.blocks)).toContain("*Reason:* The structured `result.reason` path is sufficient.");
    expect(JSON.stringify(message.blocks)).not.toContain("##");
    expect(JSON.stringify(message.blocks)).not.toContain("**");
  });

  it("uses the agent name as the fallback Ask answer title", () => {
    const message = buildAskAnswerSlackMessage({
      issueId: "iss-1",
      issueLabel: "PC-350",
      baseUrl: "http://paperclip.local",
      agentName: "Hackathon PM",
      body: "Everything looks healthy.",
    });

    expect(JSON.stringify(message.blocks)).toContain("*Hackathon PM answered*");
    expect(JSON.stringify(message.blocks)).toContain("*Answer from Hackathon PM*");
    expect(message.text).toContain("Answer from Hackathon PM");
  });
});
