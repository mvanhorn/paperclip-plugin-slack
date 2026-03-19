export const PLUGIN_ID = "paperclip-plugin-slack";
export const PLUGIN_VERSION = "1.0.0";

export const WEBHOOK_KEYS = {
  slackEvents: "slack-events",
  slashCommand: "slash-command",
  interactivity: "slack-interactivity",
} as const;

export const SLOT_IDS = {
  settingsPage: "slack-settings-page",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "SlackSettingsPage",
} as const;

export const DEFAULT_CONFIG = {
  slackTokenRef: "",
  defaultChannelId: "",
  approvalsChannelId: "",
  errorsChannelId: "",
  pipelineChannelId: "",
  escalationChatId: "",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnApprovalCreated: true,
  notifyOnAgentError: true,
  notifyOnAgentConnected: true,
  notifyOnBudgetThreshold: true,
  enableDailyDigest: false,
  escalationTimeoutMs: 900000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "Your request has been escalated to a human agent. Please hold.",
  paperclipBaseUrl: "http://localhost:3100",
} as const;
