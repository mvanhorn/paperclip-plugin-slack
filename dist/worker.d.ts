import type { SlackConfig } from "./types.js";
/** Everything a company-scoped invocation needs, built from a config delivery. */
type SlackRuntime = {
    companyId: string;
    config: SlackConfig;
    token: string;
    signingSecret: string | null;
    baseUrl: string;
};
/** Test seam — reset all module-level runtime state. */
export declare function _resetRuntimeForTests(): void;
/** Current runtime, or null when the plugin has not been bootstrapped yet. */
export declare function _getRuntimeForTests(): SlackRuntime | null;
declare const plugin: import("@paperclipai/plugin-sdk").PaperclipPlugin;
export default plugin;
