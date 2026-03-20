# paperclip-plugin-slack

[![npm](https://img.shields.io/npm/v/paperclip-plugin-slack)](https://www.npmjs.com/package/paperclip-plugin-slack)

Slack Chat OS plugin for [Paperclip](https://github.com/paperclipai/paperclip). Turns Slack into a bidirectional agent command center - notifications, approvals, multi-agent threads, voice-to-task pipelines, custom workflow commands, and proactive agent suggestions.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## Why this exists

Multiple Paperclip users asked for notifications on the same day the plugin system shipped (2026-03-14):

> "is there a way to have codex/claude check paperclip to see when tasks are done without me prompting it?" - @Choose Liberty, Discord #dev

> "basically to have it 'let me know when its done'" - @Choose Liberty, Discord #dev

> "can claude code check paperclip to see when tasks are done" - @Nascozz, Discord #dev

@dotta (maintainer) responded: "we're also adding issue-changed hooks for plugins so when that lands someone could [make notifications]." The event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)) shipped that same day. @dotta also asked for "someone to make a plugin that's a totally separate package" to validate the DX. @Ryze said "Really excited by the plugins. I had developed a custom plugin bridge that I will now deprecate and migrate over to the new supported plugin system."

This is that plugin.

## What it does

### Phase 1: Notifications + HITL Escalation

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
- Exposes `escalate_to_human` tool for agents

**Per-type channel routing**
- Route approvals, errors, and pipeline events to separate Slack channels
- Falls back to the default channel when a per-type channel isn't configured
- Per-company overrides still take priority

**Daily digest**
- Scheduled job (9am daily) with real stats from the Paperclip API
- Tasks completed, tasks created, active agents, total cost, and top performer
- Cost data accumulated from `cost_event.created` events throughout the day

### Phase 2: Multi-Agent Group Threads

- **Multiple agents per thread** - Spawn up to `maxAgentsPerThread` (default 5) agents in a single Slack thread via `/clip acp spawn <agent> [display_name]`
- **@mention routing** - @mention an agent name to direct your message to a specific agent; falls back to reply-to context, then most recently active
- **Agent handoff** - `handoff_to_agent` tool lets one agent request a handoff to another with Approve/Reject buttons in-thread
- **Discussion loops** - `discuss_with_agent` tool starts a back-and-forth conversation between two agents with configurable max turns
- **Human checkpoints** - Discussion pauses every 5 turns with Continue/Stop buttons so humans stay in the loop
- **Stale detection** - Discussions auto-pause after 5 minutes of inactivity
- **Output sequencing** - When multiple agents are active, outputs are queued and delivered in order with agent name labels
- **Session registry** - Tracks active/closed sessions per thread with native SDK sessions (preferred) and ACP fallback
- `/clip acp status` - Show all active agents in the current thread
- `/clip acp close [name]` - Close a specific agent or the most recently active one

### Phase 3: Media-to-Task Pipeline

- **Auto-detect media files** - Audio (mp3, m4a, ogg, wav, webm, flac) and video (mp4, webm, quicktime) attachments in threads are automatically processed
- **Whisper transcription** - Audio files are sent to a `whisper-transcriber` agent for speech-to-text
- **Brief Agent** - Optional agent summarizes the transcription into an actionable brief
- **Inline results** - Transcription and brief run IDs posted back to the original thread
- **`process_media` tool** - Agents can programmatically trigger media processing with an optional `briefAgentId`
- **Slack Events API** - `file_shared` events trigger the pipeline automatically

### Phase 4: Custom Workflow Commands

- **`!command` syntax** - Type `!deploy staging` or `!triage bug-123` in any thread to trigger registered workflows
- **Multi-step workflows** - Each command runs a sequence of steps: `invoke_agent`, `post_message`, `create_issue`, `wait_approval`
- **Argument interpolation** - Use `$1`, `$2`, or `$args` in step templates to pass user arguments
- **`register_command` tool** - Agents or admins can register new commands at runtime
- **Step-level approval gates** - `wait_approval` steps pause execution with Approve/Reject buttons
- **Progress indicators** - Each step posts status to the thread; failures show error details
- `/clip commands` - List all registered custom commands with descriptions and usage

### Phase 5: Proactive Agent Suggestions

- **Event watches** - `register_watch` tool sets up a trigger: when an event matching a pattern fires, an agent is invoked with a templated prompt
- **Wildcard patterns** - Match exact events (`issue.created`) or wildcards (`agent.run.*`)
- **Prompt interpolation** - Use `${event.payload.key}` in watch prompts to inject event data
- **Built-in sales templates** - 5 pre-built watch templates: `new-lead-follow-up`, `deal-stalled`, `high-value-issue`, `budget-warning`, `agent-error-diagnosis`
- **`list_watch_templates` tool** - Browse available templates
- **`remove_watch` tool** - Remove watches by ID
- **Scheduled check job** - Watches are evaluated periodically against buffered events (last 100 per company)
- `/clip watches` - List all active watches with trigger counts

### Slash commands

- `/clip status` - Show active agents and recent completions
- `/clip agents` - List all agents with status badges
- `/clip issues [open|done]` - List issues filtered by status
- `/clip approve <id>` - Approve a pending approval
- `/clip acp spawn <agent> [display]` - Add an agent to this thread
- `/clip acp status` - Show all agents in this thread
- `/clip acp close [name]` - Close a specific agent (or most recent)
- `/clip commands` - List registered custom commands
- `/clip watches` - List active event watches
- `/clip help` - Show this help message

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
| `escalationHoldMessage` | Message sent to customer while waiting (default: "Your request has been escalated to a human agent. Please hold.") |
| `paperclipBaseUrl` | Base URL for the Paperclip API (default: `http://localhost:3100`) |
| `maxAgentsPerThread` | Max concurrent agents in a single thread (default: 5) |

## Agent tools

The plugin registers these tools that agents can call:

| Tool | Phase | Description |
|------|-------|-------------|
| `escalate_to_human` | 1 | Escalate to a human operator with conversation context and optional suggested reply |
| `handoff_to_agent` | 2 | Request a handoff from one agent to another with approval buttons |
| `discuss_with_agent` | 2 | Start a turn-based discussion loop between two agents |
| `process_media` | 3 | Process an audio/video file - transcribe and optionally brief |
| `register_command` | 4 | Register a custom `!command` with workflow steps |
| `register_watch` | 5 | Register an event watch that triggers an agent on matching events |
| `remove_watch` | 5 | Remove a registered event watch |
| `list_watch_templates` | 5 | List built-in watch templates for common use cases |

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
