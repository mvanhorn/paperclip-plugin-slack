import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { SlackBlock, SlackMessage } from "./slack-api.js";
import type { EscalationRecord } from "./types.js";

type Payload = Record<string, unknown>;

let dashboardBase = "http://localhost:3100";

export function setBaseUrl(url: string) {
  dashboardBase = url.replace(/\/+$/, "");
}

// --- Priority emoji mapping ---
const PRIORITY_EMOJI: Record<string, string> = {
  critical: ":rotating_light:",
  high: ":red_circle:",
  medium: ":large_orange_circle:",
  low: ":white_circle:",
};

const PRIORITY_KR: Record<string, string> = {
  critical: "긴급",
  high: "높음",
  medium: "보통",
  low: "낮음",
};

const STATUS_EMOJI: Record<string, string> = {
  backlog: ":inbox_tray:",
  todo: ":clipboard:",
  in_progress: ":hammer_and_wrench:",
  in_review: ":mag:",
  done: ":white_check_mark:",
  cancelled: ":no_entry_sign:",
};

const STATUS_KR: Record<string, string> = {
  backlog: "대기",
  todo: "할 일",
  in_progress: "진행 중",
  in_review: "검토 중",
  done: "완료",
  cancelled: "취소",
};

// Agent name → Slack User ID mapping
const AGENT_SLACK_UID: Record<string, string> = {
  Kuromi: "U0AQMUV1BAM",
  HelloKitty: "U0AQ4PME36F",
  MyMelody: "U0AQEQNBM4L",
  BadtzMaru: "U0AQ90MLZJS",
  Cinnamoroll: "U0AQ4R8B4Q3",
};

function slackMention(name: string): string {
  const uid = AGENT_SLACK_UID[name];
  return uid ? `<@${uid}>` : name;
}

/** Format issue identifier as clickable Slack link: <url|DGG-123> */
function issueLink(identifier: string, entityId?: string): string {
  const id = entityId ?? identifier;
  return `<${dashboardBase}/DGG/issues/${identifier}|${identifier}>`;
}

// --- Execution result extraction ---

const EXEC_RESULT_HEADERS = [
  /^##\s*실행\s*결과/m,
  /^##\s*Self-Verification/m,
  /^##\s*판단/m,
  /^##\s*Execution Result/mi,
];

/**
 * Extract "실행 결과" / "Self-Verification" / "판단" sections from markdown description.
 * Returns { summary, executionResult } where summary is the first ~300 chars before the result section,
 * and executionResult is the full extracted section(s).
 */
export function extractExecutionResult(description: string | null): {
  summary: string;
  executionResult: string | null;
} {
  if (!description) return { summary: "", executionResult: null };

  // Find the earliest matching header
  let earliestIdx = -1;
  for (const re of EXEC_RESULT_HEADERS) {
    const match = re.exec(description);
    if (match && (earliestIdx === -1 || match.index < earliestIdx)) {
      earliestIdx = match.index;
    }
  }

  if (earliestIdx === -1) {
    // No execution result section found — return truncated summary
    return { summary: description.slice(0, 300), executionResult: null };
  }

  const summary = description.slice(0, Math.min(earliestIdx, 300)).trim();
  const executionResult = description.slice(earliestIdx).trim();
  return { summary, executionResult };
}

/**
 * Format execution result as Slack blocks (mrkdwn sections, max 3000 chars per block).
 */
export function formatExecutionResultBlocks(executionResult: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  // Slack section text limit is 3000 chars
  const MAX_BLOCK_LEN = 2900;
  let remaining = executionResult;

  // Add a divider before execution results
  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: ":brain: *에이전트 실행 결과*" }],
  });

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_BLOCK_LEN);
    remaining = remaining.slice(MAX_BLOCK_LEN);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    });
  }

  return blocks;
}

function contextFooter(timestamp?: string): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    { type: "mrkdwn", text: ":paperclip: *Paperclip*" },
  ];
  if (timestamp) {
    elements.push({ type: "mrkdwn", text: `<!date^${Math.floor(new Date(timestamp).getTime() / 1000)}^{date_short_pretty} {time}|${timestamp}>` });
  }
  return { type: "context", elements };
}

function viewButton(label: string, url: string): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    url,
  };
}

// --- Block formatting helpers ---

export function formatAsBlocks(text: string, toolName?: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  if (toolName) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Tool: \`${toolName}\`` },
      ],
    });
  }

  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      const inner = trimmed.slice(3, -3).replace(/^\w*\n/, "");
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `\`\`\`${inner}\`\`\`` },
      });
    } else {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: trimmed },
      });
    }
  }

  return blocks;
}

// --- Event formatters ---

export function formatIssueCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");
  const description = p.description ? String(p.description) : null;
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;
  const goalName = p.goalName ? String(p.goalName) : null;
  const parentIdentifier = p.parentIdentifier ? String(p.parentIdentifier) : null;

  const priorityEmoji = priority ? (PRIORITY_EMOJI[priority] ?? ":red_circle:") : ":red_circle:";
  const priorityKr = priority ? (PRIORITY_KR[priority] ?? priority) : null;
  const statusKr = status ? (STATUS_KR[status] ?? status) : "";

  // Header line
  let header = `${priorityEmoji} *새 이슈: ${issueLink(identifier)}*`;
  if (parentIdentifier) header += ` (상위: ${issueLink(parentIdentifier)})`;
  header += `\n*${title}*`;

  // Description (truncated)
  if (description) {
    header += `\n${description.slice(0, 300)}`;
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: header },
      accessory: viewButton("대시보드", `${dashboardBase}/issues/${event.entityId}`),
    },
  ];

  // Fields block for metadata
  const fields: Array<{ type: string; text: string }> = [];
  fields.push({ type: "mrkdwn", text: `*담당자*\n:bust_in_silhouette: ${assigneeName ? slackMention(assigneeName) : "미할당"}` });
  if (priorityKr) fields.push({ type: "mrkdwn", text: `*우선순위*\n${priorityEmoji} ${priorityKr}` });
  if (projectName) fields.push({ type: "mrkdwn", text: `*프로젝트*\n:file_folder: ${projectName}` });
  if (goalName) fields.push({ type: "mrkdwn", text: `*목표*\n:dart: ${goalName}` });
  if (statusKr) fields.push({ type: "mrkdwn", text: `*상태*\n:clipboard: ${statusKr}` });

  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  blocks.push(contextFooter(event.occurredAt));

  return {
    text: `${priorityEmoji} 새 이슈: ${issueLink(identifier)} - ${title} → ${assigneeName ? slackMention(assigneeName) : "미할당"}`,
    blocks,
  };
}

export function formatIssueDone(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "");
  const description = p.description ? String(p.description) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;

  const { summary, executionResult } = extractExecutionResult(description);

  const lines = [`:white_check_mark: *${issueLink(identifier)} 완료*`, `*${title}*`];
  if (summary) lines.push(summary.slice(0, 300));
  const meta: string[] = [];
  if (assigneeName) meta.push(`:bust_in_silhouette: ${slackMention(assigneeName)}`);
  if (projectName) meta.push(`:file_folder: ${projectName}`);
  if (meta.length > 0) lines.push(meta.join(" · "));

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
      accessory: viewButton("대시보드", `${dashboardBase}/issues/${event.entityId}`),
    },
  ];

  // Append execution result blocks if present
  if (executionResult) {
    blocks.push(...formatExecutionResultBlocks(executionResult));
  }

  blocks.push(contextFooter(event.occurredAt));

  return {
    text: `:white_check_mark: 완료: ${issueLink(identifier)} - ${title}`,
    blocks,
  };
}

export function formatIssueStatusChanged(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "");
  const description = p.description ? String(p.description) : null;
  const status = p.status ? String(p.status) : "unknown";
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;

  const statusEmoji = STATUS_EMOJI[status] ?? ":hammer_and_wrench:";
  const statusKr = STATUS_KR[status] ?? status;

  const { summary, executionResult } = extractExecutionResult(description);

  const lines = [`${statusEmoji} *${issueLink(identifier)}* → ${statusKr}`];
  if (title) lines.push(`*${title}*`);
  if (summary) lines.push(summary.slice(0, 300));
  const meta: string[] = [];
  if (assigneeName) meta.push(`:bust_in_silhouette: ${slackMention(assigneeName)}`);
  if (projectName) meta.push(`:file_folder: ${projectName}`);
  if (meta.length > 0) lines.push(meta.join(" · "));

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
  ];

  // Append execution result blocks if present
  if (executionResult) {
    blocks.push(...formatExecutionResultBlocks(executionResult));
  }

  blocks.push(contextFooter(event.occurredAt));

  return {
    text: `${statusEmoji} ${issueLink(identifier)} → ${statusKr}: ${title}`,
    blocks,
  };
}

export function formatApprovalCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const title = String(p.title ?? "");
  const description = p.description ? String(p.description) : null;
  const agentName = p.agentName ? String(p.agentName) : null;
  const issueIds = Array.isArray(p.issueIds) ? p.issueIds : [];

  const fields: Array<{ type: string; text: string }> = [];
  if (agentName) fields.push({ type: "mrkdwn", text: `*요청 에이전트*\n:robot_face: ${slackMention(agentName)}` });
  fields.push({ type: "mrkdwn", text: `*유형*\n\`${approvalType}\`` });
  if (issueIds.length > 0) {
    fields.push({ type: "mrkdwn", text: `*관련 이슈*\n${issueIds.join(", ")}` });
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: description
          ? `:rotating_light: *승인 요청*\n${title ? `*${title}*\n` : ""}${description}`
          : `:rotating_light: *승인 요청*${title ? `\n*${title}*` : ""}`,
      },
    },
  ];

  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "승인" },
        style: "primary",
        action_id: "approval_approve",
        value: approvalId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "거부" },
        style: "danger",
        action_id: "approval_reject",
        value: approvalId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "상세 보기" },
        url: `${dashboardBase}/approvals/${approvalId}`,
        action_id: "approval_view",
      },
    ],
  });

  blocks.push(contextFooter(event.occurredAt));

  return {
    text: `:rotating_light: 승인 필요 (${approvalType}) — ${issueIds.length}건`,
    blocks,
  };
}

export function formatApprovalResolved(
  approvalId: string,
  approved: boolean,
  userId: string,
): SlackMessage {
  const action = approved ? "승인됨" : "거부됨";
  const emoji = approved ? ":white_check_mark:" : ":x:";

  return {
    text: `${action} by ${userId}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${action}* — <@${userId}>`,
        },
        accessory: viewButton("보기", `${dashboardBase}/approvals/${approvalId}`),
      },
    ],
  };
}

export function formatAgentError(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");

  return {
    text: `:warning: 에이전트 에러: ${agentName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: *에이전트 에러*\n:robot_face: ${slackMention(agentName)}\n\`\`\`${errorMessage.slice(0, 500)}\`\`\``,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatAgentConnected(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);

  return {
    text: `:white_check_mark: 에이전트 온라인: ${agentName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *에이전트 온라인*\n:robot_face: ${slackMention(agentName)} 연결됨`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatBudgetThreshold(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const spent = p.spent != null ? String(p.spent) : "?";
  const budget = p.budget != null ? String(p.budget) : "?";
  const pct = p.percentUsed != null ? String(p.percentUsed) : "?";

  return {
    text: `:chart_with_upwards_trend: 예산 알림: ${agentName} ${pct}% 사용`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:chart_with_upwards_trend: *예산 임계값 도달*\n:robot_face: ${slackMention(agentName)} — *${pct}%* 사용 ($${spent} / $${budget})`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatOnboardingMilestone(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const milestone = String(p.milestone ?? "first heartbeat");

  return {
    text: `:tada: 마일스톤: ${agentName} — ${milestone}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:tada: *마일스톤 달성*\n:robot_face: ${slackMention(agentName)} — ${milestone}`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

interface IssueItem {
  identifier: string;
  title: string;
  agentName: string;
}

export function formatDailyDigest(stats: {
  tasksCompleted: number;
  tasksCreated: number;
  agentsActive: number;
  topAgent: string;
  agentStats?: Record<string, { completed: number; inProgress: number; created: number }>;
  completedIssues?: IssueItem[];
  inProgressIssues?: IssueItem[];
  createdIssues?: IssueItem[];
}): SlackMessage {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: ":bar_chart: 팀 활동 요약" },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*:white_check_mark: 완료*\n${stats.tasksCompleted}건` },
        { type: "mrkdwn", text: `*:inbox_tray: 생성*\n${stats.tasksCreated}건` },
        { type: "mrkdwn", text: `*:robot_face: 활성 에이전트*\n${stats.agentsActive}명` },
      ],
    },
  ];

  // Per-agent breakdown
  if (stats.agentStats && Object.keys(stats.agentStats).length > 0) {
    const agentLines = Object.entries(stats.agentStats)
      .filter(([, s]) => s.completed > 0 || s.inProgress > 0 || s.created > 0)
      .map(([name, s]) => {
        const parts: string[] = [];
        if (s.completed > 0) parts.push(`✅${s.completed}`);
        if (s.inProgress > 0) parts.push(`🔧${s.inProgress}`);
        if (s.created > 0) parts.push(`📥${s.created}`);
        return `:robot_face: ${slackMention(name)} — ${parts.join(" ")}`;
      });
    if (agentLines.length > 0) {
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*에이전트별 활동*\n${agentLines.join("\n")}` },
      });
    }
  }

  // Completed issues list
  if (stats.completedIssues && stats.completedIssues.length > 0) {
    const lines = stats.completedIssues
      .map((i) => `✅ *${i.identifier}* ${i.title.slice(0, 50)} — ${slackMention(i.agentName)}`)
      .join("\n");
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*완료된 이슈*\n${lines}` },
    });
  }

  // In-progress issues list
  if (stats.inProgressIssues && stats.inProgressIssues.length > 0) {
    const lines = stats.inProgressIssues
      .map((i) => `🔧 *${i.identifier}* ${i.title.slice(0, 50)} — ${slackMention(i.agentName)}`)
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*진행 중*\n${lines}` },
    });
  }

  if (stats.topAgent) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:trophy: *MVP:* ${slackMention(stats.topAgent)}` },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: ":paperclip: *Paperclip* — 활동 요약" }],
  });

  return {
    text: `팀 활동 요약: ${stats.tasksCompleted}건 완료, ${stats.tasksCreated}건 생성`,
    blocks,
  };
}

// --- Escalation formatters ---

export function formatEscalationMessage(escalation: EscalationRecord): SlackMessage {
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `:sos: ${escalation.agentName ?? "에이전트"} 에스컬레이션` },
  });

  const fields: Array<{ type: string; text: string }> = [
    { type: "mrkdwn", text: `*사유*\n${escalation.reason}` },
  ];
  if (escalation.confidence != null) {
    fields.push({ type: "mrkdwn", text: `*확신도*\n${escalation.confidence}` });
  }
  blocks.push({ type: "section", fields });

  if (escalation.conversationHistory && escalation.conversationHistory.length > 0) {
    const lastMessages = escalation.conversationHistory.slice(-5);
    const historyText = lastMessages
      .map((msg) => `*${msg.role}:* ${msg.text}`)
      .join("\n");
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*최근 대화*\n${historyText.slice(0, 2000)}` },
      ],
    });
  }

  if (escalation.agentReasoning) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*에이전트 판단*\n${escalation.agentReasoning}`,
      },
    });
  }

  if (escalation.suggestedReply) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*제안 답변*\n> ${escalation.suggestedReply}`,
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "제안 답변 사용" },
        style: "primary",
        action_id: "escalation_use_suggested",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "직접 답변" },
        action_id: "escalation_reply",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "에이전트 오버라이드" },
        action_id: "escalation_override",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "무시" },
        style: "danger",
        action_id: "escalation_dismiss",
        value: escalation.id,
      },
    ],
  });

  return {
    text: `:sos: ${escalation.agentName ? slackMention(escalation.agentName) : "에이전트"} 에스컬레이션: ${escalation.reason}`,
    blocks,
  };
}

export function formatEscalationResolved(
  escalationId: string,
  action: string,
  userId: string,
): SlackMessage {
  const emoji = action === "dismiss" || action === "escalation_dismiss" ? ":x:" : ":white_check_mark:";
  const label = action === "escalation_use_suggested"
    ? "제안 답변 사용"
    : action === "escalation_override"
      ? "에이전트 오버라이드"
      : action === "escalation_dismiss"
        ? "무시됨"
        : "답변 완료";

  return {
    text: `에스컬레이션 ${label} — ${userId}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *에스컬레이션 ${label}* — <@${userId}>`,
        },
      },
    ],
  };
}

// --- Goal / Project / Comment / Run formatters ---

export function formatGoalCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const title = String(p.title ?? "Untitled");
  const description = p.description ? String(p.description).slice(0, 300) : "";

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:dart: *새 목표: ${title}*${description ? `\n${description}` : ""}` },
      accessory: viewButton("대시보드", `${dashboardBase}/goals/${event.entityId}`),
    },
    contextFooter(event.occurredAt),
  ];

  return { text: `:dart: 새 목표: ${title}`, blocks };
}

export function formatGoalUpdated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const title = String(p.title ?? "");
  const status = p.status ? String(p.status) : null;
  const statusEmoji = status ? (STATUS_EMOJI[status] ?? ":arrows_counterclockwise:") : ":arrows_counterclockwise:";
  const statusKr = status ? (STATUS_KR[status] ?? status) : "업데이트";

  return {
    text: `${statusEmoji} 목표 업데이트: ${title} → ${statusKr}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${statusEmoji} *목표 업데이트* → ${statusKr}\n${title}` } },
    ],
  };
}

export function formatProjectCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const title = String(p.title ?? p.name ?? "Untitled");

  return {
    text: `:file_folder: 프로젝트 생성: ${title}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `:file_folder: *프로젝트 생성:* ${title}` } },
    ],
  };
}

export function formatProjectUpdated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const title = String(p.title ?? p.name ?? "");

  return {
    text: `:file_folder: 프로젝트 업데이트: ${title}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `:file_folder: *프로젝트 업데이트:* ${title}` } },
    ],
  };
}

export function formatApprovalDecided(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const decision = String(p.decision ?? p.status ?? "decided");
  const emoji = decision === "approved" ? ":white_check_mark:" : ":x:";
  const label = decision === "approved" ? "승인" : "거부";

  return {
    text: `${emoji} 승인 ${label}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${emoji} *승인 ${label}*` } },
    ],
  };
}
