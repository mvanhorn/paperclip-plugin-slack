import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { SlackBlock, SlackMessage } from "./slack-api.js";
import { postMessage } from "./slack-api.js";
import { DEFAULT_CONFIG } from "./constants.js";

type AcpPayload = Record<string, unknown>;

const ACP_BIND_PREFIX = "acp-bind-";
const SESSIONS_PREFIX = "sessions_";
const OUTPUT_QUEUE_PREFIX = "output-queue_";
const DISCUSSION_PREFIX = "discussion_";

// --- Session types ---

export interface AgentSession {
  sessionId: string;
  agentName: string;
  agentDisplayName: string;
  spawnedAt: string;
  status: "active" | "closed";
  lastActivityAt: string;
}

export interface DiscussionLoop {
  id: string;
  channelId: string;
  threadTs: string;
  initiatorAgent: string;
  targetAgent: string;
  reason: string;
  turns: number;
  maxTurns: number;
  status: "active" | "paused" | "completed" | "stale";
  lastTurnAt: string;
  createdAt: string;
}

// --- Formatting ---

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

  // Split on fenced code blocks to render them separately
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

// --- State key helpers ---

function bindingKey(channel: string, threadTs: string): string {
  return `${ACP_BIND_PREFIX}${channel}-${threadTs}`;
}

function sessionsKey(channelId: string, threadTs: string): string {
  return `${SESSIONS_PREFIX}${channelId}_${threadTs}`;
}

function outputQueueKey(channelId: string, threadTs: string): string {
  return `${OUTPUT_QUEUE_PREFIX}${channelId}_${threadTs}`;
}

function discussionKey(id: string): string {
  return `${DISCUSSION_PREFIX}${id}`;
}

// --- Session helpers ---

async function getSessions(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
): Promise<AgentSession[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: sessionsKey(channelId, threadTs),
  });
  if (Array.isArray(raw)) return raw as AgentSession[];
  return [];
}

async function setSessions(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  sessions: AgentSession[],
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: sessionsKey(channelId, threadTs) },
    sessions,
  );
}

function findMostRecentActive(sessions: AgentSession[]): AgentSession | undefined {
  const active = sessions.filter((s) => s.status === "active");
  if (active.length === 0) return undefined;
  return active.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  )[0];
}

async function touchSession(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  agentName: string,
): Promise<void> {
  const sessions = await getSessions(ctx, companyId, channelId, threadTs);
  const session = sessions.find((s) => s.agentName === agentName && s.status === "active");
  if (session) {
    session.lastActivityAt = new Date().toISOString();
    await setSessions(ctx, companyId, channelId, threadTs, sessions);
  }
}

// --- Message routing ---

function parseAtMention(text: string): string | null {
  const match = text.match(/@(\w[\w.-]*)/);
  return match ? match[1].toLowerCase() : null;
}

async function resolveTargetAgent(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  text: string,
  replyToAgentName?: string,
): Promise<AgentSession | undefined> {
  const sessions = await getSessions(ctx, companyId, channelId, threadTs);
  const active = sessions.filter((s) => s.status === "active");
  if (active.length === 0) return undefined;

  // 1. Check @mention
  const mentioned = parseAtMention(text);
  if (mentioned) {
    const match = active.find(
      (s) => s.agentName.toLowerCase() === mentioned || s.agentDisplayName.toLowerCase() === mentioned,
    );
    if (match) return match;
  }

  // 2. Check reply-to agent
  if (replyToAgentName) {
    const match = active.find((s) => s.agentName === replyToAgentName);
    if (match) return match;
  }

  // 3. Fallback: most recently active
  return findMostRecentActive(active);
}

// --- Output sequencing ---

interface QueuedOutput {
  agentName: string;
  agentDisplayName: string;
  text: string;
  toolName?: string;
  queuedAt: string;
}

const activeSpeakers = new Map<string, string>();

async function enqueueOutput(
  ctx: PluginContext,
  companyId: string,
  channelId: string,
  threadTs: string,
  output: QueuedOutput,
): Promise<void> {
  const key = outputQueueKey(channelId, threadTs);
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: key,
  });
  const queue: QueuedOutput[] = Array.isArray(raw) ? (raw as QueuedOutput[]) : [];
  queue.push(output);
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: key },
    queue,
  );
}

async function drainOutputQueue(
  ctx: PluginContext,
  token: string,
  companyId: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  const lockKey = `${channelId}_${threadTs}`;
  if (activeSpeakers.has(lockKey)) return;

  const key = outputQueueKey(channelId, threadTs);

  while (true) {
    const raw = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: key,
    });
    const queue: QueuedOutput[] = Array.isArray(raw) ? (raw as QueuedOutput[]) : [];
    if (queue.length === 0) break;

    const item = queue.shift()!;
    activeSpeakers.set(lockKey, item.agentName);

    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: key },
      queue,
    );

    const labelBlock: SlackBlock = {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*[${item.agentDisplayName}]*` },
      ],
    };
    const contentBlocks = formatAsBlocks(item.text, item.toolName);
    const allBlocks = [labelBlock, ...contentBlocks];

    const message: SlackMessage = {
      text: `[${item.agentDisplayName}] ${item.text.slice(0, 200)}`,
      blocks: allBlocks,
    };

    const result = await postMessage(ctx, token, channelId, message, { threadTs });
    if (result.ok && result.ts) {
      await ctx.state.set(
        {
          scopeKind: "company",
          scopeId: companyId,
          stateKey: `msg-agent-${channelId}-${result.ts}`,
        },
        item.agentName,
      );
    }

    activeSpeakers.delete(lockKey);
  }
}

// --- Slash commands ---

export async function handleAcpSlashCommand(
  ctx: PluginContext,
  payload: { channel: string; threadTs: string; text: string; companyId: string },
): Promise<void> {
  const subArgs = payload.text.trim().split(/\s+/);
  const sub = subArgs[0]?.toLowerCase() ?? "";

  // Legacy bind/unbind (single agent)
  if (sub === "bind") {
    const agentId = subArgs[1];
    if (!agentId) {
      ctx.logger.warn("acp bind requires an agent ID");
      return;
    }

    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: payload.companyId,
        stateKey: bindingKey(payload.channel, payload.threadTs),
      },
      agentId,
    );
    ctx.logger.info("ACP session bound", {
      channel: payload.channel,
      threadTs: payload.threadTs,
      agentId,
    });
    return;
  }

  if (sub === "unbind") {
    await ctx.state.set(
      {
        scopeKind: "company",
        scopeId: payload.companyId,
        stateKey: bindingKey(payload.channel, payload.threadTs),
      },
      null,
    );
    ctx.logger.info("ACP session unbound", {
      channel: payload.channel,
      threadTs: payload.threadTs,
    });
    return;
  }

  // Multi-agent: spawn
  if (sub === "spawn") {
    const agentName = subArgs[1];
    if (!agentName) {
      ctx.logger.warn("acp spawn requires an agent name");
      return;
    }

    const displayName = subArgs[2] ?? agentName;
    const sessions = await getSessions(ctx, payload.companyId, payload.channel, payload.threadTs);
    const maxAgents = DEFAULT_CONFIG.maxAgentsPerThread;

    const activeSessions = sessions.filter((s) => s.status === "active");
    if (activeSessions.length >= maxAgents) {
      ctx.logger.warn("Max agents per thread reached", {
        channel: payload.channel,
        threadTs: payload.threadTs,
        max: maxAgents,
      });
      return;
    }

    const existing = activeSessions.find((s) => s.agentName === agentName);
    if (existing) {
      ctx.logger.warn("Agent already active in thread", { agentName });
      return;
    }

    const now = new Date().toISOString();
    const session: AgentSession = {
      sessionId: `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentName,
      agentDisplayName: displayName,
      spawnedAt: now,
      status: "active",
      lastActivityAt: now,
    };

    sessions.push(session);
    await setSessions(ctx, payload.companyId, payload.channel, payload.threadTs, sessions);

    ctx.logger.info("ACP agent spawned", {
      channel: payload.channel,
      threadTs: payload.threadTs,
      agentName,
      sessionId: session.sessionId,
    });
    return;
  }

  // Multi-agent: status
  if (sub === "status") {
    const sessions = await getSessions(ctx, payload.companyId, payload.channel, payload.threadTs);
    const active = sessions.filter((s) => s.status === "active");

    if (active.length === 0) {
      ctx.logger.info("No active agents in thread", {
        channel: payload.channel,
        threadTs: payload.threadTs,
      });
      return;
    }

    const lines = active.map((s) => {
      const age = Math.round((Date.now() - new Date(s.lastActivityAt).getTime()) / 1000);
      return `:large_green_circle: *${s.agentDisplayName}* (\`${s.agentName}\`) - last active ${age}s ago`;
    });

    await postMessage(
      ctx,
      await resolveToken(ctx),
      payload.channel,
      {
        text: `${active.length} active agent(s) in thread`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `Active Agents (${active.length})` },
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: lines.join("\n") },
          },
        ],
      },
      payload.threadTs ? { threadTs: payload.threadTs } : undefined,
    );
    return;
  }

  // Multi-agent: close
  if (sub === "close") {
    const targetName = subArgs[1]?.toLowerCase();
    const sessions = await getSessions(ctx, payload.companyId, payload.channel, payload.threadTs);

    let target: AgentSession | undefined;
    if (targetName) {
      target = sessions.find(
        (s) => s.status === "active" && s.agentName.toLowerCase() === targetName,
      );
    } else {
      target = findMostRecentActive(sessions);
    }

    if (!target) {
      ctx.logger.warn("No matching agent to close", { targetName });
      return;
    }

    target.status = "closed";
    await setSessions(ctx, payload.companyId, payload.channel, payload.threadTs, sessions);

    ctx.logger.info("ACP agent closed", {
      channel: payload.channel,
      threadTs: payload.threadTs,
      agentName: target.agentName,
    });
    return;
  }

  ctx.logger.warn("Unknown /acp subcommand", { sub });
}

// --- Message routing (multi-agent aware) ---

export async function routeMessageToAcp(
  ctx: PluginContext,
  companyId: string,
  channel: string,
  threadTs: string,
  text: string,
  replyToMessageTs?: string,
): Promise<boolean> {
  // Try multi-agent sessions first
  const sessions = await getSessions(ctx, companyId, channel, threadTs);
  const activeSessions = sessions.filter((s) => s.status === "active");

  if (activeSessions.length > 0) {
    let replyToAgentName: string | undefined;
    if (replyToMessageTs) {
      const agentNameForMsg = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: `msg-agent-${channel}-${replyToMessageTs}`,
      });
      if (agentNameForMsg) {
        replyToAgentName = String(agentNameForMsg);
      }
    }

    const target = await resolveTargetAgent(ctx, companyId, channel, threadTs, text, replyToAgentName);
    if (target) {
      await touchSession(ctx, companyId, channel, threadTs, target.agentName);

      ctx.events.emit("acp:message", {
        agentId: target.agentName,
        sessionId: target.sessionId,
        channel,
        threadTs,
        text,
        companyId,
      });

      ctx.logger.info("Routed message to ACP agent (multi-agent)", {
        agentId: target.agentName,
        channel,
        threadTs,
      });
      return true;
    }
  }

  // Fallback to legacy single-agent binding
  const agentId = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: bindingKey(channel, threadTs),
  });

  if (!agentId) return false;

  ctx.events.emit("acp:message", {
    agentId: String(agentId),
    channel,
    threadTs,
    text,
    companyId,
  });

  ctx.logger.info("Routed message to ACP agent", {
    agentId: String(agentId),
    channel,
    threadTs,
  });
  return true;
}

// --- Output handling (multi-agent with sequencing) ---

export async function handleAcpOutput(
  ctx: PluginContext,
  token: string,
  event: PluginEvent,
): Promise<void> {
  const p = event.payload as AcpPayload;
  const channel = String(p.channel ?? "");
  const threadTs = String(p.threadTs ?? "");
  const text = String(p.text ?? "");
  const toolName = p.toolName != null ? String(p.toolName) : undefined;
  const agentName = p.agentName != null ? String(p.agentName) : undefined;

  if (!channel || !threadTs) {
    ctx.logger.warn("acp:output missing channel or threadTs", { channel, threadTs });
    return;
  }

  // Check if this thread has multi-agent sessions
  const sessions = await getSessions(ctx, event.companyId, channel, threadTs);
  const activeSessions = sessions.filter((s) => s.status === "active");

  if (activeSessions.length > 1 && agentName) {
    // Multi-agent: queue output for sequenced delivery
    const session = activeSessions.find((s) => s.agentName === agentName);
    const displayName = session?.agentDisplayName ?? agentName;

    await touchSession(ctx, event.companyId, channel, threadTs, agentName);

    await enqueueOutput(ctx, event.companyId, channel, threadTs, {
      agentName,
      agentDisplayName: displayName,
      text,
      toolName,
      queuedAt: new Date().toISOString(),
    });

    await drainOutputQueue(ctx, token, event.companyId, channel, threadTs);
  } else {
    // Single agent or legacy: post directly with optional label
    const blocks: SlackBlock[] = [];

    if (agentName && activeSessions.length > 0) {
      const session = activeSessions.find((s) => s.agentName === agentName);
      const displayName = session?.agentDisplayName ?? agentName;
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*[${displayName}]*` },
        ],
      });

      await touchSession(ctx, event.companyId, channel, threadTs, agentName);
    }

    blocks.push(...formatAsBlocks(text, toolName));

    const message: SlackMessage = {
      text: text.slice(0, 200),
      blocks,
    };

    const result = await postMessage(ctx, token, channel, message, { threadTs });
    if (result.ok) {
      if (agentName && result.ts) {
        await ctx.state.set(
          {
            scopeKind: "company",
            scopeId: event.companyId,
            stateKey: `msg-agent-${channel}-${result.ts}`,
          },
          agentName,
        );
      }

      await ctx.activity.log({
        companyId: event.companyId,
        message: "Posted ACP agent output to Slack thread",
        entityType: "plugin",
        entityId: event.entityId,
      });
    }
  }

  // Check if output is part of a discussion loop
  if (agentName) {
    await advanceDiscussionLoop(ctx, token, event.companyId, channel, threadTs, agentName, text);
  }
}

// --- Handoff tool ---

export function buildHandoffBlocks(
  fromAgent: string,
  toAgent: string,
  reason: string,
  handoffId: string,
): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Agent handoff requested*\n*${fromAgent}* wants to hand off to *${toAgent}*\n> ${reason}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "handoff_approve",
          value: handoffId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "handoff_reject",
          value: handoffId,
        },
      ],
    },
  ];
}

export async function handleHandoffTool(
  ctx: PluginContext,
  token: string,
  params: Record<string, unknown>,
): Promise<{ handoffId: string; status: string }> {
  const fromAgent = String(params.fromAgent ?? "");
  const toAgent = String(params.toAgent ?? "");
  const reason = String(params.reason ?? "");
  const channelId = String(params.channelId ?? "");
  const threadTs = String(params.threadTs ?? "");
  const companyId = String(params.companyId ?? "");
  const context = params.context != null ? String(params.context) : undefined;

  const handoffId = `hoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `handoff-${handoffId}` },
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

  return { handoffId, status: "pending" };
}

export async function handleHandoffAction(
  ctx: PluginContext,
  token: string,
  handoffId: string,
  approved: boolean,
  userId: string,
): Promise<void> {
  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id ?? "";

  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `handoff-${handoffId}`,
  }) as Record<string, unknown> | null;

  if (!raw) {
    ctx.logger.warn("Handoff record not found", { handoffId });
    return;
  }

  const status = approved ? "approved" : "rejected";
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `handoff-${handoffId}` },
    { ...raw, status, resolvedBy: `slack:${userId}`, resolvedAt: new Date().toISOString() },
  );

  if (approved) {
    const channelId = String(raw.channelId ?? "");
    const threadTs = String(raw.threadTs ?? "");
    const toAgent = String(raw.toAgent ?? "");
    const fromAgent = String(raw.fromAgent ?? "");
    const context = raw.context != null ? String(raw.context) : undefined;

    ctx.events.emit("acp:message", {
      agentId: toAgent,
      channel: channelId,
      threadTs,
      text: context ?? `Handoff from ${fromAgent}: ${String(raw.reason ?? "")}`,
      companyId,
      handoffId,
      fromAgent,
    });

    ctx.logger.info("Handoff approved, message sent to target agent", {
      handoffId,
      fromAgent,
      toAgent,
    });
  }

  await ctx.metrics.write("slack.handoffs.resolved", 1, { decision: status });
}

// --- Discussion loop tool ---

export async function handleDiscussWithAgentTool(
  ctx: PluginContext,
  token: string,
  params: Record<string, unknown>,
): Promise<{ discussionId: string; status: string }> {
  const initiatorAgent = String(params.initiatorAgent ?? "");
  const targetAgent = String(params.targetAgent ?? "");
  const topic = String(params.topic ?? "");
  const channelId = String(params.channelId ?? "");
  const threadTs = String(params.threadTs ?? "");
  const companyId = String(params.companyId ?? "");
  const maxTurns = Number(params.maxTurns ?? 10);

  const discussionId = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const loop: DiscussionLoop = {
    id: discussionId,
    channelId,
    threadTs,
    initiatorAgent,
    targetAgent,
    reason: topic,
    turns: 0,
    maxTurns,
    status: "active",
    lastTurnAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: discussionKey(discussionId) },
    loop,
  );

  // Track active discussion in thread
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `active-discussion-${channelId}-${threadTs}` },
    discussionId,
  );

  // Post initial message
  await postMessage(ctx, token, channelId, {
    text: `Discussion started: ${initiatorAgent} <-> ${targetAgent}: ${topic}`,
    blocks: [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `:speech_balloon: *Discussion started* between *${initiatorAgent}* and *${targetAgent}*` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Topic:* ${topic}\n*Max turns:* ${maxTurns}` },
      },
    ],
  }, threadTs ? { threadTs } : undefined);

  // Kick off: send topic to target agent
  ctx.events.emit("acp:message", {
    agentId: targetAgent,
    channel: channelId,
    threadTs,
    text: `[Discussion with ${initiatorAgent}] ${topic}`,
    companyId,
    discussionId,
    fromAgent: initiatorAgent,
  });

  return { discussionId, status: "active" };
}

async function advanceDiscussionLoop(
  ctx: PluginContext,
  token: string,
  companyId: string,
  channelId: string,
  threadTs: string,
  agentName: string,
  text: string,
): Promise<void> {
  const activeDiscId = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `active-discussion-${channelId}-${threadTs}`,
  });
  if (!activeDiscId) return;

  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: discussionKey(String(activeDiscId)),
  }) as DiscussionLoop | null;

  if (!raw || raw.status !== "active") return;

  const loop = raw;
  loop.turns += 1;
  loop.lastTurnAt = new Date().toISOString();

  // Check max turns
  if (loop.turns >= loop.maxTurns) {
    loop.status = "completed";
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: discussionKey(loop.id) },
      loop,
    );
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: `active-discussion-${channelId}-${threadTs}` },
      null,
    );

    await postMessage(ctx, token, channelId, {
      text: `Discussion completed (${loop.turns} turns)`,
      blocks: [
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `:white_check_mark: *Discussion completed* after ${loop.turns} turns` },
          ],
        },
      ],
    }, { threadTs });

    await ctx.metrics.write("slack.discussions.completed", 1, { turns: String(loop.turns) });
    return;
  }

  // Check for stale loop (no activity for 5 minutes)
  const staleCutoff = Date.now() - 5 * 60 * 1000;
  const lastTurn = new Date(loop.lastTurnAt).getTime();
  if (lastTurn < staleCutoff) {
    loop.status = "stale";
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: discussionKey(loop.id) },
      loop,
    );
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: `active-discussion-${channelId}-${threadTs}` },
      null,
    );

    await postMessage(ctx, token, channelId, {
      text: `Discussion went stale after ${loop.turns} turns`,
      blocks: [
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `:hourglass: *Discussion paused* - no activity for 5 minutes (${loop.turns} turns)` },
          ],
        },
      ],
    }, { threadTs });
    return;
  }

  // Route to the other agent
  const nextAgent = agentName === loop.initiatorAgent ? loop.targetAgent : loop.initiatorAgent;

  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: discussionKey(loop.id) },
    loop,
  );

  // Human checkpoint every 5 turns
  if (loop.turns % 5 === 0) {
    loop.status = "paused";
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: discussionKey(loop.id) },
      loop,
    );

    await postMessage(ctx, token, channelId, {
      text: `Discussion checkpoint at turn ${loop.turns}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:pause_button: *Discussion checkpoint* (turn ${loop.turns}/${loop.maxTurns})\nReview the conversation and choose to continue or stop.`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Continue" },
              style: "primary",
              action_id: "discussion_continue",
              value: loop.id,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Stop" },
              style: "danger",
              action_id: "discussion_stop",
              value: loop.id,
            },
          ],
        },
      ],
    }, { threadTs });
    return;
  }

  ctx.events.emit("acp:message", {
    agentId: nextAgent,
    channel: channelId,
    threadTs,
    text: `[Discussion with ${agentName}] ${text}`,
    companyId,
    discussionId: loop.id,
    fromAgent: agentName,
  });
}

export async function handleDiscussionAction(
  ctx: PluginContext,
  token: string,
  discussionId: string,
  action: "continue" | "stop",
  userId: string,
): Promise<void> {
  const companies = await ctx.companies.list({ limit: 1, offset: 0 });
  const companyId = companies[0]?.id ?? "";

  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: discussionKey(discussionId),
  }) as DiscussionLoop | null;

  if (!raw) {
    ctx.logger.warn("Discussion record not found", { discussionId });
    return;
  }

  if (action === "stop") {
    raw.status = "completed";
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: discussionKey(discussionId) },
      raw,
    );
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: `active-discussion-${raw.channelId}-${raw.threadTs}` },
      null,
    );
    await ctx.metrics.write("slack.discussions.stopped", 1, { by: userId });
    return;
  }

  // Resume
  raw.status = "active";
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: discussionKey(discussionId) },
    raw,
  );
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `active-discussion-${raw.channelId}-${raw.threadTs}` },
    discussionId,
  );

  // Continue the loop - send to the next agent in line
  const nextAgent = raw.turns % 2 === 0 ? raw.targetAgent : raw.initiatorAgent;
  ctx.events.emit("acp:message", {
    agentId: nextAgent,
    channel: raw.channelId,
    threadTs: raw.threadTs,
    text: `[Discussion resumed] Please continue the discussion.`,
    companyId,
    discussionId,
    fromAgent: nextAgent === raw.targetAgent ? raw.initiatorAgent : raw.targetAgent,
  });
}

// --- Token resolver (for slash command status output) ---

let cachedToken: string | undefined;

export function setAcpToken(token: string): void {
  cachedToken = token;
}

async function resolveToken(ctx: PluginContext): Promise<string> {
  if (cachedToken) return cachedToken;
  const rawConfig = await ctx.config.get();
  const config = rawConfig as unknown as { slackTokenRef: string };
  const token = await ctx.secrets.resolve(config.slackTokenRef);
  cachedToken = token;
  return token;
}
