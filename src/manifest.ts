import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack Notifications",
  description:
    "Push Paperclip notifications to Slack when issues are created, completed, or need approval. Receive slash commands from Slack to check status and create issues.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "agents.read",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "instance.settings.register",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
    "tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      slackTokenRef: {
        type: "string",
        title: "Slack Bot Token (secret reference)",
        description: "Reference to the Slack Bot OAuth token stored in your secret provider.",
        default: DEFAULT_CONFIG.slackTokenRef,
      },
      defaultChannelId: {
        type: "string",
        title: "Default Slack Channel ID",
        description: "Channel ID to post notifications to (e.g. C01ABC2DEF3).",
        default: DEFAULT_CONFIG.defaultChannelId,
      },
      approvalsChannelId: {
        type: "string",
        title: "Approvals Channel ID",
        description: "Dedicated channel for approval notifications (optional, falls back to default).",
        default: DEFAULT_CONFIG.approvalsChannelId,
      },
      errorsChannelId: {
        type: "string",
        title: "Errors Channel ID",
        description: "Dedicated channel for agent error notifications (optional, falls back to default).",
        default: DEFAULT_CONFIG.errorsChannelId,
      },
      pipelineChannelId: {
        type: "string",
        title: "Pipeline Channel ID",
        description: "Dedicated channel for agent lifecycle events (optional, falls back to default).",
        default: DEFAULT_CONFIG.pipelineChannelId,
      },
      notifyOnIssueCreated: {
        type: "boolean",
        title: "Notify on issue created",
        default: DEFAULT_CONFIG.notifyOnIssueCreated,
      },
      notifyOnIssueDone: {
        type: "boolean",
        title: "Notify on issue completed",
        default: DEFAULT_CONFIG.notifyOnIssueDone,
      },
      notifyOnApprovalCreated: {
        type: "boolean",
        title: "Notify on approval requested",
        default: DEFAULT_CONFIG.notifyOnApprovalCreated,
      },
      notifyOnAgentError: {
        type: "boolean",
        title: "Notify on agent error",
        default: DEFAULT_CONFIG.notifyOnAgentError,
      },
      notifyOnAgentConnected: {
        type: "boolean",
        title: "Notify on agent connected/disconnected",
        default: DEFAULT_CONFIG.notifyOnAgentConnected,
      },
      notifyOnBudgetThreshold: {
        type: "boolean",
        title: "Notify on budget threshold reached",
        default: DEFAULT_CONFIG.notifyOnBudgetThreshold,
      },
      enableDailyDigest: {
        type: "boolean",
        title: "Send daily activity digest",
        description: "Posts a summary of all agent activity, costs, and completed tasks once per day.",
        default: DEFAULT_CONFIG.enableDailyDigest,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description: "Base URL of your Paperclip instance for dashboard links.",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      escalationChatId: {
        type: "string",
        title: "Escalation Channel ID",
        description: "Dedicated channel for escalation notifications (optional, falls back to approvalsChannelId or defaultChannelId).",
        default: DEFAULT_CONFIG.escalationChatId,
      },
      escalationTimeoutMs: {
        type: "number",
        title: "Escalation Timeout (ms)",
        description: "Time in milliseconds before an unresolved escalation triggers the default action.",
        default: DEFAULT_CONFIG.escalationTimeoutMs,
      },
      escalationDefaultAction: {
        type: "string",
        title: "Escalation Default Action",
        description: "Action to take when an escalation times out: 'defer', 'dismiss', or 'auto_reply'.",
        default: DEFAULT_CONFIG.escalationDefaultAction,
      },
      escalationHoldMessage: {
        type: "string",
        title: "Escalation Hold Message",
        description: "Message sent to the customer while waiting for a human to respond.",
        default: DEFAULT_CONFIG.escalationHoldMessage,
      },
    },
    required: ["slackTokenRef", "defaultChannelId"],
  },
  jobs: [
    {
      jobKey: "daily-digest",
      displayName: "Daily Activity Digest",
      description: "Posts a summary of agent activity, costs, and completed tasks to Slack.",
      schedule: "0 9 * * *",
    },
    {
      jobKey: "check-escalation-timeouts",
      displayName: "Check Escalation Timeouts",
      description: "Checks for unresolved escalations that have exceeded the configured timeout.",
      schedule: "*/1 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.slackEvents,
      displayName: "Slack Events API",
      description: "Receives Slack Events API payloads (url_verification, event callbacks).",
    },
    {
      endpointKey: WEBHOOK_KEYS.slashCommand,
      displayName: "Slack Slash Command",
      description: "Receives /clip slash commands from Slack.",
    },
    {
      endpointKey: WEBHOOK_KEYS.interactivity,
      displayName: "Slack Interactivity",
      description: "Receives button click payloads from interactive messages (approve/reject).",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Slack Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
