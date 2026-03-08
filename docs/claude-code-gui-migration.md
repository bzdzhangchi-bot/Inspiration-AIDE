# Claude Code GUI Migration

## Goal

Turn assistant-desk into a GUI host for the real Claude Code CLI.

The application should treat Claude Code as the runtime of record and avoid reimplementing its agent loop, tools, skills, or session semantics inside the app.

## Product Split

There are now two distinct modes:

- `claude_cli`: host the real local `claude` executable in a dedicated PTY session.
- `claude_code`: keep the existing self-hosted agent runtime as a separate native-agent mode.

The app should stop presenting `claude_code` as if it were equivalent to Claude Code.

## Runtime Direction

Preferred architecture:

`GUI -> Claude Code CLI process -> Claude Code runtime -> model/tools/skills`

Avoid this as the primary Claude path:

`GUI -> custom agent loop -> provider adapters -> raw model API`

## Migration Phases

### Phase 1

- Add `claude_cli` as a first-class interaction mode.
- Launch a real `claude` session in a dedicated terminal tab.
- Route chat input to that persistent session.
- Route interrupt requests to that session.
- Relabel the old `claude_code` mode as native agent.

### Phase 2

- Add a `ClaudeCodeSessionService` so the renderer does not talk to PTY details directly.
- Track runtime status separately from generic terminal tabs.
- Persist and restore Claude sessions per workspace.

Status:

- Implemented with `src/renderer/claudeCodeClient.ts`.
- Runtime state is now stored per workspace in renderer storage and restored on reopen.
- Claude CLI startup now includes `--debug-file` pointing at a workspace-local log file.

### Phase 3

- Detect whether Claude Code exposes machine-readable events or logs.
- If available, build structured UI for questions, approvals, plans, and diffs from Claude output.
- If unavailable, keep PTY hosting as the source of truth and layer UI extraction on top.

### Phase 4

- Split the project page into two explicit user-facing experiences:
  - Claude CLI
  - Native Agent
- Ensure settings, labels, and onboarding make the difference obvious.

## Immediate Implementation Notes

- Keep terminal hosting in Electron and node-pty.
- Prefer a dedicated tab title like `Claude Code` for the real CLI runtime.
- Do not inject custom provider prompts in `claude_cli` mode.
- Do not attempt to emulate skills in `claude_cli` mode; let Claude Code discover and use its own skills.

## Claude CLI Capability Finding

Observed from `claude --help` on the local machine:

- `--output-format stream-json` is documented only with `--print`.
- `--input-format stream-json` is also documented only with `--print`.
- The default interactive session is documented as PTY/text driven, not as a structured event stream.

Current implication:

- `claude_cli` mode should keep the real interactive runtime in a PTY.
- The GUI may extract higher-level hints like plans, questions, approvals, and diffs from terminal text.
- A workspace-local `--debug-file` log can be tailed as a secondary signal source, but it is still diagnostic text rather than a stable interactive event protocol.
- If stronger parity is needed later, investigate whether debug logs, plugins, or future Claude CLI releases expose machine-readable interactive events.

## Files To Evolve Next

- `src/renderer/components/TerminalPanel.tsx`
  - Extract Claude runtime tab management into a separate service.
- `src/renderer/pages/ChatPage.tsx`
  - Reduce Claude CLI mode to a thin prompt launcher and status surface.
- `src/renderer/pages/SettingsPage.tsx`
  - Keep `Claude CLI` and `Native Agent` clearly separated.
- `src/main/providers.ts`
  - Treat this as native-agent infrastructure, not Claude CLI infrastructure.

## Success Criteria

- A user can choose `Claude CLI` and know they are using the real local Claude Code runtime.
- A user can choose `Native Agent` and know they are using the app's own agent implementation.
- Future parity work for Claude Code focuses on runtime hosting and event rendering, not on rebuilding Claude behavior in prompts.