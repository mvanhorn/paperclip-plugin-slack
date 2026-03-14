# paperclip-plugin-slack

Slack notifications plugin for [Paperclip](https://github.com/paperclipai/paperclip). Posts to Slack when issues are created, completed, or need approval.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## Why this exists

Multiple Paperclip users asked for notifications on the same day the plugin system shipped (2026-03-14):

> "is there a way to have codex/claude check paperclip to see when tasks are done without me prompting it?" - @Choose Liberty, Discord #dev

> "basically to have it 'let me know when its done'" - @Choose Liberty, Discord #dev

> "can claude code check paperclip to see when tasks are done" - @Nascozz, Discord #dev

@dotta (maintainer) responded: "we're also adding issue-changed hooks for plugins so when that lands someone could [make notifications]." The event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)) shipped that same day. @dotta also asked for "someone to make a plugin that's a totally separate package" to validate the DX. @Ryze said "Really excited by the plugins. I had developed a custom plugin bridge that I will now deprecate and migrate over to the new supported plugin system."

This is that plugin.

## What it does

- **Issue created** - Posts to Slack when a new issue is created
- **Issue done** - Posts to Slack when an issue status changes to "done"
- **Approval requested** - Posts to Slack when a new approval is created
- **Per-company channel mapping** - Different companies can post to different Slack channels
- **Webhook endpoints** - Receives Slack Events API and slash command payloads

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

## v1 limitations

Agent run events (`agent.run.finished`, `agent.run.failed`) are not yet bridged to the plugin event bus. These go through `publishLiveEvent` in the Paperclip server, not `logActivity`. A future Paperclip PR can bridge those the same way #909 bridged issue events.

## Development

```bash
npm install
npm run typecheck
npm run build
```

Requires `@paperclipai/plugin-sdk` and `@paperclipai/shared` as peer dependencies. For local development, link them from the Paperclip monorepo.
