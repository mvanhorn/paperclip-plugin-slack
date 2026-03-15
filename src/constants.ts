export const PLUGIN_ID = "paperclip-plugin-slack";
export const PLUGIN_VERSION = "0.2.0";

export const WEBHOOK_KEYS = {
  slackEvents: "slack-events",
  slashCommand: "slash-command",
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
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnApprovalCreated: true,
  notifyOnAgentError: true,
  notifyOnAgentConnected: true,
  notifyOnBudgetThreshold: true,
  enableDailyDigest: false,
} as const;
