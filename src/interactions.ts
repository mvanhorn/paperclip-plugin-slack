import type { Issue } from "@paperclipai/plugin-sdk";
import type { SlackMessage } from "./slack-api.js";

export const INTERACTION_ACCEPT_ACTION_ID = "interaction_accept";
export const INTERACTION_REJECT_ACTION_ID = "interaction_reject";

type InteractionPayload = {
  prompt?: string;
  acceptLabel?: string;
  rejectLabel?: string;
  detailsMarkdown?: string;
  allowDeclineReason?: boolean;
  rejectRequiresReason?: boolean;
};

export type RequestConfirmationInteraction = {
  id: string;
  kind: "request_confirmation" | "request_checkbox_confirmation";
  status: string;
  title?: string | null;
  summary?: string | null;
  continuationPolicy?: string | null;
  payload?: InteractionPayload | null;
  result?: Record<string, unknown> | null;
  createdAt?: string | null;
  resolvedAt?: string | null;
};

type IssueSummary = Pick<Issue, "id" | "identifier" | "title" | "status" | "priority">;

export type InteractionActionValue = {
  issueId: string;
  issueIdentifier?: string;
  issueTitle?: string;
  interactionId: string;
};

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function issueLabel(issue: Partial<IssueSummary>): string {
  return issue.identifier || issue.id || "Issue";
}

function continuationLabel(policy?: string | null): string {
  if (policy === "wake_assignee" || policy === "wake_assignee_on_accept") {
    return "wakes on confirm";
  }
  return policy ? policy.replace(/_/g, " ") : "manual follow-up";
}

function viewIssueButton(baseUrl: string, issue: Partial<IssueSummary>): Record<string, unknown> {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return {
    type: "button",
    text: { type: "plain_text", text: "View Issue" },
    url: `${cleanBase}/issues/${issue.id || issue.identifier}`,
    action_id: "interaction_view_issue",
  };
}

export function isRequestConfirmationInteraction(
  interaction: unknown,
): interaction is RequestConfirmationInteraction {
  if (!interaction || typeof interaction !== "object") return false;
  const current = interaction as { kind?: unknown };
  return current.kind === "request_confirmation" || current.kind === "request_checkbox_confirmation";
}

export function encodeInteractionActionValue(value: InteractionActionValue): string {
  return JSON.stringify(value);
}

export function decodeInteractionActionValue(value: string): InteractionActionValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<InteractionActionValue>;
    if (!parsed.issueId || !parsed.interactionId) return null;
    return {
      issueId: String(parsed.issueId),
      interactionId: String(parsed.interactionId),
      issueIdentifier: parsed.issueIdentifier ? String(parsed.issueIdentifier) : undefined,
      issueTitle: parsed.issueTitle ? String(parsed.issueTitle) : undefined,
    };
  } catch {
    return null;
  }
}

export function formatRequestConfirmationInteraction(
  issue: IssueSummary,
  interaction: RequestConfirmationInteraction,
  paperclipBaseUrl: string,
): SlackMessage {
  const payload = interaction.payload ?? {};
  const title = interaction.title || "Confirmation requested";
  const summary = interaction.summary ? truncate(interaction.summary, 1200) : "";
  const prompt = payload.prompt ? truncate(payload.prompt, 700) : "";
  const details = payload.detailsMarkdown ? truncate(payload.detailsMarkdown, 1400) : "";
  const acceptLabel = truncate(payload.acceptLabel || "Accept", 75);
  const rejectLabel = truncate(payload.rejectLabel || "Reject", 75);
  const actionValue = encodeInteractionActionValue({
    issueId: issue.id,
    issueIdentifier: issue.identifier || undefined,
    issueTitle: issue.title,
    interactionId: interaction.id,
  });

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: "Confirmation / Pending" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [`*${truncate(title, 180)}*`, summary].filter(Boolean).join("\n"),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${issueLabel(issue)}* · \`${issue.status}\` · ${continuationLabel(interaction.continuationPolicy)}`,
        },
      ],
    },
  ];

  if (prompt) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `>${prompt}` },
    });
  }

  if (details) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: details },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: acceptLabel },
        style: "primary",
        action_id: INTERACTION_ACCEPT_ACTION_ID,
        value: actionValue,
      },
      {
        type: "button",
        text: { type: "plain_text", text: rejectLabel },
        action_id: INTERACTION_REJECT_ACTION_ID,
        value: actionValue,
      },
      viewIssueButton(paperclipBaseUrl, issue),
    ],
  });

  return {
    text: `Confirmation requested: ${issueLabel(issue)} - ${title}`,
    blocks,
  };
}

export function formatRequestConfirmationStatus(
  issue: Partial<IssueSummary>,
  interaction: RequestConfirmationInteraction,
  paperclipBaseUrl: string,
  actedByUserId?: string,
): SlackMessage {
  const status = interaction.status || "resolved";
  const accepted = status === "accepted";
  const rejected = status === "rejected";
  const emoji = accepted ? ":white_check_mark:" : rejected ? ":x:" : ":information_source:";
  const label = accepted ? "Accepted" : rejected ? "Rejected" : truncate(status.replace(/_/g, " "), 60);
  const by = actedByUserId ? ` by <@${actedByUserId}>` : "";
  const title = interaction.title || "Confirmation";

  return {
    text: `${label}: ${issueLabel(issue)} - ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${label}*${by}\n*${issueLabel(issue)}* - ${truncate(title, 180)}`,
        },
        accessory: viewIssueButton(paperclipBaseUrl, issue),
      },
    ],
  };
}
