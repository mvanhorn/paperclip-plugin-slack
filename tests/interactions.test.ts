import { describe, expect, it } from "vitest";
import {
  INTERACTION_ACCEPT_ACTION_ID,
  INTERACTION_REJECT_ACTION_ID,
  decodeInteractionActionValue,
  encodeInteractionActionValue,
  formatRequestConfirmationInteraction,
  formatRequestConfirmationStatus,
  isRequestConfirmationInteraction,
  type RequestConfirmationInteraction,
} from "../src/interactions.js";
import type { Issue } from "@paperclipai/plugin-sdk";

const issue = {
  id: "66e04bdc-d563-4ba9-9a8e-90ce14a67fe7",
  identifier: "WKP-259",
  title: "site-manager-go authz incomplete",
  status: "in_review",
  priority: "high",
} as Issue;

const interaction: RequestConfirmationInteraction = {
  id: "6ff8b447-cfc8-499f-ad6c-fae339d0ea1b",
  kind: "request_confirmation",
  status: "pending",
  continuationPolicy: "wake_assignee_on_accept",
  title: "Merge PR #173 and deploy to close WKP-259",
  summary: "All audit findings addressed. Merge PR #173, build + deploy, then confirm.",
  payload: {
    prompt: "Have you merged PR #173 to main and completed the kubectl rollout?",
    acceptLabel: "Yes, deployed",
    rejectLabel: "Not yet",
  },
};

describe("request confirmation Block Kit formatting", () => {
  it("formats a pending Paperclip confirmation with issue context and buttons", () => {
    const msg = formatRequestConfirmationInteraction(issue, interaction, "http://127.0.0.1:3100/WKP");

    expect(msg.text).toContain("WKP-259");
    const header = msg.blocks?.[0] as Record<string, unknown>;
    expect((header.text as Record<string, unknown>).text).toBe("Confirmation / Pending");

    const context = msg.blocks?.find((block) => (block as Record<string, unknown>).type === "context") as Record<string, unknown>;
    expect(JSON.stringify(context)).toContain("in_review");
    expect(JSON.stringify(context)).toContain("wakes on confirm");

    const actions = msg.blocks?.find((block) => (block as Record<string, unknown>).type === "actions") as Record<string, unknown>;
    const elements = actions.elements as Array<Record<string, unknown>>;
    expect(elements[0].action_id).toBe(INTERACTION_ACCEPT_ACTION_ID);
    expect((elements[0].text as Record<string, unknown>).text).toBe("Yes, deployed");
    expect(elements[1].action_id).toBe(INTERACTION_REJECT_ACTION_ID);
    expect((elements[1].text as Record<string, unknown>).text).toBe("Not yet");
    expect(elements[2].url).toContain("/issues/66e04bdc-d563-4ba9-9a8e-90ce14a67fe7");
  });

  it("formats a resolved interaction status update", () => {
    const msg = formatRequestConfirmationStatus(
      issue,
      { ...interaction, status: "accepted" },
      "http://127.0.0.1:3100/WKP",
      "U123",
    );

    expect(msg.text).toContain("Accepted");
    expect(JSON.stringify(msg.blocks)).toContain("<@U123>");
  });
});

describe("request confirmation action values", () => {
  it("round-trips compact action payloads", () => {
    const value = encodeInteractionActionValue({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      interactionId: interaction.id,
    });

    expect(decodeInteractionActionValue(value)).toEqual({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      interactionId: interaction.id,
    });
  });

  it("rejects invalid action payloads", () => {
    expect(decodeInteractionActionValue("not-json")).toBeNull();
    expect(decodeInteractionActionValue(JSON.stringify({ issueId: issue.id }))).toBeNull();
  });

  it("detects request confirmation interactions only", () => {
    expect(isRequestConfirmationInteraction(interaction)).toBe(true);
    expect(isRequestConfirmationInteraction({ kind: "approval" })).toBe(false);
  });
});
