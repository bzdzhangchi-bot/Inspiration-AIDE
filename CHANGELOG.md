# Changelog

## 0.1.10 - 2026-03-13

- Added OpenClaw skill discovery, agent delegation, installer status UX, and dedicated workspace-side setup flows.
- Improved Native Agent continuity with profile reconnect-on-return, richer workspace and Git tools, and stronger OpenClaw-first browser/task delegation.
- Reworked ask_user into clickable single-select and multi-select submission flows instead of freeform typing.
- Reduced the Native Agent planning/activity panel footprint to keep the workspace less obstructed.
- Removed the built-in Native Agent browser-opening tool so it no longer interferes with OpenClaw workflows.
- Fixed workspace/project UX issues including native File menu open project, duplicate open button removal, project picker auto-trigger, persisted workspace/editor restore, file-link opening in Markdown preview, and immediate menu dismissal after Remove From Workspace.
- Improved app resilience with core health reuse, renderer fallback loading, root error boundary logging, and a more reliable Electron dev launcher.