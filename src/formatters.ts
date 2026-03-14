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
