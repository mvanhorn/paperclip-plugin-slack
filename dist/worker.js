import { createHmac, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { definePlugin, runWorker, } from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS, STATE_KEYS, PLUGIN_ID, DEFAULT_CONFIG } from "./constants.js";
import { postMessage, updateMessage, respondToAction, respondEphemeral } from "./slack-api.js";
import { SlackSocketModeClient } from "./socket-mode.js";
import { createSocketModeHandlers, dispatchSlackWebhook } from "./slack-transport.js";
import { routeMessageToAgent, handleAgentOutput, handleHandoffAction, handleDiscussionAction, handleAcpSlashCommand, startDiscussion, buildHandoffBlocks, } from "./acp-bridge.js";
import { setBaseUrl, formatIssueCreated, formatIssueDone, formatApprovalCreated, formatApprovalResolved, formatAgentError, formatAgentConnected, formatBudgetThreshold, formatOnboardingMilestone, formatDailyDigest, formatEscalationMessage, formatEscalationResolved, } from "./formatters.js";
import { processMediaFile, isMediaFile } from "./media-pipeline.js";
import { registerCommand, handleCommandsSlash, tryCustomCommand, } from "./custom-commands.js";
import { registerWatch, removeWatch, listWatches, checkWatches, BUILTIN_WATCH_TEMPLATES, } from "./proactive-suggestions.js";
import { INTERACTION_ACCEPT_ACTION_ID, INTERACTION_REJECT_ACTION_ID, decodeInteractionActionValue, formatRequestConfirmationInteraction, formatRequestConfirmationStatus, isRequestConfirmationInteraction, } from "./interactions.js";
import { resolveStartupSlackToken, SECRET_RESOLUTION_ISSUE_URL } from "./runtime-token.js";
import { isUsableSecretRef, normalizeSecretRef, normalizeSecretRefId, redactSecretRefs, validateSecretRefFields, } from "./secret-ref-validation.js";
/** Captured in setup() so onWebhook / onConfigChanged can reach the host APIs. */
let pluginCtx;
/** The active runtime, or null until the first configuration delivery. */
let runtime = null;
let runtimeHealth = {
    status: "degraded",
    message: "Waiting for company-scoped configuration from the host",
    details: {
        issue: "slack-awaiting-company-config",
        reference: SECRET_RESOLUTION_ISSUE_URL,
    },
};
// Legacy convenience mirrors, written only by bootstrapRuntime. Module-level
// handlers (slash commands, interactivity) read these AFTER an ensureRuntime()
// guard upstream has confirmed the runtime exists.
let pluginToken;
let pluginConfig;
const outsideInvocation = AsyncLocalStorage.snapshot();
let socketModeClient = null;
let slackSigningSecret = null;
/**
 * The single ordered critical section every configuration delivery runs inside.
 * Host->worker requests are NOT serialized by the transport, so two deliveries
 * must queue against each other here.
 */
let bootstrapQueue = Promise.resolve();
/** The company this worker serves, once one has been selected. */
let ownerCompanyId = null;
/** Config last accepted for the owner, for the host's equal-config rule. */
let ownerConfigJson = null;
/** Companies already refused; keeps a chatty non-owner from flooding the log. */
const refusedCompanies = new Set();
function setRuntimeHealth(health) {
    runtimeHealth = health;
}
function degradeHealth(message, issue, details) {
    runtimeHealth = {
        status: "degraded",
        message,
        details: { issue, reference: SECRET_RESOLUTION_ISSUE_URL, ...details },
    };
}
/** Test seam — reset all module-level runtime state. */
export function _resetRuntimeForTests() {
    socketModeClient?.stop();
    socketModeClient = null;
    runtime = null;
    bootstrapQueue = Promise.resolve();
    ownerCompanyId = null;
    ownerConfigJson = null;
    refusedCompanies.clear();
    pluginToken = undefined;
    pluginConfig = undefined;
    slackSigningSecret = null;
    runtimeHealth = {
        status: "degraded",
        message: "Waiting for company-scoped configuration from the host",
        details: {
            issue: "slack-awaiting-company-config",
            reference: SECRET_RESOLUTION_ISSUE_URL,
        },
    };
}
/** Current runtime, or null when the plugin has not been bootstrapped yet. */
export function _getRuntimeForTests() {
    return runtime;
}
/**
 * The runtime for a company-scoped invocation, or null.
 *
 * Never reads config and never bootstraps: configuration deliveries are the
 * ONLY way a runtime starts. A company that is not the owner gets null, logged
 * once. Callers MUST treat null as "do nothing for this company".
 */
function ensureRuntime(companyId) {
    if (companyId && ownerCompanyId && companyId !== ownerCompanyId) {
        if (pluginCtx && !refusedCompanies.has(companyId)) {
            refusedCompanies.add(companyId);
            pluginCtx.logger.warn(`Slack plugin ignoring an invocation for company ${companyId}; this install serves ${ownerCompanyId}`, { runningCompanyId: ownerCompanyId, invokingCompanyId: companyId });
        }
        return null;
    }
    if (!runtime)
        return null;
    if (companyId && companyId !== runtime.companyId)
        return null;
    return runtime;
}
function stableConfigJson(config) {
    const normalize = (value) => {
        if (Array.isArray(value))
            return value.map(normalize);
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => [key, normalize(entry)]));
        }
        return value;
    };
    return JSON.stringify(normalize(config));
}
/**
 * The single ownership gate. The first company whose configuration reaches this
 * worker claims it; claiming does not require the runtime to start, so an owner
 * whose token stopped resolving stays the owner. One exception, mirroring the
 * host's single-tenant guard: an identical configuration under a DIFFERENT
 * company advances ownership (migration duplicates each unbound legacy config
 * across every company), else the plugin would own A while the SDK owns B.
 */
function claimOwnership(ctx, companyId, config) {
    const configJson = stableConfigJson(config);
    if (!ownerCompanyId) {
        ownerCompanyId = companyId;
        ownerConfigJson = configJson;
        return true;
    }
    if (ownerCompanyId === companyId) {
        ownerConfigJson = configJson;
        return true;
    }
    if (ownerConfigJson !== null && ownerConfigJson === configJson) {
        ctx.logger.info(`Slack plugin owner advancing from company ${ownerCompanyId} to ${companyId}: identical configuration, ` +
            "matching the host's single-tenant rule", { previousCompanyId: ownerCompanyId, companyId });
        // Retire the outgoing owner's runtime FIRST. Everything after can fail (the
        // new owner may have no resolvable token), and a live runtime bound to a
        // company that no longer owns the install is worse than none: a no-arg
        // ensureRuntime() during the bootstrap window would otherwise still serve it.
        runtime = null;
        ownerCompanyId = companyId;
        ownerConfigJson = configJson;
        refusedCompanies.delete(companyId);
        return true;
    }
    if (!refusedCompanies.has(companyId)) {
        refusedCompanies.add(companyId);
        ctx.logger.warn(`Slack plugin ignoring configuration for company ${companyId}; this install serves ${ownerCompanyId}`, { runningCompanyId: ownerCompanyId, deliveredCompanyId: companyId });
    }
    return false;
}
async function readScopedConfig(ctx, companyId) {
    try {
        const rawConfig = await ctx.config.get(companyId);
        return rawConfig ?? null;
    }
    catch (err) {
        ctx.logger.debug("Company-scoped plugin config is not readable", {
            companyId,
            error: String(err),
        });
        return null;
    }
}
/**
 * Identify which company a context-less config delivery belongs to.
 *
 * The v2026.720/722 SDKs call onConfigChanged(config) with no scope, but the
 * host still binds the invocation to the real company and denies a read for any
 * other one, so probing each company here identifies the delivered scope: only
 * the right company answers.
 */
async function identifyDeliveredCompany(ctx, deliveredConfig) {
    let companies;
    try {
        companies = await ctx.companies.list();
    }
    catch (err) {
        ctx.logger.info("Could not list companies while attributing a configuration delivery", {
            error: String(err),
        });
        return null;
    }
    const readable = [];
    for (const company of companies) {
        const config = await readScopedConfig(ctx, company.id);
        if (config)
            readable.push({ id: company.id, config });
    }
    if (readable.length === 0)
        return null;
    if (readable.length === 1)
        return readable[0].id;
    // A host that answers for several companies (>= 2026.817.0) is not telling us
    // which one was saved; match the delivered secret reference against the rows.
    const deliveredSecretId = normalizeSecretRefId(deliveredConfig?.slackTokenRef);
    if (deliveredSecretId) {
        const match = readable.find((row) => normalizeSecretRefId(row.config.slackTokenRef) === deliveredSecretId);
        if (match)
            return match.id;
    }
    return readable[0].id;
}
/**
 * Run one bootstrap attempt inside the ordered critical section shared by every
 * configuration delivery — the only thing that bootstraps.
 */
function queueBootstrap(work) {
    const next = bootstrapQueue.then(work, work);
    bootstrapQueue = next.then(() => undefined, () => undefined);
    return next;
}
/**
 * Apply one company's stored configuration to the runtime. Callers MUST go
 * through queueBootstrap. Never throws: every failure path degrades health and
 * returns null.
 */
async function bootstrapRuntime(ctx, companyId, rawConfig) {
    if (!claimOwnership(ctx, companyId, rawConfig))
        return runtime;
    // A failed (re-)bootstrap leaves any EXISTING runtime intact: an owner whose
    // new save has a broken token keeps serving on the old one, degraded-but-live,
    // until a valid save arrives. On a fresh install `runtime` is already null.
    const config = {
        ...DEFAULT_CONFIG,
        ...rawConfig,
    };
    // Required config is reported through health, never thrown: throwing here
    // would kill worker activation on a host that simply has not delivered a
    // usable config yet. onValidateConfig is what fails a bad save loudly.
    if (!isUsableSecretRef(config.slackTokenRef)) {
        degradeHealth(`[${PLUGIN_ID}] slackTokenRef is missing or not a Paperclip secret UUID; set the Slack bot token in plugin settings`, "slack-bot-token-missing", { companyId });
        ctx.logger.warn("Slack plugin config has no resolvable bot token reference", { companyId });
        return null;
    }
    const token = await resolveStartupSlackToken(ctx, config.slackTokenRef, setRuntimeHealth, companyId);
    if (!token) {
        ctx.logger.warn("Slack plugin runtime disabled because Slack token could not be resolved", { companyId });
        return null;
    }
    // Signing secret is required for inbound webhook verification. Normalize a
    // legacy bare-UUID ref before resolving (the token path does the same) — a
    // current host rejects a raw string ref outright (F4). onWebhook fails closed
    // until it resolves.
    let signingSecret = null;
    if (isUsableSecretRef(config.slackSigningSecretRef)) {
        try {
            const signingRef = normalizeSecretRef(config.slackSigningSecretRef) ?? config.slackSigningSecretRef;
            signingSecret = await ctx.secrets.resolve(signingRef, {
                companyId,
                configPath: "slackSigningSecretRef",
            });
        }
        catch (err) {
            ctx.logger.warn("Slack signing secret could not be resolved — inbound webhook verification is disabled", {
                error: redactSecretRefs(String(err), config.slackSigningSecretRef),
                companyId,
            });
        }
    }
    const rt = {
        companyId,
        config,
        token,
        signingSecret,
        baseUrl: config.paperclipBaseUrl || "http://localhost:3100",
    };
    // Publish as one coherent snapshot, THEN apply the formatter-global side
    // effect and update the legacy mirrors the module-level handlers read. Doing
    // setBaseUrl only here keeps a failed refresh from mutating global state the
    // retained old runtime would be inconsistent with (F6).
    runtime = rt;
    if (config.paperclipBaseUrl)
        setBaseUrl(config.paperclipBaseUrl);
    pluginToken = token;
    pluginConfig = config;
    slackSigningSecret = signingSecret;
    if (!signingSecret) {
        // Outbound works, but every inbound webhook fails closed without the signing
        // secret. Report that honestly instead of leaving health "ok" (F4).
        degradeHealth("Slack bot token resolved, but the signing secret is unavailable — inbound webhooks " +
            "(events, slash commands, interactivity) are rejected until it resolves.", "slack-signing-secret-unresolved", { companyId });
    }
    socketModeClient?.stop();
    socketModeClient = null;
    const appRef = normalizeSecretRef(config.slackAppTokenRef);
    if (appRef) {
        try {
            const appToken = await ctx.secrets.resolve(appRef, { companyId, configPath: "slackAppTokenRef" });
            const client = new SlackSocketModeClient(ctx, appToken, createSocketModeHandlers(createSharedSlackTransportHandlers()));
            socketModeClient = client;
            // Socket callbacks and reconnect timers outlive this configuration delivery.
            void outsideInvocation(() => client.start()).catch((err) => {
                if (socketModeClient !== client)
                    return;
                degradeHealth("Slack Socket Mode failed to start", "slack-socket-start-failed", { companyId });
                ctx.logger.warn("Slack Socket Mode failed to start", {
                    error: redactSecretRefs(String(err), config.slackAppTokenRef), companyId,
                });
            });
        }
        catch (err) {
            degradeHealth("Slack Socket Mode failed to start", "slack-socket-start-failed", { companyId });
            ctx.logger.warn("Slack Socket Mode failed to start", {
                error: redactSecretRefs(String(err), config.slackAppTokenRef), companyId,
            });
        }
    }
    if (config.notifyOnRequestConfirmationCreated === true)
        await resolvePaperclipApiKey(ctx, config, companyId);
    ctx.logger.info("Slack plugin runtime bootstrapped from delivered configuration", { companyId });
    return rt;
}
// --- Slack signature verification ---
function verifySlackSignature(headers, rawBody) {
    if (!slackSigningSecret)
        return false; // fail closed: cannot verify without the signing secret
    const timestamp = String(headers["x-slack-request-timestamp"] ??
        headers["X-Slack-Request-Timestamp"] ?? "");
    const signature = String(headers["x-slack-signature"] ??
        headers["X-Slack-Signature"] ?? "");
    if (!timestamp || !signature)
        return false;
    // Reject requests older than 5 minutes to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300)
        return false;
    const baseString = `v0:${timestamp}:${rawBody}`;
    const hmac = createHmac("sha256", slackSigningSecret)
        .update(baseString)
        .digest("hex");
    const expected = `v0=${hmac}`;
    if (expected.length !== signature.length)
        return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
// --- Helpers ---
async function resolveChannel(ctx, companyId, fallback) {
    const override = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: STATE_KEYS.slackChannel,
    });
    return override ?? fallback ?? null;
}
function parseSlashCommand(rawBody) {
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
function statusBadge(status) {
    const badges = {
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
function genId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
async function readInteractionSlackMessage(companyId, interactionId) {
    return await pluginCtx.state.get({ scopeKind: "company", scopeId: companyId,
        stateKey: STATE_KEYS.interactionSlackMessage(interactionId) });
}
async function writeInteractionSlackMessage(companyId, interactionId, value) {
    await pluginCtx.state.set({ scopeKind: "company", scopeId: companyId,
        stateKey: STATE_KEYS.interactionSlackMessage(interactionId) }, value);
}
// --- Slash command routing ---
async function handleSlashCommand(ctx, rawBody, companyId) {
    const { text, responseUrl, channelId, threadTs } = parseSlashCommand(rawBody);
    const parts = text.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? "";
    const arg = parts[1]?.toLowerCase() ?? "";
    try {
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
                }
                else {
                    const lines = watches.map((w) => `:bell: \`${w.eventPattern}\` -> *${w.agentId}* (triggered ${w.triggerCount}x)`);
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
        await ctx.metrics.write("slack.commands.handled", 1, { command_name: subcommand || "help" });
    }
    catch (err) {
        ctx.logger.warn("Slash command failed", {
            subcommand,
            error: err instanceof Error ? err.message : String(err),
        });
        if (responseUrl) {
            await respondEphemeral(ctx, responseUrl, {
                text: "Something went wrong processing your command. Please try again.",
            });
        }
    }
}
async function handleStatusCommand(ctx, companyId, responseUrl) {
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
async function handleHelpCommand(ctx, responseUrl) {
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
async function handleAgentsCommand(ctx, companyId, responseUrl) {
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
async function handleIssuesCommand(ctx, companyId, responseUrl, filter) {
    const status = filter === "done" ? "done" : filter === "open" ? "todo" : undefined;
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
async function handleApproveCommand(ctx, responseUrl, approvalId) {
    if (!approvalId) {
        await respondEphemeral(ctx, responseUrl, { text: "Usage: `/clip approve <approval-id>`" });
        return;
    }
    try {
        await ctx.http.fetch(`${pluginConfig.paperclipBaseUrl}/api/approvals/${approvalId}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decidedByUserId: "slack:command" }),
        });
        await respondEphemeral(ctx, responseUrl, { text: `:white_check_mark: Approval \`${approvalId}\` approved.` });
        await ctx.metrics.write("slack.approvals.decided", 1, { decision: "approve" });
    }
    catch (err) {
        ctx.logger.warn("Approve command failed", { approvalId, err });
        await respondEphemeral(ctx, responseUrl, { text: `:x: Failed to approve \`${approvalId}\`. Check the ID and try again.` });
    }
}
// --- Shared Slack inbound handlers (webhooks + Socket Mode) ---
function createSharedSlackTransportHandlers() {
    return {
        handleEventsPayload: handleSlackEventsPayload,
        handleSlashCommandBody: async (rawBody) => {
            const rt = ensureRuntime();
            if (rt)
                await handleSlashCommand(pluginCtx, rawBody, rt.companyId);
        },
        handleInteractivityPayload,
    };
}
async function getDefaultCompanyId(_ctx) {
    const rt = ensureRuntime();
    if (!rt)
        throw new Error("Slack runtime has no delivered company");
    return rt.companyId;
}
const INTERACTION_SCAN_STATUSES = [
    "todo",
    "in_progress",
    "in_review",
    "blocked",
];
async function resolvePaperclipApiKey(ctx, config, companyId = runtime?.companyId) {
    const ref = normalizeSecretRef(config.paperclipApiKeyRef);
    if (ref && companyId) {
        try {
            const key = await ctx.secrets.resolve(ref, { companyId, configPath: "paperclipApiKeyRef" });
            if (key) {
                if (runtimeHealth.details?.issue === "slack-confirmation-api-key-unresolved") {
                    setRuntimeHealth({ status: "ok" });
                }
                return key;
            }
        }
        catch (err) {
            ctx.logger.warn("Unable to resolve Paperclip API key secret reference", {
                error: redactSecretRefs(String(err), config.paperclipApiKeyRef), companyId,
            });
        }
    }
    if (config.notifyOnRequestConfirmationCreated === true &&
        (runtimeHealth.status === "ok" || runtimeHealth.details?.issue === "slack-confirmation-api-key-unresolved")) {
        degradeHealth("Issue-thread confirmations are enabled but paperclipApiKeyRef is missing or could not be resolved. Configure a Paperclip API key secret reference.", "slack-confirmation-api-key-unresolved", { companyId });
    }
    return "";
}
async function fetchPaperclipApi(ctx, config, path, init = {}) {
    const apiKey = await resolvePaperclipApiKey(ctx, config);
    if (!apiKey)
        throw new Error("Paperclip API key is not configured");
    const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
    const url = new URL(path, baseUrl).toString();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }
    return fetch(url, { ...init, headers });
}
async function fetchIssueInteractions(ctx, config, issueId) {
    const response = await fetchPaperclipApi(ctx, config, `/api/issues/${encodeURIComponent(issueId)}/interactions`);
    if (!response.ok) {
        throw new Error(`Paperclip interactions fetch failed with ${response.status}`);
    }
    const body = await response.json();
    if (!Array.isArray(body))
        return [];
    return body.filter(isRequestConfirmationInteraction);
}
async function resolveIssueInteraction(ctx, config, issueId, interactionId, accepted) {
    const action = accepted ? "accept" : "reject";
    const response = await fetchPaperclipApi(ctx, config, `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/${action}`, {
        method: "POST",
        body: JSON.stringify(accepted ? {} : { reason: "" }),
    });
    if (!response.ok) {
        throw new Error(`Paperclip interaction ${action} failed with ${response.status}`);
    }
    const body = await response.json();
    if (!isRequestConfirmationInteraction(body)) {
        throw new Error("Paperclip returned an unexpected interaction response");
    }
    return body;
}
async function listInteractionCandidateIssues(ctx, config, companyId) {
    const query = new URLSearchParams({ status: INTERACTION_SCAN_STATUSES.join(",") });
    const response = await fetchPaperclipApi(ctx, config, `/api/companies/${encodeURIComponent(companyId)}/issues?${query.toString()}`);
    if (!response.ok) {
        throw new Error(`Paperclip issue list failed with ${response.status}`);
    }
    const body = await response.json();
    if (!Array.isArray(body))
        return [];
    const byId = new Map();
    for (const issue of body) {
        if (issue && typeof issue === "object" && "id" in issue) {
            const current = issue;
            if (typeof current.id === "string") {
                byId.set(current.id, current);
            }
        }
    }
    return [...byId.values()];
}
async function syncIssueInteractions(ctx, token, config, companyId) {
    if (config.notifyOnRequestConfirmationCreated !== true)
        return;
    const apiKey = await resolvePaperclipApiKey(ctx, config);
    if (!apiKey)
        return;
    const channelId = config.approvalsChannelId || config.defaultChannelId;
    if (!channelId)
        return;
    const issues = await listInteractionCandidateIssues(ctx, config, companyId);
    for (const issue of issues) {
        let interactions = [];
        try {
            interactions = await fetchIssueInteractions(ctx, config, issue.id);
        }
        catch (err) {
            ctx.logger.warn("Unable to fetch issue-thread interactions", {
                issueId: issue.id,
                identifier: issue.identifier,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }
        for (const interaction of interactions) {
            if (!isRequestConfirmationInteraction(interaction))
                continue;
            const sent = await readInteractionSlackMessage(companyId, interaction.id);
            if (interaction.status === "pending") {
                if (sent?.ts)
                    continue;
                const result = await postMessage(ctx, token, channelId, formatRequestConfirmationInteraction(issue, interaction, config.paperclipBaseUrl));
                if (result.ok && result.ts) {
                    await writeInteractionSlackMessage(companyId, interaction.id, { channelId, ts: result.ts, status: interaction.status });
                    await ctx.metrics.write("slack.interactions.sent", 1, { interaction_kind: interaction.kind })
                        .catch(() => undefined);
                }
                continue;
            }
            if (sent?.ts && sent.channelId && sent.status !== interaction.status) {
                await updateMessage(ctx, token, sent.channelId, sent.ts, formatRequestConfirmationStatus(issue, interaction, config.paperclipBaseUrl));
                await writeInteractionSlackMessage(companyId, interaction.id, { ...sent, status: interaction.status });
            }
        }
    }
}
async function handleSlackEventsPayload(body) {
    const event = body.event;
    if (!event)
        return;
    const companyId = await getDefaultCompanyId(pluginCtx).catch((err) => {
        pluginCtx.logger.warn("Unable to resolve company for Slack event", {
            error: err instanceof Error ? err.message : String(err),
        });
        return "";
    });
    if (!companyId)
        return;
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
        if (event.bot_id || (event.subtype && event.subtype !== "file_share"))
            return;
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
async function handleSlackThreadMessageEvent(companyId, event) {
    const channel = String(event.channel ?? event.channel_id ?? "");
    const threadTs = String(event.thread_ts ?? event.ts ?? "");
    const text = String(event.text ?? "");
    const replyToMessageTs = event.ts != null ? String(event.ts) : undefined;
    const files = Array.isArray(event.files) ? event.files : [];
    if (!channel || !threadTs)
        return false;
    return handleThreadMessage(companyId, {
        channel,
        threadTs,
        text,
        replyToMessageTs,
        files,
    });
}
async function handleThreadMessage(companyId, input) {
    if (!input.channel || !input.threadTs)
        return false;
    let handled = false;
    for (const file of input.files) {
        const fileId = String(file.id ?? "");
        const mimetype = String(file.mimetype ?? "");
        if (fileId && isMediaFile(mimetype)) {
            await processMediaFile(pluginCtx, pluginToken, companyId, fileId, input.channel, input.threadTs);
            handled = true;
        }
    }
    if (!input.text)
        return handled;
    const customCommandHandled = await tryCustomCommand(pluginCtx, pluginToken, companyId, input.channel, input.threadTs, input.text);
    if (customCommandHandled)
        return true;
    const routedToAgent = await routeMessageToAgent(pluginCtx, companyId, input.channel, input.threadTs, input.text, input.replyToMessageTs);
    return handled || routedToAgent;
}
async function handleInteractivityPayload(payload) {
    if (payload.type !== "block_actions")
        return;
    const actions = payload.actions;
    const responseUrl = String(payload.response_url ?? "");
    const user = payload.user;
    const userId = user ? String(user.id ?? user.username ?? "unknown") : "unknown";
    if (!actions?.length || !responseUrl)
        return;
    const action = actions[0];
    const actionId = String(action.action_id ?? "");
    const actionValue = String(action.value ?? "");
    if (!actionValue)
        return;
    const companyId = await getDefaultCompanyId(pluginCtx).catch((err) => {
        pluginCtx.logger.warn("Unable to resolve company for Slack interaction", {
            error: err instanceof Error ? err.message : String(err),
        });
        return "";
    });
    if (!companyId)
        return;
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
        const live = pluginConfig;
        try {
            const issue = await pluginCtx.issues.get(ref.issueId, companyId);
            if (!issue || issue.companyId !== companyId)
                throw new Error("Confirmation issue is outside this installation's company");
            const latest = (await fetchIssueInteractions(pluginCtx, live, ref.issueId))
                .find((candidate) => candidate.id === ref.interactionId);
            if (!latest)
                throw new Error("Confirmation is no longer available");
            if (latest.status !== "pending") {
                await respondToAction(pluginCtx, pluginToken, responseUrl, formatRequestConfirmationStatus(issue, latest, live.paperclipBaseUrl));
                return;
            }
            if ((accepted && latest.kind === "request_checkbox_confirmation") ||
                (!accepted && latest.payload?.rejectRequiresReason === true)) {
                await respondToAction(pluginCtx, pluginToken, responseUrl, formatRequestConfirmationInteraction(issue, latest, live.paperclipBaseUrl));
                return;
            }
            const existing = await readInteractionSlackMessage(companyId, ref.interactionId);
            const interaction = await resolveIssueInteraction(pluginCtx, live, ref.issueId, ref.interactionId, accepted);
            const resolvedMessage = formatRequestConfirmationStatus({
                id: ref.issueId,
                identifier: issue.identifier,
                title: issue.title,
            }, interaction, live.paperclipBaseUrl, userId);
            await respondToAction(pluginCtx, pluginToken, responseUrl, resolvedMessage).catch(() => undefined);
            if (existing) {
                await updateMessage(pluginCtx, pluginToken, existing.channelId, existing.ts, resolvedMessage);
                await writeInteractionSlackMessage(companyId, ref.interactionId, { ...existing, status: interaction.status });
            }
            await pluginCtx.metrics.write("slack.interactions.resolved", 1, {
                decision: accepted ? "accept" : "reject",
            }).catch(() => undefined);
        }
        catch (err) {
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
    if (actionId === "approval_approve" || actionId === "approval_reject") {
        const approved = actionId === "approval_approve";
        const endpoint = approved ? "approve" : "reject";
        try {
            await pluginCtx.http.fetch(`${pluginConfig.paperclipBaseUrl}/api/approvals/${actionValue}/${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decidedByUserId: `slack:${userId}` }),
            });
            await respondToAction(pluginCtx, pluginToken, responseUrl, formatApprovalResolved(actionValue, approved, userId));
            await pluginCtx.metrics.write("slack.approvals.decided", 1, { decision: endpoint });
        }
        catch (err) {
            pluginCtx.logger.warn("Failed to handle approval action", { err, approvalId: actionValue });
        }
        return;
    }
    if (actionId === "escalation_use_suggested" ||
        actionId === "escalation_reply" ||
        actionId === "escalation_override" ||
        actionId === "escalation_dismiss") {
        try {
            const record = await pluginCtx.state.get({
                scopeKind: "company",
                scopeId: companyId,
                stateKey: STATE_KEYS.escalationRecord(actionValue),
            });
            if (record) {
                await pluginCtx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationRecord(actionValue) }, { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolvedBy: `slack:${userId}` });
            }
            await respondToAction(pluginCtx, pluginToken, responseUrl, formatEscalationResolved(actionValue, actionId, userId));
            await pluginCtx.metrics.write("slack.escalations.resolved", 1, { action: actionId });
        }
        catch (err) {
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
        }
        catch (err) {
            pluginCtx.logger.warn("Failed to handle handoff action", { err, handoffId: actionValue });
        }
        return;
    }
    if (actionId === "discussion_continue" || actionId === "discussion_stop") {
        try {
            const discAction = actionId === "discussion_continue" ? "continue" : "stop";
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
        }
        catch (err) {
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
        pluginCtx = ctx;
        // Handlers are registered unconditionally and synchronously — the SDK
        // requires every registration to complete within setup(). The company-
        // scoped config that used to gate them is unreadable here (it arrives only
        // via onConfigChanged), so each handler starts with ensureRuntime() and
        // no-ops until a configuration delivery has built the runtime.
        // =========================================================================
        // PHASE 1: Escalation - using 3-arg ctx.tools.register with ToolRunContext
        // =========================================================================
        ctx.tools.register("escalate_to_human", {
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
        }, async (params, runCtx) => {
            const p = params;
            const companyId = runCtx.companyId;
            const rt = ensureRuntime(companyId);
            if (!rt)
                return { error: "Slack plugin is not configured yet" };
            const escalationId = genId("esc");
            const record = {
                id: escalationId,
                reason: String(p.reason ?? ""),
                confidence: p.confidence != null ? Number(p.confidence) : undefined,
                agentName: p.agentName != null ? String(p.agentName) : undefined,
                conversationHistory: p.conversationHistory,
                agentReasoning: p.agentReasoning != null ? String(p.agentReasoning) : undefined,
                suggestedReply: p.suggestedReply != null ? String(p.suggestedReply) : undefined,
                status: "open",
                createdAt: new Date().toISOString(),
            };
            const channelId = rt.config.escalationChatId || rt.config.approvalsChannelId || rt.config.defaultChannelId;
            if (!channelId) {
                return { error: "No escalation channel configured" };
            }
            const message = formatEscalationMessage(record);
            const result = await postMessage(ctx, rt.token, channelId, message);
            if (result.ok && result.ts) {
                await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationTs(escalationId) }, result.ts);
                await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationChannel(escalationId) }, channelId);
                await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.escalationRecord(escalationId) }, record);
                await ctx.activity.log({
                    companyId,
                    message: `Escalation posted to Slack: ${record.reason}`,
                    entityType: "plugin",
                    entityId: escalationId,
                });
                await ctx.metrics.write("slack.escalations.created", 1);
            }
            if (rt.config.escalationHoldMessage) {
                return { content: JSON.stringify({ escalationId, holdMessage: rt.config.escalationHoldMessage }) };
            }
            return { content: JSON.stringify({ escalationId }) };
        });
        // =========================================================================
        // PHASE 2: Multi-Agent - handoff and discuss tools
        // =========================================================================
        ctx.tools.register("handoff_to_agent", {
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
        }, async (params, runCtx) => {
            const p = params;
            const companyId = runCtx.companyId;
            const rt = ensureRuntime(companyId);
            if (!rt)
                return { error: "Slack plugin is not configured yet" };
            const fromAgent = String(p.fromAgent ?? "");
            const toAgent = String(p.toAgent ?? "");
            const reason = String(p.reason ?? "");
            const channelId = String(p.channelId ?? "");
            const threadTs = String(p.threadTs ?? "");
            const context = p.context != null ? String(p.context) : undefined;
            const handoffId = genId("hoff");
            await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.handoff(handoffId) }, {
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
            });
            const blocks = buildHandoffBlocks(fromAgent, toAgent, reason, handoffId);
            await postMessage(ctx, rt.token, channelId, {
                text: `Handoff: ${fromAgent} -> ${toAgent}: ${reason}`,
                blocks,
            }, threadTs ? { threadTs } : undefined);
            return { content: JSON.stringify({ handoffId, status: "pending" }) };
        });
        ctx.tools.register("discuss_with_agent", {
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
        }, async (params, runCtx) => {
            const p = params;
            const companyId = runCtx.companyId;
            const rt = ensureRuntime(companyId);
            if (!rt)
                return { error: "Slack plugin is not configured yet" };
            const result = await startDiscussion(ctx, rt.token, companyId, {
                initiatorAgent: String(p.initiatorAgent ?? ""),
                targetAgent: String(p.targetAgent ?? ""),
                topic: String(p.topic ?? ""),
                channelId: String(p.channelId ?? ""),
                threadTs: String(p.threadTs ?? ""),
                maxTurns: Number(p.maxTurns ?? 10),
            });
            return { content: JSON.stringify(result) };
        });
        // =========================================================================
        // PHASE 3: Media Pipeline tool
        // =========================================================================
        ctx.tools.register("process_media", {
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
        }, async (params, runCtx) => {
            const p = params;
            const rt = ensureRuntime(runCtx.companyId);
            if (!rt)
                return { error: "Slack plugin is not configured yet" };
            const result = await processMediaFile(ctx, rt.token, runCtx.companyId, String(p.fileId), String(p.channelId), String(p.threadTs), p.briefAgentId ? String(p.briefAgentId) : undefined);
            if (!result) {
                return { error: "Failed to process media file" };
            }
            return { content: JSON.stringify(result) };
        });
        // =========================================================================
        // PHASE 4: Custom Commands tool
        // =========================================================================
        ctx.tools.register("register_command", {
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
        }, async (params, runCtx) => {
            const p = params;
            const rt = ensureRuntime(runCtx.companyId);
            if (!rt)
                return { error: "Slack plugin is not configured yet" };
            const command = {
                name: String(p.name),
                description: String(p.description),
                usage: String(p.usage),
                steps: p.steps ?? [],
            };
            const ok = await registerCommand(ctx, runCtx.companyId, command);
            return { content: JSON.stringify({ registered: ok, name: command.name }) };
        });
        // =========================================================================
        // PHASE 5: Proactive Suggestions tool
        // =========================================================================
        ctx.tools.register("register_watch", {
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
        }, async (params, runCtx) => {
            const p = params;
            const rt = ensureRuntime(runCtx.companyId);
            if (!rt)
                return { error: "Slack plugin is not configured yet" };
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
        });
        ctx.tools.register("remove_watch", {
            displayName: "Remove Event Watch",
            description: "Removes a registered event watch by ID.",
            parametersSchema: {
                type: "object",
                properties: {
                    watchId: { type: "string", description: "Watch ID to remove" },
                },
                required: ["watchId"],
            },
        }, async (params, runCtx) => {
            const p = params;
            const rt = ensureRuntime(runCtx.companyId);
            if (!rt)
                return { error: "Slack plugin is not configured yet" };
            const removed = await removeWatch(ctx, String(p.watchId), runCtx.companyId);
            return { content: JSON.stringify({ removed, watchId: String(p.watchId) }) };
        });
        ctx.tools.register("list_watch_templates", {
            displayName: "List Watch Templates",
            description: "Lists built-in watch templates for common use cases like sales follow-ups, deal monitoring, and error diagnosis.",
            parametersSchema: {
                type: "object",
                properties: {},
            },
        }, async (_params, runCtx) => {
            const rt = ensureRuntime(runCtx.companyId);
            if (!rt)
                return { error: "Slack plugin is not configured yet" };
            const templates = BUILTIN_WATCH_TEMPLATES.map((t) => ({
                name: t.name,
                eventPattern: t.eventPattern,
                description: t.description,
            }));
            return { content: JSON.stringify({ templates }) };
        });
        // =========================================================================
        // Notification helper (supports per-type channel override + threading)
        // =========================================================================
        const notify = async (event, formatter, overrideChannelId, opts) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const fallback = overrideChannelId || rt.config.defaultChannelId;
            const channelId = await resolveChannel(ctx, event.companyId, fallback);
            if (!channelId)
                return;
            const result = await postMessage(ctx, rt.token, channelId, formatter(event), opts);
            if (result.ok) {
                await ctx.activity.log({
                    companyId: event.companyId,
                    message: `Forwarded ${event.eventType} to Slack`,
                    entityType: "plugin",
                    entityId: event.entityId,
                });
                await ctx.metrics.write("slack.notifications.sent", 1, { event_type: event.eventType });
            }
            else {
                await ctx.metrics.write("slack.notifications.failed", 1, { event_type: event.eventType, error_code: result.error ?? "unknown" });
            }
            return result;
        };
        // =========================================================================
        // Core event subscriptions (existing notifications)
        // =========================================================================
        // Handlers are always registered so that config changes (e.g. toggling
        // notifyOnAgentConnected) take effect without a plugin restart.
        ctx.events.on("issue.created", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const live = rt.config;
            if (!live.notifyOnIssueCreated)
                return;
            const result = await notify(event, formatIssueCreated);
            if (result?.ok && result.ts) {
                await ctx.state.set({ scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.threadIssue(event.entityId ?? "") }, result.ts);
            }
        });
        ctx.events.on("issue.updated", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const live = rt.config;
            if (!live.notifyOnIssueDone)
                return;
            const payload = event.payload;
            if (payload.status !== "done")
                return;
            const threadTs = await ctx.state.get({
                scopeKind: "company",
                scopeId: event.companyId,
                stateKey: STATE_KEYS.threadIssue(event.entityId ?? ""),
            });
            await notify(event, formatIssueDone, undefined, threadTs ? { threadTs } : undefined);
        });
        ctx.events.on("approval.created", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const live = rt.config;
            if (!live.notifyOnApprovalCreated)
                return;
            await notify(event, formatApprovalCreated, live.approvalsChannelId);
        });
        ctx.events.on("agent.run.failed", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const live = rt.config;
            if (!live.notifyOnAgentError)
                return;
            await notify(event, formatAgentError, live.errorsChannelId);
        });
        ctx.events.on("agent.status_changed", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const live = rt.config;
            if (!live.notifyOnAgentConnected)
                return;
            const payload = event.payload;
            if (payload.status === "active" || payload.status === "online") {
                await notify(event, formatAgentConnected, live.pipelineChannelId);
            }
        });
        ctx.events.on("agent.run.finished", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const live = rt.config;
            if (!live.notifyOnAgentConnected)
                return;
            const payload = event.payload;
            // Dedup on agent id, not run id — event.entityId is the run UUID for
            // agent.run.finished, so using it produces a unique key every run.
            const agentId = String(payload.agentId ?? event.entityId ?? "");
            const key = STATE_KEYS.firstRunNotified(agentId);
            const alreadyNotified = await ctx.state.get({
                scopeKind: "company",
                scopeId: event.companyId,
                stateKey: key,
            });
            if (alreadyNotified)
                return;
            await ctx.state.set({ scopeKind: "company", scopeId: event.companyId, stateKey: key }, true);
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
        ctx.events.on("cost_event.created", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const live = rt.config;
            if (!live.notifyOnBudgetThreshold)
                return;
            const payload = event.payload;
            const pct = Number(payload.percentUsed ?? 0);
            if (pct < 80)
                return;
            const bucket = pct >= 100 ? 100 : pct >= 90 ? 90 : 80;
            const key = STATE_KEYS.budgetAlert(event.entityId ?? "", bucket);
            const alreadySent = await ctx.state.get({
                scopeKind: "company",
                scopeId: event.companyId,
                stateKey: key,
            });
            if (alreadySent)
                return;
            await ctx.state.set({ scopeKind: "company", scopeId: event.companyId, stateKey: key }, true);
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
            return { channelId: saved ?? ensureRuntime(companyId)?.config.defaultChannelId ?? "" };
        });
        ctx.actions.register("set-channel", async (params) => {
            const companyId = String(params.companyId);
            const channelId = String(params.channelId);
            await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.slackChannel }, channelId);
            ctx.logger.info("Updated Slack channel mapping", { companyId, channelId });
            return { ok: true };
        });
        // =========================================================================
        // Jobs
        // =========================================================================
        // Daily digest — always registered; the enableDailyDigest flag is checked
        // inside each handler against the delivered runtime config, because config
        // is not readable at setup time under company scoping.
        {
            ctx.jobs.register("daily-digest", async () => {
                const rt = ensureRuntime();
                if (!rt || !rt.config.enableDailyDigest)
                    return;
                // Single-tenant: this worker serves only its owner. Iterating every
                // visible company would read their data and post it with the OWNER's
                // token/config (F2). Operate strictly on rt.companyId.
                const companies = [{ id: rt.companyId }];
                for (const company of companies) {
                    const channelId = await resolveChannel(ctx, company.id, rt.config.defaultChannelId);
                    if (!channelId)
                        continue;
                    const issues = await ctx.issues.list({ companyId: company.id, limit: 200, offset: 0 });
                    const now = new Date();
                    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    let tasksCompleted = 0;
                    let tasksCreated = 0;
                    for (const issue of issues) {
                        const updated = new Date(issue.updatedAt);
                        const created = new Date(issue.createdAt);
                        if (issue.status === "done" && updated >= dayAgo)
                            tasksCompleted++;
                        if (created >= dayAgo)
                            tasksCreated++;
                    }
                    const agents = await ctx.agents.list({ companyId: company.id, limit: 100, offset: 0 });
                    const agentsActive = agents.filter((a) => a.status === "active" || a.status === "running").length;
                    const dateKey = now.toISOString().slice(0, 10);
                    const dailyCost = await ctx.state.get({
                        scopeKind: "company",
                        scopeId: company.id,
                        stateKey: STATE_KEYS.dailyCost(dateKey),
                    });
                    const totalCost = dailyCost ? String(dailyCost.toFixed(2)) : "0.00";
                    const topAgentCosts = await ctx.state.get({
                        scopeKind: "company",
                        scopeId: company.id,
                        stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
                    });
                    let topAgent = "";
                    if (topAgentCosts && typeof topAgentCosts === "object") {
                        const costs = topAgentCosts;
                        let maxCost = 0;
                        for (const [name, cost] of Object.entries(costs)) {
                            if (cost > maxCost) {
                                maxCost = cost;
                                topAgent = name;
                            }
                        }
                    }
                    await postMessage(ctx, rt.token, channelId, formatDailyDigest({
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
            ctx.events.on("cost_event.created", async (event) => {
                const rt = ensureRuntime(event.companyId);
                if (!rt || !rt.config.enableDailyDigest)
                    return;
                const payload = event.payload;
                const cost = Number(payload.cost ?? 0);
                if (cost <= 0)
                    return;
                const dateKey = new Date().toISOString().slice(0, 10);
                const currentTotal = await ctx.state.get({
                    scopeKind: "company",
                    scopeId: event.companyId,
                    stateKey: STATE_KEYS.dailyCost(dateKey),
                });
                await ctx.state.set({ scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.dailyCost(dateKey) }, (currentTotal ?? 0) + cost);
                const agentName = String(payload.agentName ?? payload.name ?? event.entityId);
                const agentCosts = await ctx.state.get({
                    scopeKind: "company",
                    scopeId: event.companyId,
                    stateKey: STATE_KEYS.dailyAgentCosts(dateKey),
                });
                const costs = agentCosts ?? {};
                costs[agentName] = (costs[agentName] ?? 0) + cost;
                await ctx.state.set({ scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.dailyAgentCosts(dateKey) }, costs);
            });
            ctx.logger.info("Daily digest job registered (9am daily)");
        }
        // Escalation timeout job
        ctx.jobs.register("check-escalation-timeouts", async () => {
            const rt = ensureRuntime();
            if (!rt)
                return;
            // Single-tenant: this worker serves only its owner. Iterating every
            // visible company would read their data and post it with the OWNER's
            // token/config (F2). Operate strictly on rt.companyId.
            const companies = [{ id: rt.companyId }];
            const timeoutMs = rt.config.escalationTimeoutMs ?? 900000;
            const now = Date.now();
            for (const company of companies) {
                const openEscalationsRaw = await ctx.state.get({
                    scopeKind: "company",
                    scopeId: company.id,
                    stateKey: "escalation-records-index",
                });
                const escalationIds = Array.isArray(openEscalationsRaw) ? openEscalationsRaw : [];
                for (const escalationKey of escalationIds) {
                    const record = await ctx.state.get({
                        scopeKind: "company",
                        scopeId: company.id,
                        stateKey: STATE_KEYS.escalationRecord(escalationKey),
                    });
                    if (!record || record.status !== "open")
                        continue;
                    const createdAt = new Date(String(record.createdAt)).getTime();
                    if (now - createdAt < timeoutMs)
                        continue;
                    const escalationId = String(record.id);
                    const defaultAction = rt.config.escalationDefaultAction ?? "defer";
                    await ctx.state.set({ scopeKind: "company", scopeId: company.id, stateKey: STATE_KEYS.escalationRecord(escalationId) }, { ...record, status: "timed_out", resolvedAt: new Date().toISOString(), resolvedBy: "system:timeout" });
                    const channelId = await ctx.state.get({
                        scopeKind: "company",
                        scopeId: company.id,
                        stateKey: STATE_KEYS.escalationChannel(escalationId),
                    });
                    const threadTs = await ctx.state.get({
                        scopeKind: "company",
                        scopeId: company.id,
                        stateKey: STATE_KEYS.escalationTs(escalationId),
                    });
                    if (channelId && threadTs) {
                        await postMessage(ctx, rt.token, channelId, {
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
            const rt = ensureRuntime();
            if (rt)
                await syncIssueInteractions(ctx, rt.token, rt.config, rt.companyId);
        });
        // Phase 5: Check watches job
        ctx.jobs.register("check-watches", async () => {
            const rt = ensureRuntime();
            if (!rt)
                return;
            // Single-tenant: this worker serves only its owner. Iterating every
            // visible company would read their data and post it with the OWNER's
            // token/config (F2). Operate strictly on rt.companyId.
            const companies = [{ id: rt.companyId }];
            for (const company of companies) {
                // Get recent events from state (populated by event listeners below)
                const recentEventsRaw = await ctx.state.get({
                    scopeKind: "company",
                    scopeId: company.id,
                    stateKey: "recent-watch-events",
                });
                const recentEvents = Array.isArray(recentEventsRaw)
                    ? recentEventsRaw
                    : [];
                if (recentEvents.length > 0) {
                    await checkWatches(ctx, rt.token, company.id, recentEvents);
                    // Clear after processing
                    await ctx.state.set({ scopeKind: "company", scopeId: company.id, stateKey: "recent-watch-events" }, []);
                }
            }
        });
        // =========================================================================
        // Agent output listeners (native streaming + ACP events)
        // =========================================================================
        // Native agent streaming output
        ctx.events.on("plugin.paperclip-plugin-slack.agent-stream-chunk", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const p = event.payload;
            await handleAgentOutput(ctx, rt.token, event.companyId, {
                channel: String(p.channel ?? ""),
                threadTs: String(p.threadTs ?? ""),
                text: String(p.text ?? ""),
                agentName: p.agentName != null ? String(p.agentName) : undefined,
                agentDisplayName: p.agentDisplayName != null ? String(p.agentDisplayName) : undefined,
                toolName: p.toolName != null ? String(p.toolName) : undefined,
            });
        });
        // ACP output events (from cross-plugin)
        ctx.events.on(`plugin.paperclip-plugin-acp.output`, async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const p = event.payload;
            await handleAgentOutput(ctx, rt.token, event.companyId, {
                channel: String(p.channel ?? ""),
                threadTs: String(p.threadTs ?? ""),
                text: String(p.text ?? ""),
                agentName: p.agentName != null ? String(p.agentName) : undefined,
                agentDisplayName: p.agentDisplayName != null ? String(p.agentDisplayName) : undefined,
                toolName: p.toolName != null ? String(p.toolName) : undefined,
            });
        });
        // Escalation thread reply routing (from Slack Events API)
        ctx.events.on("plugin.slack.thread_reply_escalation", async (event) => {
            if (!ensureRuntime(event.companyId))
                return;
            const p = event.payload;
            const escalationId = String(p.escalationId ?? "");
            const replyText = String(p.text ?? "");
            const userId = String(p.userId ?? "unknown");
            if (!escalationId || !replyText)
                return;
            const record = await ctx.state.get({
                scopeKind: "company",
                scopeId: event.companyId,
                stateKey: STATE_KEYS.escalationRecord(escalationId),
            });
            if (record) {
                await ctx.state.set({ scopeKind: "company", scopeId: event.companyId, stateKey: STATE_KEYS.escalationRecord(escalationId) }, { ...record, status: "resolved", resolvedAt: new Date().toISOString(), resolvedBy: `slack:${userId}` });
            }
            // Route reply to agent session if we have one
            if (record?.sessionId && record?.agentName) {
                const sessions = await ctx.state.get({
                    scopeKind: "company",
                    scopeId: event.companyId,
                    stateKey: STATE_KEYS.sessionRegistry(String(record.channelId ?? ""), String(record.threadTs ?? "")),
                });
                // Find session and send reply back
                if (Array.isArray(sessions)) {
                    const session = sessions.find((s) => s.agentName === String(record.agentName) && s.status === "active");
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
        ctx.events.on("plugin.slack.thread_message", async (event) => {
            const rt = ensureRuntime(event.companyId);
            if (!rt)
                return;
            const p = event.payload;
            await handleThreadMessage(event.companyId, {
                channel: String(p.channel ?? ""),
                threadTs: String(p.threadTs ?? ""),
                text: String(p.text ?? ""),
                replyToMessageTs: p.replyToMessageTs != null ? String(p.replyToMessageTs) : undefined,
                files: Array.isArray(p.files) ? p.files : [],
            });
        });
        // Collect events for watch checking (Phase 5)
        const watchableEvents = [
            "issue.created", "issue.updated",
            "agent.run.failed", "agent.run.finished", "agent.status_changed",
            "cost_event.created", "approval.created",
        ];
        for (const eventType of watchableEvents) {
            ctx.events.on(eventType, async (event) => {
                if (!ensureRuntime(event.companyId))
                    return;
                const recentEventsRaw = await ctx.state.get({
                    scopeKind: "company",
                    scopeId: event.companyId,
                    stateKey: "recent-watch-events",
                });
                const recentEvents = Array.isArray(recentEventsRaw)
                    ? recentEventsRaw
                    : [];
                // Keep last 100 events
                recentEvents.push({
                    eventType: event.eventType,
                    payload: event.payload,
                });
                if (recentEvents.length > 100) {
                    recentEvents.splice(0, recentEvents.length - 100);
                }
                await ctx.state.set({ scopeKind: "company", scopeId: event.companyId, stateKey: "recent-watch-events" }, recentEvents);
            });
        }
        ctx.logger.info("Slack Chat OS plugin handlers registered; waiting for delivered configuration");
    },
    /**
     * The host delivers stored config here — at worker startup and on every save —
     * and, from SDK v2026.817.0, with its company scope. Before then the config
     * arrives with no scope; probe for the delivered company inside this
     * invocation (only the delivered company answers a scoped config read).
     */
    async onConfigChanged(newConfig, context) {
        const ctx = pluginCtx;
        if (!ctx)
            return;
        await queueBootstrap(async () => {
            let companyId = context?.companyId ?? null;
            if (!companyId) {
                const running = runtime;
                if (running) {
                    // Do NOT assume a context-less delivery belongs to the running
                    // company: probe it, and if it does not answer this delivery belongs
                    // to somebody else — leave the running company untouched.
                    const ownConfig = await readScopedConfig(ctx, running.companyId);
                    if (ownConfig) {
                        companyId = running.companyId;
                    }
                    else {
                        const other = await identifyDeliveredCompany(ctx, newConfig);
                        ctx.logger.warn(other
                            ? `Slack plugin ignoring configuration for company ${other}; this install serves ${running.companyId}`
                            : `Slack plugin ignoring a configuration delivery it could not attribute; this install serves ${running.companyId}`, { runningCompanyId: running.companyId, deliveredCompanyId: other });
                        return;
                    }
                }
                else {
                    companyId = await identifyDeliveredCompany(ctx, newConfig);
                }
                if (companyId) {
                    ctx.logger.info("Config delivered without a company scope; identified it by scoped probe", { companyId });
                }
            }
            if (!companyId) {
                degradeHealth("Configuration was delivered without a company scope and no company answered a scoped " +
                    "configuration read, so its secrets cannot be resolved. Upgrade the host to v2026.817.0 or newer.", "slack-config-scope-unknown");
                return;
            }
            try {
                await bootstrapRuntime(ctx, companyId, newConfig);
            }
            catch (err) {
                const error = String(err);
                ctx.logger.error("Slack plugin failed to apply a configuration change", { error, companyId });
                degradeHealth(`Applying the delivered configuration failed: ${error}`, "slack-config-apply-failed", { companyId });
            }
        });
    },
    // =========================================================================
    // Webhook handler (Slack Events, Slash Commands, Interactivity)
    // =========================================================================
    async onWebhook(input) {
        // Verify Slack request signature (skip for url_verification challenge)
        const body = input.parsedBody;
        // Scope the signature exemption to a url_verification body on the Events
        // endpoint ONLY. Otherwise an attacker sends a slash-command / interactivity
        // request whose parsed body carries type=url_verification and skips
        // signature verification entirely (F1).
        const isVerificationChallenge = input.endpointKey === WEBHOOK_KEYS.slackEvents && body?.type === "url_verification";
        const rt = ensureRuntime();
        if (!rt) {
            // Not bootstrapped: no signing secret to verify with and no token to act
            // on. Only the Slack URL-verification handshake needs no runtime.
            if (isVerificationChallenge)
                return;
            pluginCtx.logger.warn("Rejecting webhook: Slack plugin is not configured yet");
            return;
        }
        if (!isVerificationChallenge && !verifySlackSignature(input.headers, input.rawBody)) {
            pluginCtx.logger.warn("Rejected webhook: invalid Slack signature");
            return;
        }
        await dispatchSlackWebhook(input, createSharedSlackTransportHandlers());
    },
    async onShutdown() {
        socketModeClient?.stop();
        socketModeClient = null;
    },
    async onValidateConfig(config) {
        const errors = validateSecretRefFields(config);
        if (!config.defaultChannelId ||
            typeof config.defaultChannelId !== "string" ||
            config.defaultChannelId.trim().length === 0) {
            errors.push("defaultChannelId is required.");
        }
        return errors.length > 0 ? { ok: false, errors } : { ok: true };
    },
    async onHealth() {
        return runtimeHealth;
    },
});
export default plugin;
runWorker(plugin, import.meta.url);
//# sourceMappingURL=worker.js.map