# paperclip-plugin-slack

Slack notifications plugin for [Paperclip](https://github.com/paperclipai/paperclip). Posts to Slack when agents create issues, complete tasks, request approvals, hit errors, or reach budget limits. Includes daily activity digests and slash commands.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## Why this exists

Multiple Paperclip users asked for notifications on the same day the plugin system shipped (2026-03-14):

> "is there a way to have codex/claude check paperclip to see when tasks are done without me prompting it?" - @Choose Liberty, Discord #dev

> "basically to have it 'let me know when its done'" - @Choose Liberty, Discord #dev

> "can claude code check paperclip to see when tasks are done" - @Nascozz, Discord #dev

@dotta (maintainer) responded: "we're also adding issue-changed hooks for plugins so when that lands someone could [make notifications]." The event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)) shipped that same day. @dotta also asked for "someone to make a plugin that's a totally separate package" to validate the DX. @Ryze said "Really excited by the plugins. I had developed a custom plugin bridge that I will now deprecate and migrate over to the new supported plugin system."

This is that plugin.

## What it does

**Notifications**
- **Issue created** - Posts when a new issue is created
- **Issue done** - Posts when an issue status changes to "done"
- **Approval requested** - Posts when a new approval is created
- **Agent error** - Posts when an agent run fails
- **Agent online** - Posts when an agent connects
- **Budget threshold** - Alerts at 80%, 90%, and 100% budget usage (deduped per threshold)
- **Onboarding milestone** - Celebrates an agent's first successful run

**Daily digest**
- Scheduled job (9am daily) summarizing tasks completed, tasks created, active agents, total cost, and top performer

**Slash commands**
- `/clip status` - Show agent and task status
- `/clip help` - List available commands
- Per-company channel mapping - different companies can post to different Slack channels

## Setup

1. Create a Slack app at https://api.slack.com/apps
2. Add the `chat:write` bot scope
3. Install the app to your workspace and copy the Bot OAuth Token
4. Store the token in your Paperclip secret provider
5. Install the plugin and configure the secret reference + channel ID

## Configuration

| Setting | Description |
|---------|-------------|
| `slackTokenRef` | Secret reference for the Slack Bot OAuth token |
| `defaultChannelId` | Default Slack channel ID (e.g. `C01ABC2DEF3`) |
| `notifyOnIssueCreated` | Post when issues are created (default: true) |
| `notifyOnIssueDone` | Post when issues are completed (default: true) |
| `notifyOnApprovalCreated` | Post when approvals are requested (default: true) |
| `notifyOnAgentError` | Post when agent runs fail (default: true) |
| `notifyOnAgentConnected` | Post when agents connect/disconnect (default: true) |
| `notifyOnBudgetThreshold` | Post when agents hit budget limits (default: true) |
| `enableDailyDigest` | Send daily activity summary at 9am (default: false) |

## Development

```bash
npm install
npm run typecheck
npm run build
```

Requires `@paperclipai/plugin-sdk` and `@paperclipai/shared` as peer dependencies. For local development, link them from the Paperclip monorepo.

## License

MIT
