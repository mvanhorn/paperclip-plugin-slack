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
  let header = `${priorityEmoji} *새 이슈: ${identifier}*`;
  if (parentIdentifier) header += ` (상위: ${parentIdentifier})`;
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
  fields.push({ type: "mrkdwn", text: `*담당자*\n:bust_in_silhouette: ${assigneeName ?? "미할당"}` });
  if (priorityKr) fields.push({ type: "mrkdwn", text: `*우선순위*\n${priorityEmoji} ${priorityKr}` });
  if (projectName) fields.push({ type: "mrkdwn", text: `*프로젝트*\n:file_folder: ${projectName}` });
  if (goalName) fields.push({ type: "mrkdwn", text: `*목표*\n:dart: ${goalName}` });
  if (statusKr) fields.push({ type: "mrkdwn", text: `*상태*\n:clipboard: ${statusKr}` });

  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  blocks.push(contextFooter(event.occurredAt));

  return {
    text: `${priorityEmoji} 새 이슈: ${identifier} - ${title} → ${assigneeName ?? "미할당"}`,
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

  const lines = [`:white_check_mark: *${identifier} 완료*`, `*${title}*`];
  if (description) lines.push(description.slice(0, 150));
  const meta: string[] = [];
  if (assigneeName) meta.push(`:bust_in_silhouette: ${assigneeName}`);
  if (projectName) meta.push(`:file_folder: ${projectName}`);
  if (meta.length > 0) lines.push(meta.join(" · "));

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
      accessory: viewButton("대시보드", `${dashboardBase}/issues/${event.entityId}`),
    },
    contextFooter(event.occurredAt),
  ];

  return {
    text: `:white_check_mark: 완료: ${identifier} - ${title}`,
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

  const lines = [`${statusEmoji} *${identifier}* → ${statusKr}`];
  if (title) lines.push(`*${title}*`);
  if (description) lines.push(description.slice(0, 150));
  const meta: string[] = [];
  if (assigneeName) meta.push(`:bust_in_silhouette: ${assigneeName}`);
  if (projectName) meta.push(`:file_folder: ${projectName}`);
  if (meta.length > 0) lines.push(meta.join(" · "));

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
    contextFooter(event.occurredAt),
  ];

  return {
    text: `${statusEmoji} ${identifier} → ${statusKr}: ${title}`,
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
  if (agentName) fields.push({ type: "mrkdwn", text: `*요청 에이전트*\n:robot_face: ${agentName}` });
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
          text: `:warning: *에이전트 에러*\n:robot_face: *${agentName}*\n\`\`\`${errorMessage.slice(0, 500)}\`\`\``,
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
          text: `:white_check_mark: *에이전트 온라인*\n:robot_face: *${agentName}* 연결됨`,
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
          text: `:chart_with_upwards_trend: *예산 임계값 도달*\n:robot_face: *${agentName}* — *${pct}%* 사용 ($${spent} / $${budget})`,
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
          text: `:tada: *마일스톤 달성*\n:robot_face: *${agentName}* — ${milestone}`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatDailyDigest(stats: {
  tasksCompleted: number;
  tasksCreated: number;
  agentsActive: number;
  totalCost: string;
  topAgent: string;
}): SlackMessage {
  return {
    text: `팀 활동 요약: ${stats.tasksCompleted}건 완료, $${stats.totalCost} 사용`,
    blocks: [
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
          { type: "mrkdwn", text: `*:moneybag: 비용*\n$${stats.totalCost}` },
        ],
      },
      ...(stats.topAgent
        ? [
            {
              type: "section" as const,
              text: {
                type: "mrkdwn" as const,
                text: `:trophy: *MVP:* ${stats.topAgent}`,
              },
            },
          ]
        : []),
      { type: "divider" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: ":paperclip: *Paperclip* — 2시간 활동 요약" }],
      },
    ],
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
    text: `:sos: ${escalation.agentName ?? "에이전트"} 에스컬레이션: ${escalation.reason}`,
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
