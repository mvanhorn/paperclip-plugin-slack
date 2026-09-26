import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { SessionEntry } from "./types.js";
export declare function spawnAgent(ctx: PluginContext, companyId: string, channelId: string, threadTs: string, agentId: string, displayName: string, reason?: string): Promise<SessionEntry | null>;
export declare function closeAgent(ctx: PluginContext, companyId: string, channelId: string, threadTs: string, agentName?: string): Promise<SessionEntry | null>;
export declare function routeMessageToAgent(ctx: PluginContext, companyId: string, channel: string, threadTs: string, text: string, replyToMessageTs?: string): Promise<boolean>;
export declare function handleAgentOutput(ctx: PluginContext, token: string, companyId: string, payload: {
    channel: string;
    threadTs: string;
    text: string;
    agentName?: string;
    agentDisplayName?: string;
    toolName?: string;
}): Promise<void>;
export declare function buildHandoffBlocks(fromAgent: string, toAgent: string, reason: string, handoffId: string): Array<Record<string, unknown>>;
export declare function handleHandoffAction(ctx: PluginContext, token: string, companyId: string, handoffId: string, approved: boolean, userId: string): Promise<void>;
export declare function startDiscussion(ctx: PluginContext, token: string, companyId: string, params: {
    initiatorAgent: string;
    targetAgent: string;
    topic: string;
    channelId: string;
    threadTs: string;
    maxTurns: number;
}): Promise<{
    discussionId: string;
    status: string;
}>;
export declare function handleDiscussionAction(ctx: PluginContext, token: string, companyId: string, discussionId: string, action: "continue" | "stop", userId: string): Promise<void>;
export declare function handleAcpSlashCommand(ctx: PluginContext, token: string, payload: {
    channel: string;
    threadTs: string;
    text: string;
    companyId: string;
}): Promise<void>;
