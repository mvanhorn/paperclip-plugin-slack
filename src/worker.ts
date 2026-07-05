import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginWebhookInput,
  type PluginHealthDiagnostics,
  type Issue,
} from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import { postMessage, updateMessage, respondToAction, respondEphemeral, openModal } from "./slack-api.js";
import type { SlackMessage } from "./slack-api.js";
import type { SlackConfig, EscalationRecord, CommandDefinition, SessionEntry } from "./types.js";
import { SlackAdapter } from "./adapter.js";
import { SlackSocketModeClient } from "./socket-mode.js";
import { createSocketModeHandlers, dispatchSlackWebhook } from "./slack-transport.js";
import { ASK_FOLLOW_UP_ACTION_ID, buildAskAnswerSlackMessage } from "./slack-markdown.js";
import {
  spawnAgent,
  closeAgent,
  routeMessageToAgent,
  handleAgentOutput,
  handleHandoffAction,
  handleDiscussionAction,
  handleAcpSlashCommand,
  startDiscussion,
  buildHandoffBlocks,
} from "./acp-bridge.js";
import {
  setBaseUrl,
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatApprovalResolved,
  formatAgentError,
  formatAgentConnected,
  formatBudgetThreshold,
  formatOnboardingMilestone,
  formatDailyDigest,
  formatEscalationMessage,
  formatEscalationResolved,
} from "./formatters.js";
import { processMediaFile, isMediaFile } from "./media-pipeline.js";
import {
  registerCommand,
  handleCommandsSlash,
  tryCustomCommand,
  parseCommand,
} from "./custom-commands.js";
import {
  registerWatch,
  removeWatch,
  listWatches,
  checkWatches,
  BUILTIN_WATCH_TEMPLATES,
} from "./proactive-suggestions.js";
import {
  INTERACTION_ACCEPT_ACTION_ID,
  INTERACTION_ANSWER_ACTION_ID,
  INTERACTION_ANSWER_MODAL_ACTION_ID,
  INTERACTION_CHECKBOX_CONFIRM_ACTION_ID,
  INTERACTION_CHECKBOX_MODAL_ACTION_ID,
  INTERACTION_CHECKBOX_OPTIONS_ACTION_ID,
  INTERACTION_REJECT_ACTION_ID,
  decodeInteractionActionValue,
  formatAskUserQuestionsInteraction,
  formatAskUserQuestionsStatus,
  formatRequestConfirmationInteraction,
  formatRequestConfirmationStatus,
  isAskUserQuestionsInteraction,
  isIssueThreadInteraction,
  isRequestConfirmationInteraction,
  type AskUserQuestionsInteraction,
  type InteractionActionValue,
  type IssueThreadInteraction,
  type RequestConfirmationInteraction,
} from "./interactions.js";

let pluginCtx: PluginContext;
let pluginToken: string;
let pluginConfig: SlackConfig;
let slackAdapter: SlackAdapter;
let socketModeClient: SlackSocketModeClient | null = null;
let warnedMissingPaperclipApiKey = false;
let cachedLocalEnv: Record<string, string> | null = null;
const notificationDedupeInFlight = new Set<string>();

const REJECT_CONFIRMATION_MODAL_CALLBACK_ID = "paperclip_interaction_reject";
const ANSWER_QUESTIONS_MODAL_CALLBACK_ID = "paperclip_interaction_answer";
const CHECKBOX_CONFIRMATION_MODAL_CALLBACK_ID = "paperclip_interaction_checkbox";
const ASK_FOLLOW_UP_MODAL_CALLBACK_ID = "paperclip_ask_follow_up";
const REJECT_REASON_BLOCK_ID = "reject_reason";
const REJECT_REASON_ACTION_ID = "reason";
const ASK_FOLLOW_UP_BLOCK_ID = "ask_follow_up";
const ASK_FOLLOW_UP_INPUT_ACTION_ID = "follow_up";
const ASK_QUESTION_ACTION_ID = "answer";
const CHECKBOX_OPTIONS_BLOCK_ID = "checkbox_options";

// --- Slack signature verification ---

let slackSigningSecret: string | null = null;

function verifySlackSignature(
  headers: Record<string, string | string[]>,
  rawBody: string,
): boolean {
  if (!slackSigningSecret) return true; // skip if not configured

  const timestamp = String(
    headers["x-slack-request-timestamp"] ??
    headers["X-Slack-Request-Timestamp"] ?? ""
  );
  const signature = String(
    headers["x-slack-signature"] ??
    headers["X-Slack-Signature"] ?? ""
  );

  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", slackSigningSecret)
    .update(baseString)
    .digest("hex");
  const expected = `v0=${hmac}`;

  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// --- Helpers ---

async function resolveChannel(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.slackChannel,
  });
  return (override as string) ?? fallback ?? null;
}

function parseSlashCommand(rawBody: string): {
  command: string;
  text: string;
  responseUrl: string;
  userId: string;
  channelId: string;
  threadTs: string;
} {
  const params = new URLSearchParams(rawBody);
  return {
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
    responseUrl: params.get("response_url") ?? "",
    userId: params.get("user_id") ?? "",
    channelId: params.get("channel_id") ?? "",
    threadTs: params.get("thread_ts") ?? "",
  };
}

function statusBadge(status: string): string {
  const badges: Record<string, string> = {
    active: ":large_green_circle:",
    running: ":large_green_circle:",
    idle: ":white_circle:",
    paused: ":double_vertical_bar:",
    error: ":red_circle:",
    pending_approval: ":hourglass:",
    terminated: ":black_circle:",
  };
  return badges[status] ?? ":white_circle:";
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readLocalEnvValue(name: string): string {
  if (!cachedLocalEnv) {
    cachedLocalEnv = {};
    try {
      const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if (
          (value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        cachedLocalEnv[key] = value;
      }
    } catch {
      // Optional local fallback only.
    }
  }
  return cachedLocalEnv[name] ?? "";
}

function interactionStateFilePath(): string {
  const dir = process.env.PAPERCLIP_SLACK_STATE_DIR?.trim() || join(homedir(), ".paperclip");
  return join(dir, "paperclip-plugin-slack-interactions.json");
}

function askThreadStateFilePath(): string {
  const dir = process.env.PAPERCLIP_SLACK_STATE_DIR?.trim() || join(homedir(), ".paperclip");
  return join(dir, "paperclip-plugin-slack-ask-threads.json");
}

function askCommentStateFilePath(): string {
  const dir = process.env.PAPERCLIP_SLACK_STATE_DIR?.trim() || join(homedir(), ".paperclip");
  return join(dir, "paperclip-plugin-slack-ask-comments.json");
}

function readInteractionSlackMessage(interactionId: string): InteractionSlackMessageState | null {
  try {
    const text = readFileSync(interactionStateFilePath(), "utf8");
    const store = JSON.parse(text) as Record<string, unknown>;
    const value = store[interactionId];
    if (!value || typeof value !== "object") return null;
    const current = value as Record<string, unknown>;
    if (typeof current.channelId !== "string" || typeof current.ts !== "string") return null;
    return {
      channelId: current.channelId,
      ts: current.ts,
      status: typeof current.status === "string" ? current.status : "",
    };
  } catch {
    return null;
  }
}

function writeInteractionSlackMessage(interactionId: string, state: InteractionSlackMessageState): void {
  const path = interactionStateFilePath();
  let store: Record<string, unknown> = {};
  try {
    store = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    store = {};
  }
  store[interactionId] = state;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function readJsonStateFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonStateFile(path: string, store: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function coerceAskSlackThread(value: unknown): AskSlackThreadState | null {
  if (!value || typeof value !== "object") return null;
  const current = value as Partial<AskSlackThreadState>;
  if (!current.channelId || !current.issueId) return null;
  return {
    channelId: String(current.channelId),
    threadTs: current.threadTs ? String(current.threadTs) : undefined,
    issueId: String(current.issueId),
    issueIdentifier: current.issueIdentifier ? String(current.issueIdentifier) : undefined,
    agentId: current.agentId ? String(current.agentId) : undefined,
    agentName: current.agentName ? String(current.agentName) : undefined,
    agentIcon: current.agentIcon ? String(current.agentIcon) : undefined,
    question: current.question ? String(current.question) : undefined,
    createdAt: current.createdAt ? String(current.createdAt) : new Date().toISOString(),
  };
}

function readAskSlackThreadLocal(issueId: string): AskSlackThreadState | null {
  return coerceAskSlackThread(readJsonStateFile(askThreadStateFilePath())[issueId]);
}

function writeAskSlackThreadLocal(state: AskSlackThreadState): void {
  const path = askThreadStateFilePath();
  const store = readJsonStateFile(path);
  store[state.issueId] = state;
  if (state.issueIdentifier) store[state.issueIdentifier] = state;
  writeJsonStateFile(path, store);
}

function readAskSlackCommentLocal(commentId: string): boolean {
  return Boolean(readJsonStateFile(askCommentStateFilePath())[commentId]);
}

function writeAskSlackCommentLocal(commentId: string, state: Record<string, unknown>): void {
  const path = askCommentStateFilePath();
  const store = readJsonStateFile(path);
  store[commentId] = state;
  writeJsonStateFile(path, store);
}

async function readAskSlackThread(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<AskSlackThreadState | null> {
  const local = readAskSlackThreadLocal(issueId);
  if (local) return local;

  try {
    return coerceAskSlackThread(await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: STATE_KEYS.askSlackThread(issueId),
    }));
  } catch (err) {
    ctx.logger.warn("Unable to read Ask Slack thread state", {
      issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function writeAskSlackThread(
  ctx: PluginContext,
  companyId: string,
  state: AskSlackThreadState,
): Promise<void> {
  writeAskSlackThreadLocal(state);
  try {
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.askSlackThread(state.issueId) },
      state,
    );
  } catch (err) {
    ctx.logger.warn("Unable to persist Ask Slack thread state to Paperclip state", {
      issueId: state.issueId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Slash command routing ---

async function handleSlashCommand(ctx: PluginContext, rawBody: string): Promise<void> {
  const { text, responseUrl, channelId, threadTs } = parseSlashCommand(rawBody);
  const parts = text.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";
  const arg = parts[1]?.toLowerCase() ?? "";

  try {
    const companyId = await getDefaultCompanyId(ctx);
    switch (subcommand) {
      case "status":
        await handleStatusCommand(ctx, companyId, responseUrl);
        break;
      case "help":
      case "":
        await handleHelpCommand(ctx, responseUrl);
        break;
      case "agents":
        await handleAgentsCommand(ctx, companyId, responseUrl);
        break;
      case "issues":
        await handleIssuesCommand(ctx, companyId, responseUrl, arg);
        break;
      case "approve":
        await handleApproveCommand(ctx, responseUrl, arg);
        break;
      case "ask":
        await handleAskCommand(ctx, companyId, responseUrl, channelId, threadTs, parts.slice(1));
        break;
      case "acp": {
        const acpText = parts.slice(1).join(" ");
        await handleAcpSlashCommand(ctx, pluginToken, {
          channel: channelId,
          threadTs,
          text: acpText,
          companyId,
        });
        break;
      }
      case "commands":
        await handleCommandsSlash(ctx, companyId, responseUrl);
        break;
      case "watches": {
        const watches = await listWatches(ctx, companyId);
        if (watches.length === 0) {
          await respondEphemeral(ctx, responseUrl, {
            text: "No active watches. Use the `register_watch` tool to add watches.",
          });
        } else {
          const lines = watches.map((w) =>
            `:bell: \`${w.eventPattern}\` -> *${w.agentId}* (triggered ${w.triggerCount}x)`
          );
          await respondEphemeral(ctx, responseUrl, {
            text: `${watches.length} active watch(es)`,
            blocks: [
              {
                type: "header",
                text: { type: "plain_text", text: `Active Watches (${watches.length})` },
              },
              {
                type: "section",
                text: { type: "mrkdwn", text: lines.join("\n") },
              },
            ],
          });
        }
        break;
      }
      default:
        await respondEphemeral(ctx, responseUrl, {
          text: `Unknown command: \`${subcommand}\`. Use \`/clip help\` to see available commands.`,
        });
    }
    await writeMetricBestEffort(ctx, "slack.commands.handled", 1, { command_name: subcommand || "help" });
  } catch (err) {
    ctx.logger.warn("Slash command failed", {
      subcommand,
      error: err instanceof Error ? err.message : String(err),
    });
    if (responseUrl) {
      await respondEphemeral(ctx, responseUrl, {
        text: subcommand === "ask" && err instanceof Error
          ? `Ask command failed: ${err.message}`
          : "Something went wrong processing your command. Please try again.",
      });
    }
  }
}

async function handleStatusCommand(ctx: PluginContext, companyId: string, responseUrl: string): Promise<void> {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });
  const activeAgents = agents.filter((a) => a.status === "active" || a.status === "running");
  const recentDone = await ctx.issues.list({ companyId, status: "done", limit: 5, offset: 0 });

  const agentSummary = activeAgents.length > 0
    ? activeAgents.map((a) => `${statusBadge(a.status)} ${a.name}`).join("\n")
    : "_No active agents_";

  const issueSummary = recentDone.length > 0
    ? recentDone.map((i) => `:white_check_mark: ${i.title}`).join("\n")
    : "_No recent completions_";

  await respondEphemeral(ctx, responseUrl, {
    text: `Status: ${activeAgents.length} active agents, ${recentDone.length} recent completions`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Paperclip Status" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Active Agents (${activeAgents.length})*\n${agentSummary}` },
          { type: "mrkdwn", text: `*Recent Completions*\n${issueSummary}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Dashboard" },
            url: pluginConfig.paperclipBaseUrl,
            action_id: "view_dashboard",
          },
        ],
      },
    ],
  });
}

async function handleHelpCommand(ctx: PluginContext, responseUrl: string): Promise<void> {
  await respondEphemeral(ctx, responseUrl, {
    text: "Available /clip commands",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Paperclip Slash Commands" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            "`/clip status` - Show active agents and recent completions",
            "`/clip agents` - List all agents with status badges",
            "`/clip issues [open|done]` - List issues filtered by status",
            "`/clip approve <id>` - Approve a pending approval",
            "`/clip ask <agent> <question>` - Ask an agent a Paperclip Ask Mode question",
            "`/clip ask --issue <issue> <agent> [question]` - Convert/use an existing issue as Ask Mode",
            "`/clip acp spawn <agent> [display]` - Add an agent to this thread",
            "`/clip acp status` - Show all agents in this thread",
            "`/clip acp close [name]` - Close a specific agent (or most recent)",
            "`/clip commands` - List registered custom commands",
            "`/clip watches` - List active event watches",
            "`/clip help` - Show this help message",
          ].join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `<${pluginConfig.paperclipBaseUrl}|Open Paperclip Dashboard>` },
        ],
      },
    ],
  });
}

async function handleAgentsCommand(ctx: PluginContext, companyId: string, responseUrl: string): Promise<void> {
  const agents = await ctx.agents.list({ companyId, limit: 100, offset: 0 });

  if (agents.length === 0) {
    await respondEphemeral(ctx, responseUrl, { text: "No agents found." });
    return;
  }

  const lines = agents.map((a) => `${statusBadge(a.status)} *${a.name}* - \`${a.status}\``);

  await respondEphemeral(ctx, responseUrl, {
    text: `${agents.length} agents`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Agents (${agents.length})` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

async function handleIssuesCommand(ctx: PluginContext, companyId: string, responseUrl: string, filter: string): Promise<void> {
  const status = filter === "done" ? "done" as const : filter === "open" ? "todo" as const : undefined;
  const issues = await ctx.issues.list({ companyId, status, limit: 10, offset: 0 });

  if (issues.length === 0) {
    await respondEphemeral(ctx, responseUrl, { text: `No ${status ?? ""} issues found.` });
    return;
  }

  const lines = issues.map((i) => {
    const badge = i.status === "done" ? ":white_check_mark:" : ":blue_book:";
    return `${badge} *${i.title}* - \`${i.status}\``;
  });

  await respondEphemeral(ctx, responseUrl, {
    text: `${issues.length} issues`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Issues${status ? ` (${status})` : ""} - showing ${issues.length}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  });
}

async function handleApproveCommand(ctx: PluginContext, responseUrl: string, approvalId: string): Promise<void> {
  if (!approvalId) {
    await respondEphemeral(ctx, responseUrl, { text: "Usage: `/clip approve <approval-id>`" });
    return;
  }

  try {
    await ctx.http.fetch(
      `${pluginConfig.paperclipBaseUrl}/api/approvals/${approvalId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedByUserId: "slack:command" }),
      },
    );
    await respondEphemeral(ctx, responseUrl, { text: `:white_check_mark: Approval \`${approvalId}\` approved.` });
    await ctx.metrics.write("slack.approvals.decided", 1, { decision: "approve" });
  } catch (err) {
    ctx.logger.warn("Approve command failed", { approvalId, err });
    await respondEphemeral(ctx, responseUrl, { text: `:x: Failed to approve \`${approvalId}\`. Check the ID and try again.` });
  }
}

function normalizeAgentLookup(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/[\s_]+/g, "-");
}

function askIssueTitle(question: string): string {
  const clean = question.trim().replace(/\s+/g, " ");
  return clean.length <= 90 ? `Ask: ${clean}` : `Ask: ${clean.slice(0, 87)}...`;
}

async function paperclipApiError(label: string, response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const clean = text.replace(/\s+/g, " ").trim();
  return clean
    ? `${label} failed with ${response.status}: ${clean.slice(0, 240)}`
    : `${label} failed with ${response.status}`;
}

async function writeMetricBestEffort(
  ctx: PluginContext,
  name: string,
  value: number,
  labels?: Record<string, string>,
): Promise<void> {
  try {
    await ctx.metrics.write(name, value, labels);
  } catch (err) {
    ctx.logger.warn("Unable to write metric", {
      metric: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type AskCommandArgs = {
  issueRef?: string;
  agentRef: string;
  question: string;
};

type AgentLookupSummary = {
  id: string;
  name: string;
  urlKey: string | null;
  icon: string | null;
};

function parseAskCommandArgs(args: string[]): AskCommandArgs | null {
  const parts = [...args];
  let issueRef: string | undefined;
  if (parts[0] === "--issue") {
    issueRef = parts[1];
    parts.splice(0, 2);
  } else if (parts[0]?.startsWith("--issue=")) {
    issueRef = parts[0].slice("--issue=".length);
    parts.splice(0, 1);
  }

  const agentRef = parts[0] ?? "";
  const question = parts.slice(1).join(" ").trim();
  if (!agentRef) return null;
  if (!issueRef && !question) return null;
  return { issueRef, agentRef, question };
}

async function fetchIssueByReference(
  ctx: PluginContext,
  config: SlackConfig,
  issueRef: string,
): Promise<(Issue & { workMode?: string | null }) | null> {
  const response = await fetchPaperclipApi(
    ctx,
    config,
    `/api/issues/${encodeURIComponent(issueRef)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await paperclipApiError("Paperclip issue fetch", response));
  return await response.json() as Issue & { workMode?: string | null };
}

async function patchIssueAskMode(
  ctx: PluginContext,
  config: SlackConfig,
  issueId: string,
  patch: Record<string, unknown>,
): Promise<Issue & { workMode?: string | null }> {
  const response = await fetchPaperclipApi(
    ctx,
    config,
    `/api/issues/${encodeURIComponent(issueId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) throw new Error(await paperclipApiError("Paperclip issue update", response));
  return await response.json() as Issue & { workMode?: string | null };
}

function normalizeAgentListResponse(value: unknown): AgentLookupSummary[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { agents?: unknown }).agents)
      ? (value as { agents: unknown[] }).agents
      : [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const current = row as Record<string, unknown>;
      if (typeof current.id !== "string" || typeof current.name !== "string") return null;
      return {
        id: current.id,
        name: current.name,
        urlKey: typeof current.urlKey === "string" ? current.urlKey : null,
        icon: typeof current.icon === "string" ? current.icon : null,
      };
    })
    .filter((row): row is AgentLookupSummary => row !== null);
}

async function listAgentsForAsk(
  ctx: PluginContext,
  config: SlackConfig,
  companyId: string,
): Promise<AgentLookupSummary[]> {
  const response = await fetchPaperclipApi(
    ctx,
    config,
    `/api/companies/${encodeURIComponent(companyId)}/agents`,
  );
  if (!response.ok) throw new Error(await paperclipApiError("Paperclip agents list", response));
  return normalizeAgentListResponse(await response.json());
}

type IssueCommentResponse = {
  id: string;
  issueId: string;
  authorAgentId?: string | null;
  authorAgent?: {
    id?: string | null;
    name?: string | null;
    urlKey?: string | null;
    icon?: string | null;
  } | null;
  agentName?: string | null;
  agentIcon?: string | null;
  body: string;
  createdAt?: string;
};

type AskAnswerAgentSummary = {
  id?: string;
  name?: string;
  icon?: string | null;
};

async function fetchIssueComment(
  ctx: PluginContext,
  config: SlackConfig,
  issueId: string,
  commentId: string,
): Promise<IssueCommentResponse | null> {
  const response = await fetchPaperclipApi(
    ctx,
    config,
    `/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await paperclipApiError("Paperclip issue comment fetch", response));
  return await response.json() as IssueCommentResponse;
}

async function resolveAskAnswerAgent(
  ctx: PluginContext,
  config: SlackConfig,
  companyId: string,
  comment: IssueCommentResponse,
  state: AskSlackThreadState,
): Promise<AskAnswerAgentSummary> {
  const directName = comment.authorAgent?.name?.trim() || comment.agentName?.trim() || "";
  const directIcon = comment.authorAgent?.icon || comment.agentIcon || null;
  if (directName) {
    return {
      id: comment.authorAgentId ?? comment.authorAgent?.id ?? state.agentId,
      name: directName,
      icon: directIcon || state.agentIcon,
    };
  }

  if (state.agentId && comment.authorAgentId && state.agentId === comment.authorAgentId && state.agentName) {
    return { id: state.agentId, name: state.agentName, icon: state.agentIcon };
  }

  if (!comment.authorAgentId) return { id: state.agentId, name: state.agentName, icon: state.agentIcon };

  try {
    const agents = await listAgentsForAsk(ctx, config, companyId);
    const agent = agents.find((candidate) => candidate.id === comment.authorAgentId);
    return {
      id: comment.authorAgentId,
      name: agent?.name || state.agentName,
      icon: agent?.icon || state.agentIcon,
    };
  } catch (err) {
    ctx.logger.warn("Unable to resolve Ask answer agent name", {
      agentId: comment.authorAgentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { id: comment.authorAgentId, name: state.agentName, icon: state.agentIcon };
  }
}

function truncateSlackMarkdown(text: string, limit = 2800): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 20))}\n\n...truncated`;
}

async function maybeMirrorAskAnswerToSlack(ctx: PluginContext, event: PluginEvent): Promise<void> {
  if (event.eventType !== "issue.comment.created" || !event.entityId) return;

  const state = await readAskSlackThread(ctx, event.companyId, event.entityId);
  if (!state) return;

  const payload = event.payload as Record<string, unknown>;
  const commentId = typeof payload.commentId === "string" ? payload.commentId : "";
  if (!commentId) return;

  if (readAskSlackCommentLocal(commentId)) return;

  const comment = await fetchIssueComment(ctx, pluginConfig, event.entityId, commentId);
  if (!comment?.authorAgentId || !comment.body.trim()) return;

  const agent = await resolveAskAnswerAgent(ctx, pluginConfig, event.companyId, comment, state);
  const issueLabel = state.issueIdentifier || state.issueId;
  const message = buildAskAnswerSlackMessage({
    issueId: state.issueId,
    issueLabel,
    body: comment.body.trim(),
    baseUrl: pluginConfig.paperclipBaseUrl,
    agentId: agent.id,
    agentName: agent.name,
    agentIcon: agent.icon,
  });

  const result = await postMessage(ctx, pluginToken, state.channelId, message, {
    threadTs: state.threadTs,
  });
  if (result.ok) {
    const postedState = { createdAt: new Date().toISOString(), channelId: state.channelId, ts: result.ts ?? null };
    writeAskSlackCommentLocal(commentId, postedState);
    try {
      await ctx.state.set(
        { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.askSlackComment(commentId) },
        postedState,
      );
    } catch (err) {
      ctx.logger.warn("Unable to persist Ask Slack comment dedupe state", {
        commentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await writeMetricBestEffort(ctx, "slack.commands.ask.answer_posted", 1, { issue_id: state.issueId });
  }
}

function isAskIssueEvent(event: PluginEvent): boolean {
  const payload = event.payload as Record<string, unknown>;
  const workMode = typeof payload.workMode === "string" ? payload.workMode : "";
  const title = typeof payload.title === "string" ? payload.title : "";
  return workMode === "ask" || title.startsWith("Ask:");
}

async function postAskAnchorMessage(
  ctx: PluginContext,
  issue: Issue & { workMode?: string | null },
  agent: AgentLookupSummary,
  channelId: string,
  threadTs: string,
  question: string,
  created: boolean,
): Promise<string | undefined> {
  if (!channelId) return threadTs || undefined;
  const cleanBase = pluginConfig.paperclipBaseUrl.replace(/\/+$/, "");
  const label = issue.identifier ?? issue.id;
  const message: SlackMessage = {
    text: `Ask Mode ${created ? "created" : "linked"}: ${label}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:speech_balloon: *Ask Mode ${created ? "created" : "linked"}* for *${agent.name}*\n*${label}* ${issue.title}\n>${truncateSlackMarkdown(question || issue.description || issue.title, 900)}`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "View Issue" },
          url: `${cleanBase}/issues/${issue.id}`,
          action_id: "view_ask_issue_anchor",
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "Agent answers will appear in this thread." },
        ],
      },
    ],
  };
  const result = await postMessage(ctx, pluginToken, channelId, message, threadTs ? { threadTs } : undefined);
  return result.ok ? threadTs || result.ts || undefined : threadTs || undefined;
}

async function handleAskCommand(
  ctx: PluginContext,
  companyId: string,
  responseUrl: string,
  channelId: string,
  threadTs: string,
  args: string[],
): Promise<void> {
  const parsed = parseAskCommandArgs(args);
  if (!parsed) {
    await respondEphemeral(ctx, responseUrl, {
      text: [
        "Usage: `/clip ask <agent-id-or-url-key> <question>`",
        "Existing issue: `/clip ask --issue PC-123 <agent-id-or-url-key> [question]`",
        "Example: `/clip ask hackathon-pm Should we keep Slack request-change comments disabled?`",
      ].join("\n"),
    });
    return;
  }

  const lookup = normalizeAgentLookup(parsed.agentRef);
  const agents = await listAgentsForAsk(ctx, pluginConfig, companyId);
  const matches = agents.filter((agent) => {
    const agentId = normalizeAgentLookup(agent.id);
    const urlKey = normalizeAgentLookup(String(agent.urlKey ?? ""));
    const name = normalizeAgentLookup(agent.name);
    return lookup === agentId || lookup === urlKey || lookup === name;
  });

  if (matches.length !== 1) {
    const hint = matches.length > 1
      ? matches.map((agent) => `\`${agent.urlKey ?? agent.id}\` (${agent.name})`).join(", ")
      : agents.slice(0, 8).map((agent) => `\`${agent.urlKey ?? agent.id}\` (${agent.name})`).join(", ");
    await respondEphemeral(ctx, responseUrl, {
      text: matches.length > 1
        ? `Multiple agents matched \`${parsed.agentRef}\`: ${hint}`
        : `Could not find agent \`${parsed.agentRef}\`. Try one of: ${hint}`,
    });
    return;
  }

  const agent = matches[0];
  let issue: Issue & { workMode?: string | null };
  let created = false;

  if (parsed.issueRef) {
    const existing = await fetchIssueByReference(ctx, pluginConfig, parsed.issueRef);
    if (!existing) {
      await respondEphemeral(ctx, responseUrl, { text: `Could not find issue \`${parsed.issueRef}\`.` });
      return;
    }
    const patch: Record<string, unknown> = {
      workMode: "ask",
      assigneeAgentId: agent.id,
    };
    if (parsed.question) {
      patch.comment = parsed.question;
      patch.resume = true;
      if (existing.status === "done" || existing.status === "cancelled") {
        patch.reopen = true;
        patch.status = "todo";
      }
    }
    issue = await patchIssueAskMode(ctx, pluginConfig, existing.id, patch);
  } else {
    const response = await fetchPaperclipApi(
      ctx,
      pluginConfig,
      `/api/companies/${encodeURIComponent(companyId)}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: askIssueTitle(parsed.question),
          description: parsed.question,
          status: "todo",
          priority: "medium",
          workMode: "ask",
          assigneeAgentId: agent.id,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(await paperclipApiError("Paperclip Ask Mode issue create", response));
    }
    issue = await response.json() as Issue & { workMode?: string | null };
    created = true;
  }

  const askThreadTs = await postAskAnchorMessage(
    ctx,
    issue,
    agent,
    channelId,
    threadTs,
    parsed.question || issue.description || issue.title,
    created,
  );

  if (channelId) {
    await writeAskSlackThread(ctx, companyId, {
      channelId,
      threadTs: askThreadTs,
      issueId: issue.id,
      issueIdentifier: issue.identifier || undefined,
      agentId: agent.id,
      agentName: agent.name,
      agentIcon: agent.icon || undefined,
      question: parsed.question || issue.description || issue.title,
      createdAt: new Date().toISOString(),
    });
  }

  const cleanBase = pluginConfig.paperclipBaseUrl.replace(/\/+$/, "");
  await respondEphemeral(ctx, responseUrl, {
    text: `Ask Mode issue ${created ? "created" : "updated"}: ${issue.identifier ?? issue.id}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:speech_balloon: ${created ? "Created" : "Updated"} Ask Mode issue *${issue.identifier ?? issue.id}* for *${agent.name}*.\n>${parsed.question || issue.description || issue.title}\n\nAnswers will appear in the Slack thread.`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "View Issue" },
          url: `${cleanBase}/issues/${issue.id}`,
          action_id: "view_ask_issue",
        },
      },
    ],
  });
  await writeMetricBestEffort(ctx, "slack.commands.ask.created", 1, { agent_id: agent.id, mode: created ? "create" : "issue" });
}

// --- Shared Slack inbound handlers (webhooks + Socket Mode) ---

function createSharedSlackTransportHandlers() {
  return {
    handleEventsPayload: handleSlackEventsPayload,
    handleSlashCommandBody: async (rawBody: string) => {
      await handleSlashCommand(pluginCtx, rawBody);
    },
    handleInteractivityPayload,
  };
}

function configuredCompanyId(): string {
  return (
    pluginConfig.companyId?.trim() ||
    process.env.PAPERCLIP_COMPANY_ID?.trim() ||
    readLocalEnvValue("PAPERCLIP_COMPANY_ID").trim() ||
    readLocalEnvValue("COMPANY_ID").trim()
  );
}

async function getDefaultCompanyId(ctx: PluginContext): Promise<string> {
  const configured = configuredCompanyId();
  if (configured) return configured;

  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id ?? "";
  if (!companyId) throw new Error("No Paperclip company available for Slack inbound handling");
  return companyId;
}

async function listTargetCompanies(ctx: PluginContext): Promise<Array<{ id: string }>> {
  const configured = configuredCompanyId();
  if (configured) return [{ id: configured }];

  try {
    const response = await fetchPaperclipApi(ctx, pluginConfig, "/api/companies");
    if (response.ok) {
      const body = await response.json() as unknown;
      if (Array.isArray(body)) {
        return body
          .map((company) => {
            if (!company || typeof company !== "object") return null;
            const id = (company as { id?: unknown }).id;
            return typeof id === "string" ? { id } : null;
          })
          .filter((company): company is { id: string } => company !== null);
      }
    }
  } catch {
    // Fall through to the SDK client for host-invoked contexts.
  }

  try {
    return await ctx.companies.list({ limit: 100, offset: 0 });
  } catch (err) {
    ctx.logger.warn("Unable to list companies for Slack job", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

const INTERACTION_SCAN_STATUSES: Array<Issue["status"]> = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
];

type InteractionSlackMessageState = {
  channelId: string;
  ts: string;
  status: string;
};

type AskSlackThreadState = {
  channelId: string;
  threadTs?: string;
  issueId: string;
  issueIdentifier?: string;
  agentId?: string;
  agentName?: string;
  agentIcon?: string;
  question?: string;
  createdAt: string;
};

async function resolvePaperclipApiKey(ctx: PluginContext, config: SlackConfig): Promise<string> {
  const inline = config.paperclipApiKey?.trim() ?? "";
  if (inline) return inline;

  const env = process.env.PAPERCLIP_API_KEY?.trim() ?? "";
  if (env) return env;

  const localEnv = readLocalEnvValue("PAPERCLIP_API_KEY").trim();
  if (localEnv) return localEnv;

  const ref = config.paperclipApiKeyRef?.trim() ?? "";
  if (!ref) return "";

  try {
    return await ctx.secrets.resolve(ref);
  } catch (err) {
    ctx.logger.warn("Unable to resolve Paperclip API key secret ref", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

async function fetchPaperclipApi(
  ctx: PluginContext,
  config: SlackConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const apiKey = await resolvePaperclipApiKey(ctx, config);
  if (!apiKey) throw new Error("Paperclip API key is not configured");

  const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
  const url = new URL(path, baseUrl).toString();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...init, headers });
}

async function fetchIssueInteractions(
  ctx: PluginContext,
  config: SlackConfig,
  issueId: string,
): Promise<IssueThreadInteraction[]> {
  const response = await fetchPaperclipApi(
    ctx,
    config,
    `/api/issues/${encodeURIComponent(issueId)}/interactions`,
  );
  if (!response.ok) {
    throw new Error(`Paperclip interactions fetch failed with ${response.status}`);
  }
  const body = await response.json() as unknown;
  if (!Array.isArray(body)) return [];
  return body.filter(isIssueThreadInteraction);
}

async function fetchIssueInteraction(
  ctx: PluginContext,
  config: SlackConfig,
  issueId: string,
  interactionId: string,
): Promise<IssueThreadInteraction | null> {
  const interactions = await fetchIssueInteractions(ctx, config, issueId);
  return interactions.find((interaction) => interaction.id === interactionId) ?? null;
}

async function resolveIssueInteraction(
  ctx: PluginContext,
  config: SlackConfig,
  issueId: string,
  interactionId: string,
  accepted: boolean,
  reason?: string,
  selectedOptionIds?: string[],
): Promise<RequestConfirmationInteraction> {
  const action = accepted ? "accept" : "reject";
  const trimmedReason = reason?.trim();
  const requestBody = accepted
    ? selectedOptionIds ? { selectedOptionIds } : {}
    : { reason: trimmedReason || undefined };
  const response = await fetchPaperclipApi(
    ctx,
    config,
    `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/${action}`,
    {
      method: "POST",
      body: JSON.stringify(requestBody),
    },
  );
  if (!response.ok) {
    throw new Error(`Paperclip interaction ${action} failed with ${response.status}`);
  }
  const body = await response.json() as unknown;
  if (!isRequestConfirmationInteraction(body)) {
    throw new Error("Paperclip returned an unexpected interaction response");
  }
  return body;
}

function shortPlainText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

type AskFollowUpActionValue = {
  issueId: string;
  issueLabel?: string;
  agentId?: string;
  agentName?: string;
  agentIcon?: string;
  channelId?: string;
  threadTs?: string;
};

function decodeAskFollowUpActionValue(value: string): AskFollowUpActionValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<AskFollowUpActionValue>;
    if (!parsed.issueId) return null;
    return {
      issueId: String(parsed.issueId),
      issueLabel: parsed.issueLabel ? String(parsed.issueLabel) : undefined,
      agentId: parsed.agentId ? String(parsed.agentId) : undefined,
      agentName: parsed.agentName ? String(parsed.agentName) : undefined,
      agentIcon: parsed.agentIcon ? String(parsed.agentIcon) : undefined,
      channelId: parsed.channelId ? String(parsed.channelId) : undefined,
      threadTs: parsed.threadTs ? String(parsed.threadTs) : undefined,
    };
  } catch {
    return null;
  }
}

function decodeAskFollowUpModalMetadata(view: Record<string, unknown>): AskFollowUpActionValue | null {
  const metadata = view.private_metadata;
  return typeof metadata === "string" ? decodeAskFollowUpActionValue(metadata) : null;
}

function slackThreadFromInteractivityPayload(payload: Record<string, unknown>): Pick<AskFollowUpActionValue, "channelId" | "threadTs"> {
  const channel = payload.channel as Record<string, unknown> | undefined;
  const container = payload.container as Record<string, unknown> | undefined;
  const message = payload.message as Record<string, unknown> | undefined;
  const channelId = String(channel?.id ?? container?.channel_id ?? "");
  const threadTs = String(message?.thread_ts ?? container?.thread_ts ?? message?.ts ?? container?.message_ts ?? "");
  return {
    channelId: channelId || undefined,
    threadTs: threadTs || undefined,
  };
}

function extractAskFollowUpTextFromView(view: Record<string, unknown>): string {
  const state = view.state as Record<string, unknown> | undefined;
  const values = state?.values as Record<string, unknown> | undefined;
  const block = values?.[ASK_FOLLOW_UP_BLOCK_ID] as Record<string, unknown> | undefined;
  const input = block?.[ASK_FOLLOW_UP_INPUT_ACTION_ID] as Record<string, unknown> | undefined;
  return typeof input?.value === "string" ? input.value.trim() : "";
}

async function openAskFollowUpModal(ref: AskFollowUpActionValue, triggerId: string): Promise<boolean> {
  const issueLabel = ref.issueLabel || "this issue";
  const agentName = ref.agentName || "the assigned agent";
  const result = await openModal(pluginCtx, pluginToken, triggerId, {
    type: "modal",
    callback_id: ASK_FOLLOW_UP_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(ref),
    title: { type: "plain_text", text: "Ask follow-up" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: ASK_FOLLOW_UP_BLOCK_ID,
        label: {
          type: "plain_text",
          text: shortPlainText(`Follow up with ${agentName}`, 200),
        },
        element: {
          type: "plain_text_input",
          action_id: ASK_FOLLOW_UP_INPUT_ACTION_ID,
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: shortPlainText(`Ask a follow-up on ${issueLabel}`, 150),
          },
        },
      },
    ],
  });
  return result.ok;
}

async function openRejectReasonModalForInteraction(
  ref: InteractionActionValue,
  triggerId: string,
): Promise<boolean> {
  const title = ref.issueIdentifier
    ? `Request changes for ${ref.issueIdentifier}`
    : "Request changes";
  const result = await openModal(pluginCtx, pluginToken, triggerId, {
    type: "modal",
    callback_id: REJECT_CONFIRMATION_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(ref),
    title: { type: "plain_text", text: "Request changes" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: REJECT_REASON_BLOCK_ID,
        label: {
          type: "plain_text",
          text: shortPlainText(ref.rejectReasonLabel || "What should change?", 200),
        },
        element: {
          type: "plain_text_input",
          action_id: REJECT_REASON_ACTION_ID,
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: shortPlainText(title, 150),
          },
        },
      },
    ],
  });
  return result.ok;
}

function slackOption(text: string, value: string): Record<string, unknown> {
  return {
    text: { type: "plain_text", text: shortPlainText(text, 75) },
    value: shortPlainText(value, 75),
  };
}

async function openAskQuestionsModalForInteraction(
  ref: InteractionActionValue,
  interaction: AskUserQuestionsInteraction,
  triggerId: string,
): Promise<boolean> {
  const questions = interaction.payload?.questions ?? [];
  const blocks = questions.slice(0, 10).map((question, index) => {
    const actionId = `${ASK_QUESTION_ACTION_ID}:${question.id}`;
    const options = question.options.slice(0, 100).map((option) => slackOption(option.label, option.id));
    const element = question.selectionMode === "multi" || question.selectionMode === "multiple"
      ? {
          type: "multi_static_select",
          action_id: actionId,
          placeholder: { type: "plain_text", text: "Select one or more" },
          options,
        }
      : {
          type: "static_select",
          action_id: actionId,
          placeholder: { type: "plain_text", text: "Select one" },
          options,
        };
    return {
      type: "input",
      block_id: `ask_${index}`,
      optional: question.required === false,
      label: { type: "plain_text", text: shortPlainText(question.prompt, 200) },
      hint: question.helpText ? { type: "plain_text", text: shortPlainText(question.helpText, 200) } : undefined,
      element,
    };
  });

  const result = await openModal(pluginCtx, pluginToken, triggerId, {
    type: "modal",
    callback_id: ANSWER_QUESTIONS_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(ref),
    title: { type: "plain_text", text: "Answer Paperclip" },
    submit: { type: "plain_text", text: shortPlainText(interaction.payload?.submitLabel || "Submit", 24) },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  });
  return result.ok;
}

async function openCheckboxConfirmationModalForInteraction(
  ref: InteractionActionValue,
  interaction: RequestConfirmationInteraction,
  triggerId: string,
): Promise<boolean> {
  const payload = interaction.payload ?? {};
  const options = (payload.options ?? []).slice(0, 100).map((option) => slackOption(option.label, option.id));
  const defaultSelected = new Set(payload.defaultSelectedOptionIds ?? []);
  const initialOptions = options.filter((option) => defaultSelected.has(String(option.value)));
  const result = await openModal(pluginCtx, pluginToken, triggerId, {
    type: "modal",
    callback_id: CHECKBOX_CONFIRMATION_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(ref),
    title: { type: "plain_text", text: "Confirm selection" },
    submit: { type: "plain_text", text: shortPlainText(payload.acceptLabel || "Confirm", 24) },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: shortPlainText(payload.prompt || interaction.title || "Select options to confirm.", 3000),
        },
      },
      {
        type: "input",
        block_id: CHECKBOX_OPTIONS_BLOCK_ID,
        optional: (payload.minSelected ?? 0) === 0,
        label: { type: "plain_text", text: "Options" },
        element: {
          type: "multi_static_select",
          action_id: INTERACTION_CHECKBOX_OPTIONS_ACTION_ID,
          placeholder: { type: "plain_text", text: "Select options" },
          options,
          ...(initialOptions.length ? { initial_options: initialOptions } : {}),
        },
      },
    ],
  });
  return result.ok;
}

function extractRejectReasonFromView(view: Record<string, unknown>): string {
  const state = view.state as Record<string, unknown> | undefined;
  const values = state?.values as Record<string, unknown> | undefined;
  const block = values?.[REJECT_REASON_BLOCK_ID] as Record<string, unknown> | undefined;
  const input = block?.[REJECT_REASON_ACTION_ID] as Record<string, unknown> | undefined;
  return typeof input?.value === "string" ? input.value.trim() : "";
}

function decodeRejectModalMetadata(view: Record<string, unknown>): InteractionActionValue | null {
  const metadata = view.private_metadata;
  return typeof metadata === "string" ? decodeInteractionActionValue(metadata) : null;
}

function decodeInteractionModalMetadata(view: Record<string, unknown>): InteractionActionValue | null {
  const metadata = view.private_metadata;
  return typeof metadata === "string" ? decodeInteractionActionValue(metadata) : null;
}

function extractQuestionAnswersFromView(
  view: Record<string, unknown>,
): Array<{ questionId: string; optionIds: string[]; otherText?: string | null }> {
  const state = view.state as Record<string, unknown> | undefined;
  const values = state?.values as Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (!values) return [];

  const answers: Array<{ questionId: string; optionIds: string[]; otherText?: string | null }> = [];
  for (const block of Object.values(values)) {
    for (const [actionId, input] of Object.entries(block)) {
      if (!actionId.startsWith(`${ASK_QUESTION_ACTION_ID}:`)) continue;
      const questionId = actionId.slice(ASK_QUESTION_ACTION_ID.length + 1);
      const selectedOption = input.selected_option as Record<string, unknown> | undefined;
      const selectedOptions = input.selected_options as Array<Record<string, unknown>> | undefined;
      const optionIds = selectedOptions
        ? selectedOptions.map((option) => String(option.value)).filter(Boolean)
        : selectedOption?.value ? [String(selectedOption.value)] : [];
      answers.push({ questionId, optionIds });
    }
  }
  return answers;
}

function extractCheckboxOptionIdsFromView(view: Record<string, unknown>): string[] {
  const state = view.state as Record<string, unknown> | undefined;
  const values = state?.values as Record<string, unknown> | undefined;
  const block = values?.[CHECKBOX_OPTIONS_BLOCK_ID] as Record<string, unknown> | undefined;
  const input = block?.[INTERACTION_CHECKBOX_OPTIONS_ACTION_ID] as Record<string, unknown> | undefined;
  const selectedOptions = input?.selected_options as Array<Record<string, unknown>> | undefined;
  return (selectedOptions ?? []).map((option) => String(option.value)).filter(Boolean);
}

function extractSelectedOptionIdsFromSlackInput(input: Record<string, unknown> | undefined): string[] {
  const selectedOptions = input?.selected_options as Array<Record<string, unknown>> | undefined;
  return (selectedOptions ?? []).map((option) => String(option.value)).filter(Boolean);
}

function extractCheckboxOptionIdsFromBlockActionPayload(
  payload: Record<string, unknown>,
  action: Record<string, unknown>,
): { found: boolean; optionIds: string[] } {
  const direct = extractSelectedOptionIdsFromSlackInput(action);
  if ("selected_options" in action) return { found: true, optionIds: direct };

  const state = payload.state as Record<string, unknown> | undefined;
  const values = state?.values as Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (!values) return { found: false, optionIds: [] };

  for (const block of Object.values(values)) {
    const input = block[INTERACTION_CHECKBOX_OPTIONS_ACTION_ID];
    if (input && "selected_options" in input) {
      return { found: true, optionIds: extractSelectedOptionIdsFromSlackInput(input) };
    }
    const selected = extractSelectedOptionIdsFromSlackInput(input);
    if (selected.length > 0) return { found: true, optionIds: selected };
  }

  return { found: false, optionIds: [] };
}

async function respondToQuestionInteraction(
  ctx: PluginContext,
  config: SlackConfig,
  issueId: string,
  interactionId: string,
  answers: Array<{ questionId: string; optionIds: string[]; otherText?: string | null }>,
  summaryMarkdown?: string,
): Promise<AskUserQuestionsInteraction> {
  const response = await fetchPaperclipApi(
    ctx,
    config,
    `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
    {
      method: "POST",
      body: JSON.stringify({
        answers,
        summaryMarkdown,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Paperclip interaction respond failed with ${response.status}`);
  }
  const body = await response.json() as unknown;
  if (!isAskUserQuestionsInteraction(body)) {
    throw new Error("Paperclip returned an unexpected question interaction response");
  }
  return body;
}

async function listInteractionCandidateIssues(
  ctx: PluginContext,
  config: SlackConfig,
  companyId: string,
): Promise<Issue[]> {
  const query = new URLSearchParams({ status: INTERACTION_SCAN_STATUSES.join(",") });
  const response = await fetchPaperclipApi(
    ctx,
    config,
    `/api/companies/${encodeURIComponent(companyId)}/issues?${query.toString()}`,
  );
  if (!response.ok) {
    throw new Error(`Paperclip issue list failed with ${response.status}`);
  }
  const body = await response.json() as unknown;
  if (!Array.isArray(body)) return [];

  const byId = new Map<string, Issue>();
  for (const issue of body) {
    if (issue && typeof issue === "object" && "id" in issue) {
      const current = issue as Issue;
      if (typeof current.id === "string") {
        byId.set(current.id, current);
      }
    }
  }
  return [...byId.values()];
}

async function syncIssueInteractions(
  ctx: PluginContext,
  token: string,
  config: SlackConfig,
  companyId: string,
): Promise<void> {
  if (config.notifyOnRequestConfirmationCreated === false) return;

  const apiKey = await resolvePaperclipApiKey(ctx, config);
  if (!apiKey) {
    if (!warnedMissingPaperclipApiKey) {
      warnedMissingPaperclipApiKey = true;
      ctx.logger.warn("Paperclip API key not configured; issue-thread confirmation Slack sync disabled");
    }
    return;
  }

  const channelId = config.approvalsChannelId || config.defaultChannelId;
  if (!channelId) return;

  const issues = await listInteractionCandidateIssues(ctx, config, companyId);
  for (const issue of issues) {
    let interactions: IssueThreadInteraction[] = [];
    try {
      interactions = await fetchIssueInteractions(ctx, config, issue.id);
    } catch (err) {
      ctx.logger.warn("Unable to fetch issue-thread interactions", {
        issueId: issue.id,
        identifier: issue.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const interaction of interactions) {
      const sent = readInteractionSlackMessage(interaction.id);

      if (interaction.status === "pending") {
        if (sent?.ts) continue;
        const message = isAskUserQuestionsInteraction(interaction)
          ? formatAskUserQuestionsInteraction(issue, interaction, config.paperclipBaseUrl)
          : formatRequestConfirmationInteraction(issue, interaction, config.paperclipBaseUrl);
        ctx.logger.info("Posting issue-thread interaction to Slack", {
          issueId: issue.id,
          identifier: issue.identifier,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
        });
        const result = await postMessage(
          ctx,
          token,
          channelId,
          message,
        );
        if (result.ok && result.ts) {
          writeInteractionSlackMessage(interaction.id, { channelId, ts: result.ts, status: interaction.status });
          await ctx.metrics.write("slack.interactions.sent", 1, { interaction_kind: interaction.kind })
            .catch(() => undefined);
        } else {
          ctx.logger.warn("Failed to post issue-thread interaction to Slack", {
            issueId: issue.id,
            identifier: issue.identifier,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            error: result.error ?? "unknown",
          });
          await ctx.metrics.write("slack.interactions.failed", 1, {
            interaction_kind: interaction.kind,
            error_code: result.error ?? "unknown",
          }).catch(() => undefined);
        }
        continue;
      }

      if (sent?.ts && sent.channelId && sent.status !== interaction.status) {
        const message = isAskUserQuestionsInteraction(interaction)
          ? formatAskUserQuestionsStatus(issue, interaction, config.paperclipBaseUrl)
          : formatRequestConfirmationStatus(issue, interaction, config.paperclipBaseUrl);
        await updateMessage(
          ctx,
          token,
          sent.channelId,
          sent.ts,
          message,
        );
        writeInteractionSlackMessage(interaction.id, { ...sent, status: interaction.status });
      }
    }
  }
}

async function handleSlackEventsPayload(body: Record<string, unknown>): Promise<void> {
  const event = body.event as Record<string, unknown> | undefined;
  if (!event) return;

  const companyId = await getDefaultCompanyId(pluginCtx).catch((err) => {
    pluginCtx.logger.warn("Unable to resolve company for Slack event", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  });
  if (!companyId) return;
  const eventType = String(event.type ?? "");

  if (eventType === "file_shared") {
    const fileId = String(event.file_id ?? "");
    const channelId = String(event.channel_id ?? event.channel ?? "");
    if (fileId && channelId) {
      await processMediaFile(pluginCtx, pluginToken, companyId, fileId, channelId, "");
    }
    return;
  }

  if (eventType === "message") {
    if (event.bot_id || (event.subtype && event.subtype !== "file_share")) return;
    await handleSlackThreadMessageEvent(companyId, event);
    return;
  }

  if (eventType === "app_mention") {
    const routed = await handleSlackThreadMessageEvent(companyId, event);
    if (!routed) {
      const channel = String(event.channel ?? "");
      const threadTs = String(event.thread_ts ?? event.ts ?? "");
      if (channel && threadTs) {
        await postMessage(pluginCtx, pluginToken, channel, {
          text: "No active Paperclip agents are attached to this thread. Use `/clip acp spawn <agent>` first.",
        }, { threadTs });
      }
    }
  }
}

async function handleSlackThreadMessageEvent(
  companyId: string,
  event: Record<string, unknown>,
): Promise<boolean> {
  const channel = String(event.channel ?? event.channel_id ?? "");
  const threadTs = String(event.thread_ts ?? event.ts ?? "");
  const text = String(event.text ?? "");
  const replyToMessageTs = event.ts != null ? String(event.ts) : undefined;
  const files = Array.isArray(event.files) ? event.files as Array<Record<string, unknown>> : [];

  if (!channel || !threadTs) return false;

  return handleThreadMessage(companyId, {
    channel,
    threadTs,
    text,
    replyToMessageTs,
    files,
  });
}

async function handleThreadMessage(
  companyId: string,
  input: {
    channel: string;
    threadTs: string;
    text: string;
    replyToMessageTs?: string;
    files: Array<Record<string, unknown>>;
  },
): Promise<boolean> {
  if (!input.channel || !input.threadTs) return false;

  let handled = false;

  for (const file of input.files) {
    const fileId = String(file.id ?? "");
    const mimetype = String(file.mimetype ?? "");
    if (fileId && isMediaFile(mimetype)) {
      await processMediaFile(pluginCtx, pluginToken, companyId, fileId, input.channel, input.threadTs);
      handled = true;
    }
  }

  if (!input.text) return handled;

  const customCommandHandled = await tryCustomCommand(
    pluginCtx,
    pluginToken,
    companyId,
    input.channel,
    input.threadTs,
    input.text,
  );
  if (customCommandHandled) return true;

  const routedToAgent = await routeMessageToAgent(
    pluginCtx,
    companyId,
    input.channel,
    input.threadTs,
    input.text,
    input.replyToMessageTs,
  );
  return handled || routedToAgent;
}

async function handleInteractivityPayload(payload: Record<string, unknown>): Promise<void> {
  if (payload.type === "view_submission") {
    const view = payload.view as Record<string, unknown> | undefined;
    if (!view) return;

    const user = payload.user as Record<string, unknown> | undefined;
    const userId = user ? String(user.id ?? user.username ?? "unknown") : "unknown";

    if (view.callback_id === ASK_FOLLOW_UP_MODAL_CALLBACK_ID) {
      const ref = decodeAskFollowUpModalMetadata(view);
      const followUp = extractAskFollowUpTextFromView(view);
      if (!ref || !followUp) {
        pluginCtx.logger.warn("Invalid Ask follow-up modal submission", {
          hasRef: Boolean(ref),
          hasFollowUp: Boolean(followUp),
        });
        return;
      }

      try {
        await patchIssueAskMode(pluginCtx, pluginConfig, ref.issueId, {
          workMode: "ask",
          ...(ref.agentId ? { assigneeAgentId: ref.agentId } : {}),
          comment: followUp,
          resume: true,
        });
        if (ref.channelId && ref.threadTs) {
          await postMessage(pluginCtx, pluginToken, ref.channelId, {
            text: `Follow-up sent to ${ref.agentName || "Paperclip"}`,
            blocks: [
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `:leftwards_arrow_with_hook: Follow-up sent to *${ref.agentName || "the assigned agent"}* by <@${userId}>.`,
                  },
                ],
              },
              {
                type: "section",
                text: { type: "mrkdwn", text: `>${truncateSlackMarkdown(followUp, 900)}` },
              },
            ],
          }, { threadTs: ref.threadTs });
        }
        await writeMetricBestEffort(pluginCtx, "slack.commands.ask.follow_up_sent", 1, {
          issue_id: ref.issueId,
        });
      } catch (err) {
        pluginCtx.logger.warn("Failed to send Ask follow-up from Slack modal", {
          issueId: ref.issueId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (view.callback_id === REJECT_CONFIRMATION_MODAL_CALLBACK_ID) {
      const ref = decodeRejectModalMetadata(view);
      const reason = extractRejectReasonFromView(view);
      if (!ref || (ref.rejectRequiresReason && !reason)) {
        pluginCtx.logger.warn("Invalid Paperclip confirmation reject modal submission", {
          hasRef: Boolean(ref),
          hasReason: Boolean(reason),
        });
        return;
      }

      const live = pluginConfig;
      try {
        const existing = readInteractionSlackMessage(ref.interactionId);
        const interaction = await resolveIssueInteraction(
          pluginCtx,
          live,
          ref.issueId,
          ref.interactionId,
          false,
          reason,
        );
        const resolvedMessage = formatRequestConfirmationStatus(
          {
            id: ref.issueId,
            identifier: ref.issueIdentifier,
            title: ref.issueTitle,
          },
          interaction,
          live.paperclipBaseUrl,
          userId,
        );
        if (existing) {
          await updateMessage(pluginCtx, pluginToken, existing.channelId, existing.ts, resolvedMessage);
          writeInteractionSlackMessage(ref.interactionId, { ...existing, status: interaction.status });
        }
        await pluginCtx.metrics.write("slack.interactions.resolved", 1, {
          decision: "reject",
        }).catch(() => undefined);
      } catch (err) {
        pluginCtx.logger.warn("Failed to reject Paperclip confirmation from Slack modal", {
          interactionId: ref?.interactionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (view.callback_id === ANSWER_QUESTIONS_MODAL_CALLBACK_ID) {
      const ref = decodeInteractionModalMetadata(view);
      const answers = extractQuestionAnswersFromView(view);
      if (!ref || answers.length === 0) {
        pluginCtx.logger.warn("Invalid Paperclip question modal submission", {
          hasRef: Boolean(ref),
          answerCount: answers.length,
        });
        return;
      }

      const live = pluginConfig;
      try {
        const existing = readInteractionSlackMessage(ref.interactionId);
        const summaryMarkdown = answers
          .map((answer) => `${answer.questionId}: ${answer.optionIds.join(", ")}`)
          .join("\n");
        const interaction = await respondToQuestionInteraction(
          pluginCtx,
          live,
          ref.issueId,
          ref.interactionId,
          answers,
          summaryMarkdown || undefined,
        );
        const resolvedMessage = formatAskUserQuestionsStatus(
          {
            id: ref.issueId,
            identifier: ref.issueIdentifier,
            title: ref.issueTitle,
          },
          interaction,
          live.paperclipBaseUrl,
          userId,
          summaryMarkdown || undefined,
        );
        if (existing) {
          await updateMessage(pluginCtx, pluginToken, existing.channelId, existing.ts, resolvedMessage);
          writeInteractionSlackMessage(ref.interactionId, { ...existing, status: interaction.status });
        }
        await pluginCtx.metrics.write("slack.interactions.resolved", 1, {
          decision: "answer",
        }).catch(() => undefined);
      } catch (err) {
        pluginCtx.logger.warn("Failed to answer Paperclip question from Slack modal", {
          interactionId: ref?.interactionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (view.callback_id === CHECKBOX_CONFIRMATION_MODAL_CALLBACK_ID) {
      const ref = decodeInteractionModalMetadata(view);
      const selectedOptionIds = extractCheckboxOptionIdsFromView(view);
      if (!ref) {
        pluginCtx.logger.warn("Invalid Paperclip checkbox confirmation modal submission", {
          hasRef: Boolean(ref),
        });
        return;
      }

      const live = pluginConfig;
      try {
        const existing = readInteractionSlackMessage(ref.interactionId);
        const interaction = await resolveIssueInteraction(
          pluginCtx,
          live,
          ref.issueId,
          ref.interactionId,
          true,
          undefined,
          selectedOptionIds,
        );
        const resolvedMessage = formatRequestConfirmationStatus(
          {
            id: ref.issueId,
            identifier: ref.issueIdentifier,
            title: ref.issueTitle,
          },
          interaction,
          live.paperclipBaseUrl,
          userId,
        );
        if (existing) {
          await updateMessage(pluginCtx, pluginToken, existing.channelId, existing.ts, resolvedMessage);
          writeInteractionSlackMessage(ref.interactionId, { ...existing, status: interaction.status });
        }
        await pluginCtx.metrics.write("slack.interactions.resolved", 1, {
          decision: "accept",
        }).catch(() => undefined);
      } catch (err) {
        pluginCtx.logger.warn("Failed to accept Paperclip checkbox confirmation from Slack modal", {
          interactionId: ref?.interactionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    return;
  }

  if (payload.type !== "block_actions") return;

  const actions = payload.actions as Array<Record<string, unknown>>;
  const responseUrl = String(payload.response_url ?? "");
  const triggerId = String(payload.trigger_id ?? "");
  const user = payload.user as Record<string, unknown> | undefined;
  const userId = user ? String(user.id ?? user.username ?? "unknown") : "unknown";

  if (!actions?.length || !responseUrl) return;

  const action = actions[0];
  const actionId = String(action.action_id ?? "");
  const actionValue = String(action.value ?? "");

  if (!actionValue) {
    if (actionId === INTERACTION_CHECKBOX_OPTIONS_ACTION_ID) {
      return;
    }
    const selectedOptions = action.selected_options as Array<Record<string, unknown>> | undefined;
    if (selectedOptions?.length) {
      const labels = selectedOptions
        .map((option) => {
          const text = option.text as Record<string, unknown> | undefined;
          return String(text?.text ?? option.value ?? "").trim();
        })
        .filter(Boolean);
      await respondEphemeral(pluginCtx, responseUrl, {
        text: `Selected ${selectedOptions.length} option(s).`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: *Selection received*\n${labels.map((label) => `• ${label}`).join("\n")}`,
            },
          },
        ],
      });
      return;
    }
    pluginCtx.logger.info("Ignoring Slack block action without value", { actionId });
    return;
  }

  if (actionId === ASK_FOLLOW_UP_ACTION_ID) {
    const ref = decodeAskFollowUpActionValue(actionValue);
    if (!ref) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not resolve this Paperclip Ask follow-up action.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not resolve this Paperclip Ask follow-up action." },
          },
        ],
      });
      return;
    }
    if (!triggerId) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not open the Ask follow-up form from Slack.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not open the Ask follow-up form from Slack." },
          },
        ],
      });
      return;
    }
    const opened = await openAskFollowUpModal({ ...ref, ...slackThreadFromInteractivityPayload(payload) }, triggerId);
    if (!opened) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not open the Ask follow-up form from Slack.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not open the Ask follow-up form from Slack." },
          },
        ],
      });
    }
    return;
  }

  if (actionId === INTERACTION_CHECKBOX_CONFIRM_ACTION_ID) {
    const ref = decodeInteractionActionValue(actionValue);
    if (!ref) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not resolve this Paperclip checkbox confirmation action.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not resolve this Paperclip checkbox confirmation action." },
          },
        ],
      });
      return;
    }

    const live = pluginConfig;
    try {
      const existing = readInteractionSlackMessage(ref.interactionId);
      const extractedSelection = extractCheckboxOptionIdsFromBlockActionPayload(payload, action);
      let selectedOptionIds = extractedSelection.optionIds;
      if (!extractedSelection.found) {
        const current = await fetchIssueInteraction(pluginCtx, live, ref.issueId, ref.interactionId);
        if (current?.kind === "request_checkbox_confirmation") {
          selectedOptionIds = current.payload?.defaultSelectedOptionIds ?? [];
        }
      }
      const interaction = await resolveIssueInteraction(
        pluginCtx,
        live,
        ref.issueId,
        ref.interactionId,
        true,
        undefined,
        selectedOptionIds,
      );
      const resolvedMessage = formatRequestConfirmationStatus(
        {
          id: ref.issueId,
          identifier: ref.issueIdentifier,
          title: ref.issueTitle,
        },
        interaction,
        live.paperclipBaseUrl,
        userId,
      );
      await respondToAction(
        pluginCtx,
        pluginToken,
        responseUrl,
        resolvedMessage,
      ).catch(() => undefined);
      if (existing) {
        await updateMessage(pluginCtx, pluginToken, existing.channelId, existing.ts, resolvedMessage);
        writeInteractionSlackMessage(ref.interactionId, { ...existing, status: interaction.status });
      }
      await pluginCtx.metrics.write("slack.interactions.resolved", 1, {
        decision: "accept",
      }).catch(() => undefined);
    } catch (err) {
      pluginCtx.logger.warn("Failed to accept Paperclip checkbox confirmation from Slack", {
        interactionId: ref.interactionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not resolve this Paperclip checkbox confirmation. Check Paperclip API auth and try again.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":warning: Could not resolve this Paperclip checkbox confirmation. Check Paperclip API auth and try again.",
            },
          },
        ],
      });
    }
    return;
  }

  if (actionId === INTERACTION_CHECKBOX_MODAL_ACTION_ID) {
    const ref = decodeInteractionActionValue(actionValue);
    if (!ref) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not resolve this Paperclip checkbox confirmation action.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not resolve this Paperclip checkbox confirmation action." },
          },
        ],
      });
      return;
    }
    if (!triggerId) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not open the checkbox confirmation form from Slack.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not open the checkbox confirmation form from Slack." },
          },
        ],
      });
      return;
    }
    try {
      const interaction = await fetchIssueInteraction(pluginCtx, pluginConfig, ref.issueId, ref.interactionId);
      if (!interaction || !isRequestConfirmationInteraction(interaction)) {
        throw new Error("Paperclip checkbox confirmation was not found");
      }
      const opened = await openCheckboxConfirmationModalForInteraction(ref, interaction, triggerId);
      if (!opened) throw new Error("Slack rejected checkbox confirmation modal");
    } catch (err) {
      pluginCtx.logger.warn("Failed to open Paperclip checkbox confirmation modal", {
        interactionId: ref.interactionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not open this Paperclip checkbox confirmation in Slack.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not open this Paperclip checkbox confirmation in Slack." },
          },
        ],
      });
    }
    return;
  }

  if (actionId === INTERACTION_ANSWER_MODAL_ACTION_ID) {
    const ref = decodeInteractionActionValue(actionValue);
    if (!ref) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not resolve this Paperclip question action.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not resolve this Paperclip question action." },
          },
        ],
      });
      return;
    }
    if (!triggerId) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not open the Paperclip answer form from Slack.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not open the Paperclip answer form from Slack." },
          },
        ],
      });
      return;
    }
    try {
      const interaction = await fetchIssueInteraction(pluginCtx, pluginConfig, ref.issueId, ref.interactionId);
      if (!interaction || !isAskUserQuestionsInteraction(interaction)) {
        throw new Error("Paperclip question interaction was not found");
      }
      const opened = await openAskQuestionsModalForInteraction(ref, interaction, triggerId);
      if (!opened) throw new Error("Slack rejected question answer modal");
    } catch (err) {
      pluginCtx.logger.warn("Failed to open Paperclip question modal", {
        interactionId: ref.interactionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not open this Paperclip question in Slack.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not open this Paperclip question in Slack." },
          },
        ],
      });
    }
    return;
  }

  if (actionId === INTERACTION_ACCEPT_ACTION_ID || actionId === INTERACTION_REJECT_ACTION_ID) {
    const ref = decodeInteractionActionValue(actionValue);
    if (!ref) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not resolve this Paperclip confirmation action.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not resolve this Paperclip confirmation action." },
          },
        ],
      });
      return;
    }

    const accepted = actionId === INTERACTION_ACCEPT_ACTION_ID;
    if (!accepted && (ref.rejectRequiresReason || ref.rejectOpensModal)) {
      if (!triggerId) {
        await respondToAction(pluginCtx, pluginToken, responseUrl, {
          text: "Could not open a request-changes form from Slack.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: ":warning: Could not open a request-changes form from Slack.",
              },
            },
          ],
        });
        return;
      }
      const opened = await openRejectReasonModalForInteraction(ref, triggerId);
      if (!opened) {
        await respondToAction(pluginCtx, pluginToken, responseUrl, {
          text: "Could not open a request-changes form from Slack.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: ":warning: Could not open a request-changes form from Slack.",
              },
            },
          ],
        });
      }
      return;
    }

    const live = pluginConfig;
    try {
      const existing = readInteractionSlackMessage(ref.interactionId);
      const interaction = await resolveIssueInteraction(
        pluginCtx,
        live,
        ref.issueId,
        ref.interactionId,
        accepted,
      );
      const resolvedMessage = formatRequestConfirmationStatus(
        {
          id: ref.issueId,
          identifier: ref.issueIdentifier,
          title: ref.issueTitle,
        },
        interaction,
        live.paperclipBaseUrl,
        userId,
      );
      await respondToAction(
        pluginCtx,
        pluginToken,
        responseUrl,
        resolvedMessage,
      ).catch(() => undefined);
      if (existing) {
        await updateMessage(pluginCtx, pluginToken, existing.channelId, existing.ts, resolvedMessage);
        writeInteractionSlackMessage(ref.interactionId, { ...existing, status: interaction.status });
      }
      await pluginCtx.metrics.write("slack.interactions.resolved", 1, {
        decision: accepted ? "accept" : "reject",
      }).catch(() => undefined);
    } catch (err) {
      pluginCtx.logger.warn("Failed to resolve Paperclip confirmation from Slack", {
        interactionId: ref.interactionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not resolve this Paperclip confirmation. Check Paperclip API auth and try again.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":warning: Could not resolve this Paperclip confirmation. Check Paperclip API auth and try again.",
            },
          },
        ],
      });
    }
    return;
  }

  if (actionId === INTERACTION_ANSWER_ACTION_ID || actionId.startsWith(`${INTERACTION_ANSWER_ACTION_ID}:`)) {
    const ref = decodeInteractionActionValue(actionValue);
    if (!ref?.questionId || !ref.optionId) {
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not resolve this Paperclip question action.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":warning: Could not resolve this Paperclip question action." },
          },
        ],
      });
      return;
    }

    const live = pluginConfig;
    try {
      const existing = readInteractionSlackMessage(ref.interactionId);
      const interaction = await respondToQuestionInteraction(
        pluginCtx,
        live,
        ref.issueId,
        ref.interactionId,
        [{ questionId: ref.questionId, optionIds: [ref.optionId] }],
        ref.optionLabel ? `Selected: ${ref.optionLabel}` : undefined,
      );
      const resolvedMessage = formatAskUserQuestionsStatus(
        {
          id: ref.issueId,
          identifier: ref.issueIdentifier,
          title: ref.issueTitle,
        },
        interaction,
        live.paperclipBaseUrl,
        userId,
        ref.optionLabel,
      );
      await respondToAction(
        pluginCtx,
        pluginToken,
        responseUrl,
        resolvedMessage,
      ).catch(() => undefined);
      if (existing) {
        await updateMessage(pluginCtx, pluginToken, existing.channelId, existing.ts, resolvedMessage);
        writeInteractionSlackMessage(ref.interactionId, { ...existing, status: interaction.status });
      }
      await pluginCtx.metrics.write("slack.interactions.resolved", 1, {
        decision: "answer",
      }).catch(() => undefined);
    } catch (err) {
      pluginCtx.logger.warn("Failed to answer Paperclip question from Slack", {
        interactionId: ref.interactionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: "Could not answer this Paperclip question. Check Paperclip API auth and try again.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":warning: Could not answer this Paperclip question. Check Paperclip API auth and try again.",
            },
          },
        ],
      });
    }
    return;
  }

  const companyId = await getDefaultCompanyId(pluginCtx).catch((err) => {
    pluginCtx.logger.warn("Unable to resolve company for Slack interaction", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  });
  if (!companyId) return;

  if (actionId === "approval_approve" || actionId === "approval_reject") {
    const approved = actionId === "approval_approve";
    const endpoint = approved ? "approve" : "reject";
    try {
      await pluginCtx.http.fetch(
        `${pluginConfig.paperclipBaseUrl}/api/approvals/${actionValue}/${endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `slack:${userId}` }),
        },
      );

      await respondToAction(
        pluginCtx,
        pluginToken,
        responseUrl,
        formatApprovalResolved(actionValue, approved, userId),
      );
      await pluginCtx.metrics.write("slack.approvals.decided", 1, { decision: endpoint });
    } catch (err) {
      pluginCtx.logger.warn("Failed to handle approval action", { err, approvalId: actionValue });
    }
    return;
  }

  if (
    actionId === "escalation_use_suggested" ||
    actionId === "escalation_reply" ||
    actionId === "escalation_override" ||
    actionId === "escalation_dismiss"
  ) {
    try {
      const record = await pluginCtx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.escalationRecord(actionValue),
      }) as Record<string, unknown> | null;

      if (record) {
        await pluginCtx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationRecord(actionValue) },
          { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolvedBy: `slack:${userId}` },
        );
      }

      await respondToAction(
        pluginCtx,
        pluginToken,
        responseUrl,
        formatEscalationResolved(actionValue, actionId, userId),
      );
      await pluginCtx.metrics.write("slack.escalations.resolved", 1, { action: actionId });
    } catch (err) {
      pluginCtx.logger.warn("Failed to handle escalation action", { err, escalationId: actionValue });
    }
    return;
  }

  if (actionId === "handoff_approve" || actionId === "handoff_reject") {
    try {
      const approved = actionId === "handoff_approve";
      await handleHandoffAction(pluginCtx, pluginToken, companyId, actionValue, approved, userId);

      const emoji = approved ? ":white_check_mark:" : ":x:";
      const label = approved ? "Approved" : "Rejected";
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: `Handoff ${label} by ${userId}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${emoji} *Handoff ${label}* by <@${userId}>`,
            },
          },
        ],
      });
    } catch (err) {
      pluginCtx.logger.warn("Failed to handle handoff action", { err, handoffId: actionValue });
    }
    return;
  }

  if (actionId === "discussion_continue" || actionId === "discussion_stop") {
    try {
      const discAction = actionId === "discussion_continue" ? "continue" as const : "stop" as const;
      await handleDiscussionAction(pluginCtx, pluginToken, companyId, actionValue, discAction, userId);

      const emoji = discAction === "continue" ? ":arrow_forward:" : ":stop_button:";
      const label = discAction === "continue" ? "Resumed" : "Stopped";
      await respondToAction(pluginCtx, pluginToken, responseUrl, {
        text: `Discussion ${label} by ${userId}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${emoji} *Discussion ${label}* by <@${userId}>`,
            },
          },
        ],
      });
    } catch (err) {
      pluginCtx.logger.warn("Failed to handle discussion action", { err, discussionId: actionValue });
    }
    return;
  }

  if (actionId === "command_step_approve" || actionId === "command_step_reject") {
    const approved = actionId === "command_step_approve";
    const emoji = approved ? ":white_check_mark:" : ":x:";
    const label = approved ? "Approved" : "Rejected";
    await respondToAction(pluginCtx, pluginToken, responseUrl, {
      text: `Step ${label} by ${userId}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${emoji} *Step ${label}* by <@${userId}>`,
          },
        },
      ],
    });
  }
}

// --- Plugin definition ---

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const config = rawConfig as unknown as SlackConfig;
    // Always reads the current persisted config so flag changes (e.g.
    // toggling notifyOnAgentConnected) take effect without restarting the
    // plugin worker.
    const getConfig = async (): Promise<SlackConfig> =>
      (await ctx.config.get()) as unknown as SlackConfig;

    pluginCtx = ctx;
    pluginConfig = config;

    if (config.paperclipBaseUrl) {
      setBaseUrl(config.paperclipBaseUrl);
    }

    const inlineToken = config.slackToken?.trim() ?? "";
    const tokenRef = config.slackTokenRef?.trim() ?? "";

    if (!inlineToken && !tokenRef) {
      ctx.logger.warn("No slackToken/slackTokenRef configured, notifications disabled");
      return;
    }

    const token = inlineToken || await ctx.secrets.resolve(tokenRef);
    pluginToken = token;

    // Resolve Slack signing secret for webhook signature verification
    slackSigningSecret = null;
    if (config.slackSigningSecret?.trim()) {
      slackSigningSecret = config.slackSigningSecret.trim();
    } else if (config.slackSigningSecretRef?.trim()) {
      try {
        slackSigningSecret = await ctx.secrets.resolve(config.slackSigningSecretRef);
      } catch {
        ctx.logger.warn("Slack signing secret not configured — webhook signature verification disabled");
      }
    }

    // =========================================================================
    // PHASE 1: Escalation - using 3-arg ctx.tools.register with ToolRunContext
    // =========================================================================

    ctx.tools.register(
      "escalate_to_human",
      {
        displayName: "Escalate to Human",
        description: "Escalates the current conversation to a human operator via the configured Slack escalation channel.",
        parametersSchema: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Why the agent is escalating" },
            confidence: { type: "number", description: "Agent confidence score (0-1)" },
            agentName: { type: "string", description: "Name of the escalating agent" },
            conversationHistory: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  text: { type: "string" },
                },
              },
              description: "Last N messages of conversation context",
            },
            agentReasoning: { type: "string", description: "Agent's reasoning for the escalation" },
            suggestedReply: { type: "string", description: "Agent's suggested reply for the human to use" },
          },
          required: ["reason"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const escalationId = genId("esc");

        const record: EscalationRecord = {
          id: escalationId,
          reason: String(p.reason ?? ""),
          confidence: p.confidence != null ? Number(p.confidence) : undefined,
          agentName: p.agentName != null ? String(p.agentName) : undefined,
          conversationHistory: p.conversationHistory as Array<{ role: string; text: string }> | undefined,
          agentReasoning: p.agentReasoning != null ? String(p.agentReasoning) : undefined,
          suggestedReply: p.suggestedReply != null ? String(p.suggestedReply) : undefined,
          status: "open",
          createdAt: new Date().toISOString(),
        };

        const channelId = config.escalationChatId || config.approvalsChannelId || config.defaultChannelId;
        if (!channelId) {
          return { error: "No escalation channel configured" };
        }

        const message = formatEscalationMessage(record);
        const result = await postMessage(ctx, token, channelId, message);

        if (result.ok && result.ts) {
          await ctx.state.set(
            { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationTs(escalationId) },
            result.ts,
          );
          await ctx.state.set(
            { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationChannel(escalationId) },
            channelId,
          );
          await ctx.state.set(
            { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationRecord(escalationId) },
            record,
          );
          await ctx.activity.log({
            companyId,
            message: `Escalation posted to Slack: ${record.reason}`,
            entityType: "plugin",
            entityId: escalationId,
          });
          await ctx.metrics.write("slack.escalations.created", 1);
        }

        if (config.escalationHoldMessage) {
          return { content: JSON.stringify({ escalationId, holdMessage: config.escalationHoldMessage }) };
        }
        return { content: JSON.stringify({ escalationId }) };
      },
    );

    // =========================================================================
    // PHASE 2: Multi-Agent - handoff and discuss tools
    // =========================================================================

    ctx.tools.register(
      "handoff_to_agent",
      {
        displayName: "Handoff to Agent",
        description: "Requests a handoff from one agent to another in the same Slack thread. Posts an approval prompt with Approve/Reject buttons.",
        parametersSchema: {
          type: "object",
          properties: {
            fromAgent: { type: "string", description: "Name of the agent initiating the handoff" },
            toAgent: { type: "string", description: "Name of the target agent to hand off to" },
            reason: { type: "string", description: "Why the handoff is needed" },
            context: { type: "string", description: "Context to pass to the target agent on approval" },
            channelId: { type: "string", description: "Slack channel ID" },
            threadTs: { type: "string", description: "Slack thread timestamp" },
          },
          required: ["fromAgent", "toAgent", "reason", "channelId", "threadTs"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const fromAgent = String(p.fromAgent ?? "");
        const toAgent = String(p.toAgent ?? "");
        const reason = String(p.reason ?? "");
        const channelId = String(p.channelId ?? "");
        const threadTs = String(p.threadTs ?? "");
        const context = p.context != null ? String(p.context) : undefined;

        const handoffId = genId("hoff");

        await ctx.state.set(
          { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.handoff(handoffId) },
          {
            id: handoffId,
            fromAgent,
            toAgent,
            reason,
            context,
            channelId,
            threadTs,
            companyId,
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        );

        const blocks = buildHandoffBlocks(fromAgent, toAgent, reason, handoffId);
        await postMessage(ctx, token, channelId, {
          text: `Handoff: ${fromAgent} -> ${toAgent}: ${reason}`,
          blocks,
        }, threadTs ? { threadTs } : undefined);

        return { content: JSON.stringify({ handoffId, status: "pending" }) };
      },
    );

    ctx.tools.register(
      "discuss_with_agent",
      {
        displayName: "Discuss with Agent",
        description: "Starts a conversation loop between two agents in a Slack thread with human checkpoints every 5 turns.",
        parametersSchema: {
          type: "object",
          properties: {
            initiatorAgent: { type: "string", description: "Name of the agent starting the discussion" },
            targetAgent: { type: "string", description: "Name of the other agent" },
            topic: { type: "string", description: "The topic or question to discuss" },
            maxTurns: { type: "number", description: "Maximum number of turns (default 10)" },
            channelId: { type: "string", description: "Slack channel ID" },
            threadTs: { type: "string", description: "Slack thread timestamp" },
          },
          required: ["initiatorAgent", "targetAgent", "topic", "channelId", "threadTs"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const companyId = runCtx.companyId;
        const result = await startDiscussion(ctx, token, companyId, {
          initiatorAgent: String(p.initiatorAgent ?? ""),
          targetAgent: String(p.targetAgent ?? ""),
          topic: String(p.topic ?? ""),
          channelId: String(p.channelId ?? ""),
          threadTs: String(p.threadTs ?? ""),
          maxTurns: Number(p.maxTurns ?? 10),
        });
        return { content: JSON.stringify(result) };
      },
    );

    // =========================================================================
    // PHASE 3: Media Pipeline tool
    // =========================================================================

    ctx.tools.register(
      "process_media",
      {
        displayName: "Process Media",
        description: "Processes a media file (audio/video) from Slack - transcribes audio and optionally generates a brief.",
        parametersSchema: {
          type: "object",
          properties: {
            fileId: { type: "string", description: "Slack file ID to process" },
            channelId: { type: "string", description: "Channel to post results to" },
            threadTs: { type: "string", description: "Thread to post results in" },
            briefAgentId: { type: "string", description: "Optional agent ID to generate a brief from the transcription" },
          },
          required: ["fileId", "channelId", "threadTs"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const result = await processMediaFile(
          ctx,
          token,
          runCtx.companyId,
          String(p.fileId),
          String(p.channelId),
          String(p.threadTs),
          p.briefAgentId ? String(p.briefAgentId) : undefined,
        );

        if (!result) {
          return { error: "Failed to process media file" };
        }
        return { content: JSON.stringify(result) };
      },
    );

    // =========================================================================
    // PHASE 4: Custom Commands tool
    // =========================================================================

    ctx.tools.register(
      "register_command",
      {
        displayName: "Register Custom Command",
        description: "Registers a custom !command that can be triggered from Slack messages. Commands can have workflow steps like invoking agents, posting messages, or creating issues.",
        parametersSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Command name (without ! prefix)" },
            description: { type: "string", description: "What the command does" },
            usage: { type: "string", description: "Usage example (e.g. '!deploy staging')" },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["invoke_agent", "post_message", "create_issue", "wait_approval"],
                  },
                  agentId: { type: "string" },
                  prompt: { type: "string" },
                  message: { type: "string" },
                  issueTitle: { type: "string" },
                  issueDescription: { type: "string" },
                  timeout: { type: "number" },
                },
                required: ["type"],
              },
              description: "Workflow steps to execute",
            },
          },
          required: ["name", "description", "usage", "steps"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const command: CommandDefinition = {
          name: String(p.name),
          description: String(p.description),
          usage: String(p.usage),
          steps: (p.steps as CommandDefinition["steps"]) ?? [],
        };

        const ok = await registerCommand(ctx, runCtx.companyId, command);
        return { content: JSON.stringify({ registered: ok, name: command.name }) };
      },
    );

    // =========================================================================
    // PHASE 5: Proactive Suggestions tool
    // =========================================================================

    ctx.tools.register(
      "register_watch",
      {
        displayName: "Register Event Watch",
        description: "Registers a watch that triggers an agent when a matching event occurs. The agent will be invoked with a prompt interpolated with event data.",
        parametersSchema: {
          type: "object",
          properties: {
            eventPattern: {
              type: "string",
              description: "Event pattern to watch (e.g. 'issue.created', 'agent.run.*')",
            },
            agentId: { type: "string", description: "Agent to invoke when triggered" },
            prompt: {
              type: "string",
              description: "Prompt template (use ${event.payload.key} for interpolation)",
            },
            channelId: { type: "string", description: "Slack channel to post results to" },
            threadTs: { type: "string", description: "Optional thread to post results in" },
          },
          required: ["eventPattern", "agentId", "prompt", "channelId"],
        },
      },
      async (params: unknown, runCtx) => {
        const p = params as Record<string, unknown>;
        const watch = await registerWatch(ctx, runCtx.companyId, {
          channelId: String(p.channelId),
          threadTs: String(p.threadTs ?? ""),
          companyId: runCtx.companyId,
          eventPattern: String(p.eventPattern),
          agentId: String(p.agentId),
          prompt: String(p.prompt),
          createdBy: runCtx.agentId ?? "tool",
        });
        return { content: JSON.stringify({ watchId: watch.id, eventPattern: watch.eventPattern }) };
      },
    );

    ctx.tools.register(
      "remove_watch",
      {
        displayName: "Remove Event Watch",
        description: "Removes a registered event watch by ID.",
        parametersSchema: {
          type: "object",
          properties: {
            watchId: { type: "string", description: "Watch ID to remove" },
          },
          required: ["watchId"],
        },
      },
      async (params: unknown, _runCtx) => {
        const p = params as Record<string, unknown>;
        const removed = await removeWatch(ctx, String(p.watchId));
        return { content: JSON.stringify({ removed, watchId: String(p.watchId) }) };
      },
    );

    ctx.tools.register(
      "list_watch_templates",
      {
        displayName: "List Watch Templates",
        description: "Lists built-in watch templates for common use cases like sales follow-ups, deal monitoring, and error diagnosis.",
        parametersSchema: {
          type: "object",
          properties: {},
        },
      },
      async (_params, _runCtx) => {
        const templates = BUILTIN_WATCH_TEMPLATES.map((t) => ({
          name: t.name,
          eventPattern: t.eventPattern,
          description: t.description,
        }));
        return { content: JSON.stringify({ templates }) };
      },
    );

    // =========================================================================
    // Notification helper (supports per-type channel override + threading)
    // =========================================================================

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent) => SlackMessage,
      overrideChannelId?: string,
      opts?: { threadTs?: string },
    ) => {
      const fallback = overrideChannelId || config.defaultChannelId;
      const channelId = await resolveChannel(ctx, event.companyId, fallback);
      if (!channelId) return;
      const entityId = event.entityId ?? "";
      const dedupeKey = entityId ? STATE_KEYS.notificationSent(event.eventType, entityId) : "";
      if (dedupeKey) {
        if (notificationDedupeInFlight.has(dedupeKey)) return;
        notificationDedupeInFlight.add(dedupeKey);
        const alreadySent = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: dedupeKey,
        });
        if (alreadySent) {
          notificationDedupeInFlight.delete(dedupeKey);
          return;
        }
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: dedupeKey },
          { createdAt: new Date().toISOString(), status: "posting" },
        );
      }
      try {
        const result = await postMessage(ctx, token, channelId, formatter(event), opts);
        if (result.ok) {
          if (dedupeKey) {
            await ctx.state.set(
              { scopeKind: "company", scopeId: event.companyId, stateKey: dedupeKey },
              { createdAt: new Date().toISOString(), status: "sent", ts: result.ts ?? null },
            );
          }
          await ctx.activity.log({
            companyId: event.companyId,
            message: `Forwarded ${event.eventType} to Slack`,
            entityType: "plugin",
            entityId: event.entityId,
          });
          await ctx.metrics.write("slack.notifications.sent", 1, { event_type: event.eventType });
        } else {
          if (dedupeKey) {
            await ctx.state.delete({
              scopeKind: "company",
              scopeId: event.companyId,
              stateKey: dedupeKey,
            });
          }
          await ctx.metrics.write("slack.notifications.failed", 1, { event_type: event.eventType, error_code: result.error ?? "unknown" });
        }
        return result;
      } catch (err) {
        if (dedupeKey) {
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: event.companyId,
            stateKey: dedupeKey,
          });
        }
        throw err;
      } finally {
        if (dedupeKey) notificationDedupeInFlight.delete(dedupeKey);
      }
    };

    // =========================================================================
    // Core event subscriptions (existing notifications)
    // =========================================================================

    // Handlers are always registered so that config changes (e.g. toggling
    // notifyOnAgentConnected) take effect without a plugin restart.
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const live = await getConfig();
      if (!live.notifyOnIssueCreated) return;
      if (isAskIssueEvent(event)) return;
      const result = await notify(event, formatIssueCreated);
      if (result?.ok && result.ts) {
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.threadIssue(event.entityId ?? "") },
          result.ts,
        );
      }
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const live = await getConfig();
      if (!live.notifyOnIssueDone) return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.status !== "done") return;
      const threadTs = await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: STATE_KEYS.threadIssue(event.entityId ?? ""),
      }) as string | null;
      await notify(event, formatIssueDone, undefined, threadTs ? { threadTs } : undefined);
    });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      await maybeMirrorAskAnswerToSlack(ctx, event).catch((err) => {
        ctx.logger.warn("Failed to mirror Paperclip Ask answer to Slack", {
          issueId: event.entityId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    ctx.events.on("approval.created", async (event: PluginEvent) => {
      const live = await getConfig();
      if (!live.notifyOnApprovalCreated) return;
      await notify(event, formatApprovalCreated, live.approvalsChannelId);
    });

    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      const live = await getConfig();
      if (!live.notifyOnAgentError) return;
      await notify(event, formatAgentError, live.errorsChannelId);
    });

    ctx.events.on("agent.status_changed", async (event: PluginEvent) => {
      const live = await getConfig();
      if (!live.notifyOnAgentConnected) return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.status === "active" || payload.status === "online") {
        await notify(event, formatAgentConnected, live.pipelineChannelId);
      }
    });

    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const live = await getConfig();
      if (!live.notifyOnAgentConnected) return;
      const payload = event.payload as Record<string, unknown>;
      // Dedup on agent id, not run id — event.entityId is the run UUID for
      // agent.run.finished, so using it produces a unique key every run.
      const agentId = String(payload.agentId ?? event.entityId ?? "");
      const key = STATE_KEYS.firstRunNotified(agentId);
      const alreadyNotified = await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: key,
      });
      if (alreadyNotified) return;

      await ctx.state.set(
        { scopeKind: "company", scopeId: event.companyId, stateKey: key },
        true,
      );
      const milestoneEvent = {
        ...event,
        payload: {
          ...payload,
          agentName: String(payload.agentName ?? payload.name ?? agentId),
          milestone: "first successful run",
        },
      };
      await notify(milestoneEvent, formatOnboardingMilestone, live.pipelineChannelId);
    });

    ctx.events.on("cost_event.created", async (event: PluginEvent) => {
      const live = await getConfig();
      if (!live.notifyOnBudgetThreshold) return;
      const payload = event.payload as Record<string, unknown>;
      const pct = Number(payload.percentUsed ?? 0);
      if (pct < 80) return;

      const bucket = pct >= 100 ? 100 : pct >= 90 ? 90 : 80;
      const key = STATE_KEYS.budgetAlert(event.entityId ?? "", bucket);
      const alreadySent = await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: key,
      });
      if (alreadySent) return;

      await ctx.state.set(
        { scopeKind: "company", scopeId: event.companyId, stateKey: key },
        true,
      );
      await notify(event, formatBudgetThreshold, live.pipelineChannelId);
      await ctx.metrics.write("slack.budget_alerts.sent", 1, { threshold: String(bucket) });
    });

    // =========================================================================
    // Per-company channel overrides
    // =========================================================================

    ctx.data.register("channel-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.slackChannel,
      });
      return { channelId: saved ?? config.defaultChannelId };
    });

    ctx.actions.register("set-channel", async (params) => {
      const companyId = String(params.companyId);
      const channelId = String(params.channelId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.slackChannel },
        channelId,
      );
      ctx.logger.info("Updated Slack channel mapping", { companyId, channelId });
      return { ok: true };
    });

    // =========================================================================
    // Jobs
    // =========================================================================

    // Daily digest
    if (config.enableDailyDigest) {
      ctx.jobs.register("daily-digest", async () => {
        const companies = await listTargetCompanies(ctx);
        for (const company of companies) {
          const channelId = await resolveChannel(ctx, company.id, config.defaultChannelId);
          if (!channelId) continue;

          const issues = await ctx.issues.list({ companyId: company.id, limit: 200, offset: 0 });
          const now = new Date();
          const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

          let tasksCompleted = 0;
          let tasksCreated = 0;
          for (const issue of issues) {
            const updated = new Date(issue.updatedAt);
            const created = new Date(issue.createdAt);
            if (issue.status === "done" && updated >= dayAgo) tasksCompleted++;
            if (created >= dayAgo) tasksCreated++;
          }

          const agents = await ctx.agents.list({ companyId: company.id, limit: 100, offset: 0 });
          const agentsActive = agents.filter((a) =>
            a.status === "active" || a.status === "running"
          ).length;

          const dateKey = now.toISOString().slice(0, 10);
          const dailyCost = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyCost(dateKey),
          });
          const totalCost = dailyCost ? String((dailyCost as number).toFixed(2)) : "0.00";

          const topAgentCosts = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
          });
          let topAgent = "";
          if (topAgentCosts && typeof topAgentCosts === "object") {
            const costs = topAgentCosts as Record<string, number>;
            let maxCost = 0;
            for (const [name, cost] of Object.entries(costs)) {
              if (cost > maxCost) { maxCost = cost; topAgent = name; }
            }
          }

          await postMessage(ctx, token, channelId, formatDailyDigest({
            tasksCompleted,
            tasksCreated,
            agentsActive,
            totalCost,
            topAgent,
          }));

          // Clean up previous day's cost state
          const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyCost(yesterday),
          });
          await ctx.state.delete({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.dailyAgentCosts(yesterday),
          });
        }
        ctx.logger.info("Daily digest posted to Slack");
        await ctx.metrics.write("slack.digest.sent", 1);
      });

      // Accumulate costs
      ctx.events.on("cost_event.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const cost = Number(payload.cost ?? 0);
        if (cost <= 0) return;

        const dateKey = new Date().toISOString().slice(0, 10);
        const currentTotal = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.dailyCost(dateKey),
        });
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.dailyCost(dateKey) },
          ((currentTotal as number) ?? 0) + cost,
        );

        const agentName = String(payload.agentName ?? payload.name ?? event.entityId);
        const agentCosts = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
        });
        const costs = (agentCosts as Record<string, number>) ?? {};
        costs[agentName] = (costs[agentName] ?? 0) + cost;
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.dailyAgentCosts(dateKey) },
          costs,
        );
      });

      ctx.logger.info("Daily digest job registered (9am daily)");
    }

    // Escalation timeout job
    ctx.jobs.register("check-escalation-timeouts", async () => {
      const companies = await listTargetCompanies(ctx);
      const timeoutMs = config.escalationTimeoutMs ?? 900000;
      const now = Date.now();

      for (const company of companies) {
        const openEscalationsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: company.id,
          stateKey: "escalation-records-index",
        });
        const escalationIds = Array.isArray(openEscalationsRaw) ? openEscalationsRaw as string[] : [];

        for (const escalationKey of escalationIds) {
          const record = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationRecord(escalationKey),
          }) as Record<string, unknown> | null;
          if (!record || record.status !== "open") continue;

          const createdAt = new Date(String(record.createdAt)).getTime();
          if (now - createdAt < timeoutMs) continue;

          const escalationId = String(record.id);
          const defaultAction = config.escalationDefaultAction ?? "defer";

          await ctx.state.set(
            { scopeKind: "company", scopeId: company.id, stateKey: STATE_KEYS.escalationRecord(escalationId) },
            { ...record, status: "timed_out", resolvedAt: new Date().toISOString(), resolvedBy: "system:timeout" },
          );

          const channelId = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationChannel(escalationId),
          }) as string | null;

          const threadTs = await ctx.state.get({
            scopeKind: "company",
            scopeId: company.id,
            stateKey: STATE_KEYS.escalationTs(escalationId),
          }) as string | null;

          if (channelId && threadTs) {
            await postMessage(ctx, token, channelId, {
              text: `Escalation timed out - default action: ${defaultAction}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `:hourglass: *Escalation timed out*\nDefault action applied: \`${defaultAction}\``,
                  },
                },
              ],
            }, { threadTs });
          }

          await ctx.metrics.write("slack.escalations.timed_out", 1, { action: defaultAction });
          ctx.logger.info("Escalation timed out", { escalationId, defaultAction });
        }
      }
    });

    // Issue-thread confirmation sync
    ctx.jobs.register("check-issue-interactions", async () => {
      const live = await getConfig();
      const companies = await listTargetCompanies(ctx);
      for (const company of companies) {
        await syncIssueInteractions(ctx, token, live, company.id);
      }
    });

    // Phase 5: Check watches job
    ctx.jobs.register("check-watches", async () => {
      const companies = await listTargetCompanies(ctx);
      for (const company of companies) {
        // Get recent events from state (populated by event listeners below)
        const recentEventsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: company.id,
          stateKey: "recent-watch-events",
        });
        const recentEvents = Array.isArray(recentEventsRaw)
          ? (recentEventsRaw as Array<{ eventType: string; payload: Record<string, unknown> }>)
          : [];

        if (recentEvents.length > 0) {
          await checkWatches(ctx, token, company.id, recentEvents);
          // Clear after processing
          await ctx.state.set(
            { scopeKind: "company", scopeId: company.id, stateKey: "recent-watch-events" },
            [],
          );
        }
      }
    });

    // =========================================================================
    // Agent output listeners (native streaming + ACP events)
    // =========================================================================

    // Native agent streaming output
    ctx.events.on("plugin.slack.agent-stream-chunk", async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      await handleAgentOutput(ctx, token, event.companyId, {
        channel: String(p.channel ?? ""),
        threadTs: String(p.threadTs ?? ""),
        text: String(p.text ?? ""),
        agentName: p.agentName != null ? String(p.agentName) : undefined,
        agentDisplayName: p.agentDisplayName != null ? String(p.agentDisplayName) : undefined,
        toolName: p.toolName != null ? String(p.toolName) : undefined,
      });
    });

    // ACP output events (from cross-plugin)
    ctx.events.on(`plugin.paperclip-plugin-acp.output`, async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      await handleAgentOutput(ctx, token, event.companyId, {
        channel: String(p.channel ?? ""),
        threadTs: String(p.threadTs ?? ""),
        text: String(p.text ?? ""),
        agentName: p.agentName != null ? String(p.agentName) : undefined,
        agentDisplayName: p.agentDisplayName != null ? String(p.agentDisplayName) : undefined,
        toolName: p.toolName != null ? String(p.toolName) : undefined,
      });
    });

    // Escalation thread reply routing (from Slack Events API)
    ctx.events.on("plugin.slack.thread_reply_escalation", async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      const escalationId = String(p.escalationId ?? "");
      const replyText = String(p.text ?? "");
      const userId = String(p.userId ?? "unknown");
      if (!escalationId || !replyText) return;

      const record = await ctx.state.get({
        scopeKind: "company",
        scopeId: event.companyId,
        stateKey: STATE_KEYS.escalationRecord(escalationId),
      }) as Record<string, unknown> | null;

      if (record) {
        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.escalationRecord(escalationId) },
          { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolvedBy: `slack:${userId}` },
        );
      }

      // Route reply to agent session if we have one
      if (record?.sessionId && record?.agentName) {
        const sessions = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: STATE_KEYS.sessionRegistry(
            String(record.channelId ?? ""),
            String(record.threadTs ?? ""),
          ),
        });
        // Find session and send reply back
        if (Array.isArray(sessions)) {
          const session = (sessions as SessionEntry[]).find(
            (s) => s.agentName === String(record.agentName) && s.status === "active",
          );
          if (session && session.transport === "native") {
            await ctx.agents.sessions.sendMessage(session.sessionId, event.companyId, {
              prompt: `Human reply to escalation: ${replyText}`,
              reason: "Escalation reply from Slack",
            });
          }
        }
      }

      await ctx.metrics.write("slack.escalations.resolved", 1, { action: "human_reply" });
    });

    // Thread message routing (multi-agent + custom commands + media)
    ctx.events.on("plugin.slack.thread_message", async (event: PluginEvent) => {
      const p = event.payload as Record<string, unknown>;
      await handleThreadMessage(event.companyId, {
        channel: String(p.channel ?? ""),
        threadTs: String(p.threadTs ?? ""),
        text: String(p.text ?? ""),
        replyToMessageTs: p.replyToMessageTs != null ? String(p.replyToMessageTs) : undefined,
        files: Array.isArray(p.files) ? p.files as Array<Record<string, unknown>> : [],
      });
    });

    // Collect events for watch checking (Phase 5)
    const watchableEvents: Array<"issue.created" | "issue.updated" | "agent.run.failed" | "agent.run.finished" | "agent.status_changed" | "cost_event.created" | "approval.created"> = [
      "issue.created", "issue.updated",
      "agent.run.failed", "agent.run.finished", "agent.status_changed",
      "cost_event.created", "approval.created",
    ];
    for (const eventType of watchableEvents) {
      ctx.events.on(eventType, async (event: PluginEvent) => {
        const recentEventsRaw = await ctx.state.get({
          scopeKind: "company",
          scopeId: event.companyId,
          stateKey: "recent-watch-events",
        });
        const recentEvents = Array.isArray(recentEventsRaw)
          ? (recentEventsRaw as Array<{ eventType: string; payload: Record<string, unknown> }>)
          : [];

        // Keep last 100 events
        recentEvents.push({
          eventType: event.eventType,
          payload: event.payload as Record<string, unknown>,
        });
        if (recentEvents.length > 100) {
          recentEvents.splice(0, recentEvents.length - 100);
        }

        await ctx.state.set(
          { scopeKind: "company", scopeId: event.companyId, stateKey: "recent-watch-events" },
          recentEvents,
        );
      });
    }

    slackAdapter = new SlackAdapter(ctx, token);

    socketModeClient?.stop();
    socketModeClient = null;
    const inlineAppToken = config.slackAppToken?.trim() || process.env.SLACK_APP_TOKEN?.trim() || "";
    const appTokenRef = config.slackAppTokenRef?.trim() ?? "";
    if (inlineAppToken || appTokenRef) {
      try {
        const appToken = appTokenRef ? await ctx.secrets.resolve(appTokenRef) : inlineAppToken;
        socketModeClient = new SlackSocketModeClient(
          ctx,
          appToken,
          createSocketModeHandlers(createSharedSlackTransportHandlers()),
        );
        await socketModeClient.start();
        ctx.logger.info("Slack Socket Mode enabled");
      } catch (err) {
        ctx.logger.warn("Slack Socket Mode failed to start; webhook mode remains active", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    ctx.logger.info("Slack Chat OS plugin started");
  },

  // =========================================================================
  // Webhook handler (Slack Events, Slash Commands, Interactivity)
  // =========================================================================

  async onWebhook(input: PluginWebhookInput): Promise<void> {
    // Verify Slack request signature (skip for url_verification challenge)
    const body = input.parsedBody as Record<string, unknown> | undefined;
    const isVerificationChallenge = body?.type === "url_verification";

    if (!isVerificationChallenge && !verifySlackSignature(input.headers, input.rawBody)) {
      pluginCtx.logger.warn("Rejected webhook: invalid Slack signature");
      return;
    }

    await dispatchSlackWebhook(input, createSharedSlackTransportHandlers());
  },

  async onShutdown(): Promise<void> {
    socketModeClient?.stop();
    socketModeClient = null;
  },

  async onValidateConfig(config) {
    const hasInlineToken = typeof config.slackToken === "string" && config.slackToken.trim().length > 0;
    const hasTokenRef = typeof config.slackTokenRef === "string" && config.slackTokenRef.trim().length > 0;
    if (!hasInlineToken && !hasTokenRef) {
      return { ok: false, errors: ["slackToken or slackTokenRef is required"] };
    }
    if (!config.defaultChannelId || typeof config.defaultChannelId !== "string") {
      return { ok: false, errors: ["defaultChannelId is required"] };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
