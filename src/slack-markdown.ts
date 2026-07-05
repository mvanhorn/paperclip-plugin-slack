import type { SlackMessage } from "./slack-api.js";

const SECTION_LIMIT = 2800;
export const ASK_FOLLOW_UP_ACTION_ID = "ask_follow_up";

type AskAnswerMessageInput = {
  issueId: string;
  issueLabel: string;
  body: string;
  baseUrl: string;
  agentId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
};

function absoluteUrl(baseUrl: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return new URL(href, baseUrl.replace(/\/+$/, "")).toString();
  } catch {
    return href;
  }
}

function normalizeInlineMarkdown(text: string, baseUrl: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
      return `<${absoluteUrl(baseUrl, href)}|${label}>`;
    })
    .replace(/\*\*([^*\n][^*\n]*?)\*\*/g, "*$1*")
    .replace(/__([^_\n][^_\n]*?)__/g, "*$1*")
    .replace(/(^|[\s([{])_([^_\n][^_\n]*?)_([\s.,;:!?)}\]]|$)/g, "$1_$2_$3");
}

function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function agentIconEmoji(icon?: string | null): string {
  switch (icon) {
    case "target":
      return ":dart:";
    case "brain":
      return ":brain:";
    case "mail":
      return ":email:";
    case "radar":
      return ":satellite_antenna:";
    case "code":
      return ":keyboard:";
    case "circuit-board":
      return ":electric_plug:";
    case "message-square":
      return ":speech_balloon:";
    default:
      return ":robot_face:";
  }
}

function normalizeSlackParagraph(text: string, baseUrl: string): string {
  const lines = text.split("\n");
  const normalized = lines.map((line) => {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/.test(trimmed)) {
      return `*${normalizeInlineMarkdown(trimmed.replace(/^#{1,6}\s+/, ""), baseUrl)}*`;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      return `• ${normalizeInlineMarkdown(trimmed.replace(/^[-*]\s+/, ""), baseUrl)}`;
    }
    return normalizeInlineMarkdown(line, baseUrl);
  });
  return normalized.join("\n").trim();
}

function splitSections(text: string, limit = SECTION_LIMIT): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const sections: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) sections.push(current);
    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }
    for (let idx = 0; idx < paragraph.length; idx += limit) {
      sections.push(paragraph.slice(idx, idx + limit));
    }
    current = "";
  }

  if (current) sections.push(current);
  return sections;
}

export function extractMarkdownTitle(markdown: string): { title: string | null; body: string } {
  const lines = markdown.trim().split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) return { title: null, body: "" };
  const first = lines[firstContentIndex].trim();
  const heading = first.match(/^#{1,6}\s+(.+)$/);
  if (!heading) return { title: null, body: markdown.trim() };
  const remaining = [
    ...lines.slice(0, firstContentIndex),
    ...lines.slice(firstContentIndex + 1),
  ].join("\n").trim();
  return { title: heading[1].trim(), body: remaining };
}

export function markdownToSlackMrkdwn(markdown: string, baseUrl: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .split(/\n(?=---+\s*$)/gm)
    .join("\n")
    .split("\n")
    .filter((line) => !/^---+\s*$/.test(line.trim()))
    .join("\n")
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith("```") && part.endsWith("```")) return part.trim();
      return normalizeSlackParagraph(part, baseUrl);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildAskAnswerSlackMessage(input: AskAnswerMessageInput): SlackMessage {
  const cleanBase = input.baseUrl.replace(/\/+$/, "");
  const issueUrl = `${cleanBase}/issues/${input.issueId}`;
  const extracted = extractMarkdownTitle(input.body);
  const agentName = input.agentName?.trim() || "Paperclip";
  const agentLabel = escapeSlackText(agentName);
  const agentBadge = agentIconEmoji(input.agentIcon);
  const title = extracted.title ?? `Answer from ${agentName}`;
  const body = markdownToSlackMrkdwn(extracted.body || input.body, cleanBase);
  const sections = splitSections(body);
  const followUpValue = JSON.stringify({
    issueId: input.issueId,
    issueLabel: input.issueLabel,
    agentId: input.agentId ?? undefined,
    agentName,
    agentIcon: input.agentIcon ?? undefined,
  });

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${agentBadge} *${agentLabel} answered* · <${issueUrl}|${input.issueLabel}>`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "View Issue" },
        url: issueUrl,
        action_id: "view_ask_issue_answer",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${markdownToSlackMrkdwn(title, cleanBase)}*`,
      },
    },
  ];

  if (sections.length > 0) {
    blocks.push({ type: "divider" });
    for (const section of sections.slice(0, 8)) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: section },
      });
    }
  }

  if (sections.length > 8) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: "Answer truncated for Slack. Open the issue for the full response." },
      ],
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Ask follow-up" },
        action_id: ASK_FOLLOW_UP_ACTION_ID,
        value: followUpValue,
      },
    ],
  });

  return {
    text: `Ask Mode answer: ${input.issueLabel} - ${title}`,
    blocks,
  };
}
