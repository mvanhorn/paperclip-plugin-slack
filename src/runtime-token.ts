import type { PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";

export type SlackRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

export const SECRET_RESOLUTION_DISABLED_MESSAGE = "Plugin secret references are disabled until company-scoped plugin config lands";
export const SECRET_RESOLUTION_ISSUE_URL = "https://github.com/mvanhorn/paperclip-plugin-slack/issues/31";

export async function resolveStartupSlackToken(
  ctx: PluginContext,
  tokenRef: string,
  setHealth: (health: SlackRuntimeHealth) => void,
): Promise<string | undefined> {
  try {
    const token = await ctx.secrets.resolve(tokenRef);
    setHealth({ status: "ok" });
    return token;
  } catch (err) {
    const error = String(err);
    setHealth({
      status: "degraded",
      message: SECRET_RESOLUTION_DISABLED_MESSAGE,
      details: {
        issue: "paperclip-plugin-secret-resolution-disabled",
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    });
    ctx.logger.error("Slack plugin cannot resolve Slack token secret; runtime features are disabled", {
      error,
      reference: SECRET_RESOLUTION_ISSUE_URL,
    });
    return undefined;
  }
}
