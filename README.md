# paperclip-plugin-slack

[![npm](https://img.shields.io/npm/v/paperclip-plugin-slack)](https://www.npmjs.com/package/paperclip-plugin-slack)

Slack notifications plugin for [Paperclip](https://github.com/paperclipai/paperclip). Posts to Slack when agents create issues, complete tasks, request approvals, hit errors, or reach budget limits. Approve or reject requests directly from Slack with interactive buttons. Includes daily activity digests and per-type channel routing.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## Why this exists

Multiple Paperclip users asked for notifications on the same day the plugin system shipped (2026-03-14):

> "is there a way to have codex/claude check paperclip to see when tasks are done without me prompting it?" - @Choose Liberty, Discord #dev

> "basically to have it 'let me know when its done'" - @Choose Liberty, Discord #dev

> "can claude code check paperclip to see when tasks are done" - @Nascozz, Discord #dev

@dotta (maintainer) responded: "we're also adding issue-changed hooks for plugins so when that lands someone could [make notifications]." The event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)) shipped that same day. @dotta also asked for "someone to make a plugin that's a totally separate package" to validate the DX. @Ryze said "Really excited by the plugins. I had developed a custom plugin bridge that I will now deprecate and migrate over to the new supported plugin system."

This is that plugin.

## What it does

**Notifications (rich Block Kit formatting)**
- **Issue created** - Title, description snippet, status, priority, assignee, project fields, and a "View Issue" button
- **Issue done** - Completion confirmation with status fields and view button
- **Approval requested** - Interactive **Approve**, **Reject**, and **View** buttons. Click to act without leaving Slack.
- **Agent error** - Error message in a code block with warning indicator
- **Agent online** - Connection confirmation with check mark
- **Budget threshold** - Alerts at 80%, 90%, and 100% budget usage (deduped per threshold)
- **Onboarding milestone** - Celebrates an agent's first successful run

**Interactive approvals**
- Approve/reject buttons on every approval notification
- Clicking a button calls the Paperclip API and updates the Slack message inline
- Identifies which Slack user acted (logged as `slack:{user_id}`)

**HITL escalation**
- Agents that get stuck can escalate to a dedicated Slack channel with full conversation context
- Rich Block Kit formatting with conversation history, agent reasoning, and confidence score
- "Use Suggested Reply" button when the agent has a best-guess response
- "Reply to Customer", "Override Agent", and "Dismiss" buttons
- Configurable timeout (default 15 min) with automatic default action (defer, close, retry)
- Customer messages queued during escalation and delivered with the human's response

**Per-type channel routing**
- Route approvals, errors, and pipeline events to separate Slack channels
- Falls back to the default channel when a per-type channel isn't configured
- Per-company overrides still take priority

**Daily digest**
- Scheduled job (9am daily) with real stats from the Paperclip API
- Tasks completed, tasks created, active agents, total cost, and top performer
- Cost data accumulated from `cost_event.created` events throughout the day

**Slash commands**
- `/clip status` - Show agent and task status
- `/clip help` - List available commands

## Install

```bash
npm install paperclip-plugin-slack
```

Or register with your Paperclip instance directly:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-slack"}'
```

## Setup

1. Create a Slack app at https://api.slack.com/apps
2. Add the `chat:write` bot scope
3. Enable **Interactivity** and point the Request URL to your Paperclip host's `slack-interactivity` webhook endpoint
4. Install the app to your workspace and copy the Bot OAuth Token
5. Store the token in your Paperclip secret provider
6. Install the plugin and configure the secret reference + channel ID

## Configuration

| Setting | Description |
|---------|-------------|
| `slackTokenRef` | Secret reference for the Slack Bot OAuth token |
| `defaultChannelId` | Default Slack channel ID (e.g. `C01ABC2DEF3`) |
| `approvalsChannelId` | Dedicated channel for approvals (optional) |
| `errorsChannelId` | Dedicated channel for agent errors (optional) |
| `pipelineChannelId` | Dedicated channel for agent lifecycle events (optional) |
| `notifyOnIssueCreated` | Post when issues are created (default: true) |
| `notifyOnIssueDone` | Post when issues are completed (default: true) |
| `notifyOnApprovalCreated` | Post when approvals are requested (default: true) |
| `notifyOnAgentError` | Post when agent runs fail (default: true) |
| `notifyOnAgentConnected` | Post when agents connect/disconnect (default: true) |
| `notifyOnBudgetThreshold` | Post when agents hit budget limits (default: true) |
| `enableDailyDigest` | Send daily activity summary at 9am (default: false) |
| `escalationChatId` | Dedicated channel for agent escalations (optional) |
| `escalationTimeoutMs` | Timeout before default action fires (default: 900000 / 15 min) |
| `escalationDefaultAction` | Action on timeout: `defer`, `close`, `retry`, `escalate_further` (default: `defer`) |
| `escalationHoldMessage` | Message sent to customer while waiting (default: "Let me check on that - I'll get back to you shortly.") |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Requires `@paperclipai/plugin-sdk` and `@paperclipai/shared` as peer dependencies. For local development, link them from the Paperclip monorepo.

## Credits

[@MatB57](https://github.com/MatB57) - Escalation channel concept, "Chat OS" vision for turning chat plugins into bidirectional agent command centers, and the HITL suggested-reply flow.

## License

MIT
