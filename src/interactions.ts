import type { Issue } from "@paperclipai/plugin-sdk";
import type { SlackMessage } from "./slack-api.js";

export const INTERACTION_ACCEPT_ACTION_ID = "interaction_accept";
export const INTERACTION_REJECT_ACTION_ID = "interaction_reject";
export const INTERACTION_ANSWER_ACTION_ID = "interaction_answer";
export const INTERACTION_ANSWER_MODAL_ACTION_ID = "interaction_answer_modal";
export const INTERACTION_CHECKBOX_MODAL_ACTION_ID = "interaction_checkbox_modal";
export const INTERACTION_CHECKBOX_CONFIRM_ACTION_ID = "interaction_checkbox_confirm";
export const INTERACTION_CHECKBOX_OPTIONS_ACTION_ID = "interaction_checkbox_options";

const INLINE_CHECKBOX_OPTION_LIMIT = 10;

type InteractionTarget = {
  type: "issue_document" | "custom";
  key: string;
  label?: string | null;
  href?: string | null;
  revisionId?: string | null;
  revisionNumber?: number | null;
};

type ConfirmationOption = {
  id: string;
  label: string;
  description?: string | null;
};

type InteractionPayload = {
  version?: 1;
  prompt?: string;
  acceptLabel?: string;
  rejectLabel?: string;
  detailsMarkdown?: string;
  allowDeclineReason?: boolean;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string;
  declineReasonPlaceholder?: string | null;
  target?: InteractionTarget | null;
  options?: ConfirmationOption[];
  defaultSelectedOptionIds?: string[];
  minSelected?: number;
  maxSelected?: number | null;
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
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
};

type AskQuestionOption = {
  id: string;
  label: string;
  description?: string | null;
};

type AskQuestion = {
  id: string;
  prompt: string;
  helpText?: string | null;
  selectionMode: "single" | "multi" | "multiple";
  required?: boolean;
  options: AskQuestionOption[];
};

type AskQuestionsPayload = {
  version: 1;
  title?: string | null;
  submitLabel?: string | null;
  questions: AskQuestion[];
};

export type AskUserQuestionsInteraction = {
  id: string;
  kind: "ask_user_questions";
  status: string;
  title?: string | null;
  summary?: string | null;
  continuationPolicy?: string | null;
  payload?: AskQuestionsPayload | null;
  result?: {
    answers?: Array<{
      questionId: string;
      optionIds: string[];
      otherText?: string | null;
    }>;
    summaryMarkdown?: string | null;
  } | null;
  createdAt?: string | null;
  resolvedAt?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
};

export type IssueThreadInteraction = RequestConfirmationInteraction | AskUserQuestionsInteraction;

type IssueSummary = Pick<Issue, "id" | "identifier" | "title" | "status" | "priority">;

export type InteractionActionValue = {
  issueId: string;
  issueIdentifier?: string;
  issueTitle?: string;
  interactionId: string;
  interactionKind?: IssueThreadInteraction["kind"];
  rejectRequiresReason?: boolean;
  rejectOpensModal?: boolean;
  rejectReasonLabel?: string;
  questionId?: string;
  optionId?: string;
  optionLabel?: string;
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
    return policy === "wake_assignee_on_accept" ? "wakes on confirm" : "wakes assignee";
  }
  return policy ? policy.replace(/_/g, " ") : "manual follow-up";
}

function statusBadge(kind: IssueThreadInteraction["kind"], status: string): string {
  const kindLabel = kind === "ask_user_questions"
    ? "QUESTION"
    : kind === "request_checkbox_confirmation"
      ? "CHECKBOX CONFIRMATION"
      : "CONFIRMATION";
  return `${kindLabel} / ${status.replace(/_/g, " ").toUpperCase()}`;
}

function createdLabel(interaction: Pick<IssueThreadInteraction, "createdAt">): string {
  if (!interaction.createdAt) return "";
  const timestamp = Date.parse(interaction.createdAt);
  if (Number.isNaN(timestamp)) return "";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function markdownBox(label: string, text: string): Record<string, unknown> {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${label}*\n\`\`\`\n${text}\n\`\`\``,
    },
  };
}

function targetText(target?: InteractionTarget | null): string {
  if (!target) return "";
  const label = target.label || target.key;
  const rev = target.revisionNumber ? ` rev ${target.revisionNumber}` : "";
  const base = `${label}${rev}`;
  return target.href ? `<${target.href}|${base}>` : base;
}

function isInteractionKind(value: unknown): value is IssueThreadInteraction["kind"] {
  return value === "request_confirmation"
    || value === "request_checkbox_confirmation"
    || value === "ask_user_questions";
}

function shouldRejectOpenModal(payload: InteractionPayload, rejectLabel: string): boolean {
  if (payload.rejectRequiresReason === true) return true;
  return /request\s+changes|changes|revise/i.test(rejectLabel);
}

function checkboxOption(option: ConfirmationOption): Record<string, unknown> {
  const result: Record<string, unknown> = {
    text: { type: "plain_text", text: truncate(option.label, 75) },
    value: option.id,
  };
  if (option.description) {
    result.description = {
      type: "plain_text",
      text: truncate(option.description, 75),
    };
  }
  return result;
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

export function isAskUserQuestionsInteraction(
  interaction: unknown,
): interaction is AskUserQuestionsInteraction {
  if (!interaction || typeof interaction !== "object") return false;
  const current = interaction as { kind?: unknown; payload?: unknown };
  if (current.kind !== "ask_user_questions") return false;
  const payload = current.payload as { questions?: unknown } | null | undefined;
  return Array.isArray(payload?.questions);
}

export function isIssueThreadInteraction(interaction: unknown): interaction is IssueThreadInteraction {
  return isRequestConfirmationInteraction(interaction) || isAskUserQuestionsInteraction(interaction);
}

export function encodeInteractionActionValue(value: InteractionActionValue): string {
  return JSON.stringify(value);
}

export function decodeInteractionActionValue(value: string): InteractionActionValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<InteractionActionValue>;
    if (!parsed.issueId || !parsed.interactionId) return null;
    const decoded: InteractionActionValue = {
      issueId: String(parsed.issueId),
      interactionId: String(parsed.interactionId),
    };
    if (parsed.issueIdentifier) decoded.issueIdentifier = String(parsed.issueIdentifier);
    if (parsed.issueTitle) decoded.issueTitle = String(parsed.issueTitle);
    if (isInteractionKind(parsed.interactionKind)) decoded.interactionKind = parsed.interactionKind;
    if (parsed.questionId) decoded.questionId = String(parsed.questionId);
    if (parsed.optionId) decoded.optionId = String(parsed.optionId);
    if (parsed.optionLabel) decoded.optionLabel = String(parsed.optionLabel);
    if (parsed.rejectRequiresReason === true) decoded.rejectRequiresReason = true;
    if (parsed.rejectOpensModal === true) decoded.rejectOpensModal = true;
    if (parsed.rejectReasonLabel) decoded.rejectReasonLabel = String(parsed.rejectReasonLabel);
    return decoded;
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
  const isCheckbox = interaction.kind === "request_checkbox_confirmation";
  const acceptLabel = truncate(payload.acceptLabel || (isCheckbox ? "Select & confirm" : "Accept"), 75);
  const rejectLabel = truncate(payload.rejectLabel || "Reject", 75);
  const target = targetText(payload.target);
  const checkboxOptions = payload.options ?? [];
  const defaultSelected = new Set(payload.defaultSelectedOptionIds ?? []);
  const shouldRenderInlineCheckboxes = isCheckbox
    && checkboxOptions.length > 0
    && checkboxOptions.length <= INLINE_CHECKBOX_OPTION_LIMIT;
  const actionValueBase = {
    issueId: issue.id,
    issueIdentifier: issue.identifier || undefined,
    issueTitle: issue.title,
    interactionId: interaction.id,
    interactionKind: interaction.kind,
  };
  const acceptActionValue = encodeInteractionActionValue(actionValueBase);
  const rejectActionValue = encodeInteractionActionValue({
    ...actionValueBase,
    rejectRequiresReason: payload.rejectRequiresReason === true,
    rejectOpensModal: shouldRejectOpenModal(payload, rejectLabel),
    rejectReasonLabel: payload.rejectReasonLabel || undefined,
  });

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: truncate(title, 150) },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${statusBadge(interaction.kind, interaction.status)}* · *${issueLabel(issue)}* · \`${issue.status}\` · ${continuationLabel(interaction.continuationPolicy)}${createdLabel(interaction) ? ` · ${createdLabel(interaction)}` : ""}`,
        },
      ],
    },
  ];

  if (summary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: summary },
    });
  }

  if (prompt) {
    blocks.push(markdownBox(isCheckbox ? "Decision" : "Question", prompt));
  }

  if (target) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `*Target:* ${target}` }],
    });
  }

  if (details) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: details },
    });
  }

  if (shouldRenderInlineCheckboxes) {
    const options = checkboxOptions.map(checkboxOption);
    const initialOptions = options.filter((option) => defaultSelected.has(String(option.value)));
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Selection*\nChoose the options to include before confirming:",
      },
    });
    blocks.push({
      type: "actions",
      block_id: "interaction_checkbox_options",
      elements: [
        {
          type: "checkboxes",
          action_id: INTERACTION_CHECKBOX_OPTIONS_ACTION_ID,
          options,
          ...(initialOptions.length ? { initial_options: initialOptions } : {}),
        },
      ],
    });
  } else if (isCheckbox && checkboxOptions.length > 0) {
    const preview = checkboxOptions.slice(0, 10).map((option) => {
      const marker = defaultSelected.has(option.id) ? "[x]" : "[ ]";
      const description = option.description ? ` - ${truncate(option.description, 120)}` : "";
      return `${marker} *${truncate(option.label, 120)}*${description}`;
    });
    const extra = checkboxOptions.length > preview.length
      ? `\n_${checkboxOptions.length - preview.length} more option(s) available in Paperclip._`
      : "";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Options*\n${preview.join("\n")}${extra}` },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: acceptLabel },
        style: "primary",
        action_id: isCheckbox
          ? shouldRenderInlineCheckboxes
            ? INTERACTION_CHECKBOX_CONFIRM_ACTION_ID
            : INTERACTION_CHECKBOX_MODAL_ACTION_ID
          : INTERACTION_ACCEPT_ACTION_ID,
        value: acceptActionValue,
      },
      {
        type: "button",
        text: { type: "plain_text", text: rejectLabel },
        action_id: INTERACTION_REJECT_ACTION_ID,
        value: rejectActionValue,
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
  const reason = typeof interaction.result?.reason === "string" && interaction.result.reason.trim()
    ? `\n*Reason:* ${truncate(interaction.result.reason.trim(), 500)}`
    : "";

  return {
    text: `${label}: ${issueLabel(issue)} - ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${label}*${by}\n*${issueLabel(issue)}* - ${truncate(title, 180)}${reason}`,
        },
        accessory: viewIssueButton(paperclipBaseUrl, issue),
      },
    ],
  };
}

export function formatAskUserQuestionsInteraction(
  issue: IssueSummary,
  interaction: AskUserQuestionsInteraction,
  paperclipBaseUrl: string,
): SlackMessage {
  const payload = interaction.payload;
  const question = payload?.questions?.[0];
  const title = payload?.title || interaction.title || "Input requested";
  const summary = interaction.summary ? truncate(interaction.summary, 1200) : "";
  const prompt = question?.prompt ? truncate(question.prompt, 700) : "";
  const helpText = question?.helpText ? truncate(question.helpText, 1000) : "";
  const canAnswerWithButtons = Boolean(
    question &&
    question.selectionMode === "single" &&
    payload?.questions.length === 1 &&
    question.options.length > 0 &&
    question.options.length <= 10,
  );

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: truncate(title, 150) },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${statusBadge(interaction.kind, interaction.status)}* · *${issueLabel(issue)}* · \`${issue.status}\` · ${continuationLabel(interaction.continuationPolicy)}${createdLabel(interaction) ? ` · ${createdLabel(interaction)}` : ""}`,
        },
      ],
    },
  ];

  if (summary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: summary },
    });
  }

  if (prompt) {
    blocks.push(markdownBox("Question", prompt));
  }

  if (helpText) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: helpText },
    });
  }

  if (canAnswerWithButtons && question) {
    blocks.push({
      type: "actions",
      elements: [
        ...question.options.map((option, index) => ({
          type: "button",
          text: { type: "plain_text", text: truncate(option.label, 75) },
          style: index === 0 ? "primary" : undefined,
          action_id: `${INTERACTION_ANSWER_ACTION_ID}:${option.id}`,
          value: encodeInteractionActionValue({
            issueId: issue.id,
            issueIdentifier: issue.identifier || undefined,
            issueTitle: issue.title,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            questionId: question.id,
            optionId: option.id,
            optionLabel: option.label,
          }),
        })),
        viewIssueButton(paperclipBaseUrl, issue),
      ],
    });
  } else {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: truncate(payload?.submitLabel || "Answer", 75) },
          style: "primary",
          action_id: INTERACTION_ANSWER_MODAL_ACTION_ID,
          value: encodeInteractionActionValue({
            issueId: issue.id,
            issueIdentifier: issue.identifier || undefined,
            issueTitle: issue.title,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
          }),
        },
        viewIssueButton(paperclipBaseUrl, issue),
      ],
    });
  }

  return {
    text: `Question requested: ${issueLabel(issue)} - ${title}`,
    blocks,
  };
}

export function formatAskUserQuestionsStatus(
  issue: Partial<IssueSummary>,
  interaction: AskUserQuestionsInteraction,
  paperclipBaseUrl: string,
  actedByUserId?: string,
  selectedLabel?: string,
): SlackMessage {
  const title = interaction.payload?.title || interaction.title || "Question";
  const answer = selectedLabel
    || interaction.result?.answers?.[0]?.optionIds?.join(", ")
    || "answered";
  const by = actedByUserId ? ` by <@${actedByUserId}>` : "";

  return {
    text: `Answered: ${issueLabel(issue)} - ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:speech_balloon: *Answered*${by}\n*${issueLabel(issue)}* - ${truncate(title, 180)}\n*Selected:* ${truncate(answer, 180)}`,
        },
        accessory: viewIssueButton(paperclipBaseUrl, issue),
      },
    ],
  };
}
