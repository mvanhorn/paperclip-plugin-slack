import { describe, expect, it } from "vitest";
import {
  INTERACTION_ACCEPT_ACTION_ID,
  INTERACTION_ANSWER_ACTION_ID,
  INTERACTION_ANSWER_MODAL_ACTION_ID,
  INTERACTION_CHECKBOX_CONFIRM_ACTION_ID,
  INTERACTION_CHECKBOX_MODAL_ACTION_ID,
  INTERACTION_CHECKBOX_OPTIONS_ACTION_ID,
  INTERACTION_REJECT_ACTION_ID,
  decodeInteractionActionValue,
  encodeInteractionActionValue,
  formatAskUserQuestionsInteraction,
  formatAskUserQuestionsStatus,
  formatRequestConfirmationInteraction,
  formatRequestConfirmationStatus,
  isAskUserQuestionsInteraction,
  isRequestConfirmationInteraction,
  type AskUserQuestionsInteraction,
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

const questionInteraction: AskUserQuestionsInteraction = {
  id: "0ad9b1a8-f075-4060-b568-792078b51201",
  kind: "ask_user_questions",
  status: "pending",
  continuationPolicy: "wake_assignee",
  title: "Inbox Ops Agent needs a decision",
  summary: "Choose how to proceed with the missing Gmail filter capability.",
  payload: {
    version: 1,
    title: "How should the Inbox Ops Agent proceed?",
    submitLabel: "Choose approach",
    questions: [
      {
        id: "approach",
        prompt: "How do you want to proceed?",
        helpText: "The connector can label and search, but cannot create persistent Gmail filters.",
        selectionMode: "single",
        required: true,
        options: [
          {
            id: "A",
            label: "Ship on connectors",
            description: "Ready now.",
          },
          {
            id: "B",
            label: "I'll provide MCP",
            description: "Keep the plugin requirement.",
          },
        ],
      },
    ],
  },
};

const checkboxInteraction: RequestConfirmationInteraction = {
  ...interaction,
  id: "37ac1069-580c-4cc5-ab4e-c4560115781f",
  kind: "request_checkbox_confirmation",
  title: "Approve inbox routes",
  summary: "Choose the routes that should be backfilled.",
  payload: {
    version: 1,
    prompt: "Which inbox routes do you approve?",
    acceptLabel: "Approve selected",
    rejectLabel: "Request changes",
    options: [
      { id: "ops", label: "Ops / banks", description: "High confidence operational mail." },
      { id: "news", label: "Auto-news", description: "Newsletters and vendor updates." },
    ],
    defaultSelectedOptionIds: ["ops"],
    minSelected: 0,
  },
};

describe("request confirmation Block Kit formatting", () => {
  it("formats a pending Paperclip confirmation with issue context and buttons", () => {
    const msg = formatRequestConfirmationInteraction(issue, interaction, "http://127.0.0.1:3100/WKP");

    expect(msg.text).toContain("WKP-259");
    const header = msg.blocks?.[0] as Record<string, unknown>;
    expect((header.text as Record<string, unknown>).text).toBe("Merge PR #173 and deploy to close WKP-259");

    const context = msg.blocks?.find((block) => (block as Record<string, unknown>).type === "context") as Record<string, unknown>;
    expect(JSON.stringify(context)).toContain("CONFIRMATION / PENDING");
    expect(JSON.stringify(context)).toContain("in_review");
    expect(JSON.stringify(context)).toContain("wakes on confirm");
    expect(JSON.stringify(msg.blocks)).toContain("Question");
    expect(JSON.stringify(msg.blocks)).toContain("Have you merged PR #173");

    const actions = msg.blocks?.find((block) => (block as Record<string, unknown>).type === "actions") as Record<string, unknown>;
    const elements = actions.elements as Array<Record<string, unknown>>;
    expect(elements[0].action_id).toBe(INTERACTION_ACCEPT_ACTION_ID);
    expect((elements[0].text as Record<string, unknown>).text).toBe("Yes, deployed");
    expect(elements[1].action_id).toBe(INTERACTION_REJECT_ACTION_ID);
    expect((elements[1].text as Record<string, unknown>).text).toBe("Not yet");
    expect(elements[2].url).toContain("/issues/66e04bdc-d563-4ba9-9a8e-90ce14a67fe7");

    const rejectValue = decodeInteractionActionValue(String(elements[1].value));
    expect(rejectValue).toMatchObject({
      issueId: issue.id,
      interactionId: interaction.id,
    });
    expect(rejectValue?.rejectRequiresReason).toBeUndefined();
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

  it("marks reject actions that require a reason", () => {
    const msg = formatRequestConfirmationInteraction(
      issue,
      {
        ...interaction,
        payload: {
          ...interaction.payload,
          rejectLabel: "Request changes",
          rejectRequiresReason: true,
          rejectReasonLabel: "What should change?",
        },
      },
      "http://127.0.0.1:3100/WKP",
    );

    const actions = msg.blocks?.find((block) => (block as Record<string, unknown>).type === "actions") as Record<string, unknown>;
    const elements = actions.elements as Array<Record<string, unknown>>;
    const rejectValue = decodeInteractionActionValue(String(elements[1].value));

    expect((elements[1].text as Record<string, unknown>).text).toBe("Request changes");
    expect(rejectValue).toMatchObject({
      rejectRequiresReason: true,
      rejectOpensModal: true,
      rejectReasonLabel: "What should change?",
    });
  });

  it("formats checkbox confirmations with option preview and modal action", () => {
    const msg = formatRequestConfirmationInteraction(issue, checkboxInteraction, "http://127.0.0.1:3100/WKP");

    expect(JSON.stringify(msg.blocks)).toContain("CHECKBOX CONFIRMATION / PENDING");
    expect(JSON.stringify(msg.blocks)).toContain("Choose the options to include before confirming");

    const checkboxBlock = msg.blocks?.find((block) =>
      (block as Record<string, unknown>).block_id === "interaction_checkbox_options"
    ) as Record<string, unknown>;
    const checkboxElement = (checkboxBlock.elements as Array<Record<string, unknown>>)[0];
    expect(checkboxElement.type).toBe("checkboxes");
    expect(checkboxElement.action_id).toBe(INTERACTION_CHECKBOX_OPTIONS_ACTION_ID);
    expect((checkboxElement.options as unknown[])).toHaveLength(2);
    expect((checkboxElement.initial_options as unknown[])).toHaveLength(1);

    const actions = msg.blocks?.filter((block) => (block as Record<string, unknown>).type === "actions").at(-1) as Record<string, unknown>;
    const elements = actions.elements as Array<Record<string, unknown>>;
    expect(elements[0].action_id).toBe(INTERACTION_CHECKBOX_CONFIRM_ACTION_ID);
    expect((elements[0].text as Record<string, unknown>).text).toBe("Approve selected");

    const rejectValue = decodeInteractionActionValue(String(elements[1].value));
    expect(rejectValue).toMatchObject({
      interactionKind: "request_checkbox_confirmation",
      rejectOpensModal: true,
    });
  });

  it("uses a modal fallback for checkbox confirmations with more than ten options", () => {
    const msg = formatRequestConfirmationInteraction(
      issue,
      {
        ...checkboxInteraction,
        payload: {
          ...checkboxInteraction.payload,
          options: Array.from({ length: 11 }, (_unused, index) => ({
            id: `option-${index + 1}`,
            label: `Option ${index + 1}`,
          })),
          defaultSelectedOptionIds: ["option-1"],
        },
      },
      "http://127.0.0.1:3100/WKP",
    );

    expect(JSON.stringify(msg.blocks)).toContain("[x] *Option 1*");
    expect(JSON.stringify(msg.blocks)).toContain("1 more option(s) available in Paperclip");
    expect(JSON.stringify(msg.blocks)).not.toContain("\"checkboxes\"");

    const actions = msg.blocks?.find((block) => (block as Record<string, unknown>).type === "actions") as Record<string, unknown>;
    const elements = actions.elements as Array<Record<string, unknown>>;
    expect(elements[0].action_id).toBe(INTERACTION_CHECKBOX_MODAL_ACTION_ID);
  });
});

describe("ask user questions Block Kit formatting", () => {
  it("formats a single-choice Paperclip question with answer buttons", () => {
    const msg = formatAskUserQuestionsInteraction(issue, questionInteraction, "http://127.0.0.1:3100/WKP");

    expect(msg.text).toContain("WKP-259");
    const header = msg.blocks?.[0] as Record<string, unknown>;
    expect((header.text as Record<string, unknown>).text).toBe("How should the Inbox Ops Agent proceed?");
    expect(JSON.stringify(msg.blocks)).toContain("QUESTION / PENDING");

    const actions = msg.blocks?.find((block) => (block as Record<string, unknown>).type === "actions") as Record<string, unknown>;
    const elements = actions.elements as Array<Record<string, unknown>>;
    expect(String(elements[0].action_id)).toBe(`${INTERACTION_ANSWER_ACTION_ID}:A`);
    expect((elements[0].text as Record<string, unknown>).text).toBe("Ship on connectors");
    expect(String(elements[1].action_id)).toBe(`${INTERACTION_ANSWER_ACTION_ID}:B`);
    expect((elements[1].text as Record<string, unknown>).text).toBe("I'll provide MCP");
    expect(elements[2].url).toContain("/issues/66e04bdc-d563-4ba9-9a8e-90ce14a67fe7");

    const decoded = decodeInteractionActionValue(String(elements[0].value));
    expect(decoded).toMatchObject({
      issueId: issue.id,
      interactionId: questionInteraction.id,
      questionId: "approach",
      optionId: "A",
      optionLabel: "Ship on connectors",
    });
  });

  it("uses an answer modal for complex questions", () => {
    const msg = formatAskUserQuestionsInteraction(
      issue,
      {
        ...questionInteraction,
        payload: {
          ...questionInteraction.payload!,
          questions: [
            questionInteraction.payload!.questions[0],
            {
              ...questionInteraction.payload!.questions[0],
              id: "route",
              prompt: "Which route?",
              selectionMode: "multi",
            },
          ],
        },
      },
      "http://127.0.0.1:3100/WKP",
    );

    const actions = msg.blocks?.find((block) => (block as Record<string, unknown>).type === "actions") as Record<string, unknown>;
    const elements = actions.elements as Array<Record<string, unknown>>;
    expect(elements[0].action_id).toBe(INTERACTION_ANSWER_MODAL_ACTION_ID);
    expect((elements[0].text as Record<string, unknown>).text).toBe("Choose approach");
  });

  it("formats an answered question status update", () => {
    const msg = formatAskUserQuestionsStatus(
      issue,
      { ...questionInteraction, status: "answered" },
      "http://127.0.0.1:3100/WKP",
      "U123",
      "Ship on connectors",
    );

    expect(msg.text).toContain("Answered");
    expect(JSON.stringify(msg.blocks)).toContain("<@U123>");
    expect(JSON.stringify(msg.blocks)).toContain("Ship on connectors");
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

  it("detects ask user question interactions", () => {
    expect(isAskUserQuestionsInteraction(questionInteraction)).toBe(true);
    expect(isAskUserQuestionsInteraction({ kind: "ask_user_questions" })).toBe(false);
  });
});
