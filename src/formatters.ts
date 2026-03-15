import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { SlackMessage } from "./slack-api.js";

type Payload = Record<string, unknown>;

export function formatIssueCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "Untitled");

  return {
    text: `New issue: ${identifier} - ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*New issue created*\n*${identifier}* ${title}`,
        },
      },
    ],
  };
}

export function formatIssueDone(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);

  return {
    text: `Issue done: ${identifier}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Issue completed*\n*${identifier}* is now done.`,
        },
      },
    ],
  };
}

export function formatApprovalCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const approvalType = String(p.type ?? "unknown");
  const issueIds = Array.isArray(p.issueIds) ? p.issueIds : [];

  return {
    text: `Approval needed (${approvalType}) for ${issueIds.length} issue(s)`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Approval requested*\nType: ${approvalType}\nIssues: ${issueIds.length}`,
        },
      },
    ],
  };
}

export function formatAgentError(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "Unknown error");

  return {
    text: `Agent error: ${agentName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Agent error* :warning:\n*${agentName}* encountered an error:\n\`\`\`${errorMessage.slice(0, 500)}\`\`\``,
        },
      },
    ],
  };
}

export function formatAgentConnected(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);

  return {
    text: `Agent online: ${agentName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Agent online* :white_check_mark:\n*${agentName}* is now connected and ready.`,
        },
      },
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
    text: `Budget alert: ${agentName} at ${pct}%`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Budget threshold reached* :money_with_wings:\n*${agentName}* has used *${pct}%* of budget ($${spent} / $${budget})`,
        },
      },
    ],
  };
}

export function formatOnboardingMilestone(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const milestone = String(p.milestone ?? "first heartbeat");

  return {
    text: `Milestone: ${agentName} - ${milestone}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Onboarding milestone* :tada:\n*${agentName}* achieved: ${milestone}`,
        },
      },
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
    text: `Daily digest: ${stats.tasksCompleted} tasks completed, $${stats.totalCost} spent`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Daily Activity Digest* :clipboard:`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Tasks completed*\n${stats.tasksCompleted}` },
          { type: "mrkdwn", text: `*Tasks created*\n${stats.tasksCreated}` },
          { type: "mrkdwn", text: `*Active agents*\n${stats.agentsActive}` },
          { type: "mrkdwn", text: `*Total cost*\n$${stats.totalCost}` },
        ],
      },
      ...(stats.topAgent
        ? [
            {
              type: "section" as const,
              text: {
                type: "mrkdwn" as const,
                text: `*Top performer:* ${stats.topAgent}`,
              },
            },
          ]
        : []),
    ],
  };
}
