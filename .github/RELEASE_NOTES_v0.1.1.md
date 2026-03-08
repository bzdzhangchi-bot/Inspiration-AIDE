# Assistant Desk 0.1.1

Assistant Desk 0.1.1 focuses on workspace ergonomics, Claude CLI inspection, and a more polished desktop flow.

## Highlights

- Added a richer Claude Inspector in Claude CLI mode, with unified runtime, memory, and skills views.
- Improved Claude CLI transcript cleanup so chat bubbles show cleaner replies and suppress more terminal noise.
- Added Claude memory inspection and reveal/open flows for project, user, and auto-memory files.
- Upgraded the workspace area with HTML preview support, a stronger empty-state welcome screen, common shortcuts, and quicker file opening.
- Refined Explorer ergonomics with clearer hierarchy, a compact project header, and a locate-current-file control.
- Moved the Assistant toggle into a compact right-side tool rail to make the main workspace layout cleaner.

## Included artifacts

- macOS arm64 DMG: `Assistant Desk-0.1.1-arm64.dmg`
- macOS arm64 ZIP: `Assistant Desk-0.1.1-arm64.zip`

## Notes

- Recommended download for end users: the `.dmg` artifact.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.
- API tokens are stored locally at runtime and are not compiled into the application bundle.

## Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Assistant Desk into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

## Known limitations

- This release currently ships macOS arm64 artifacts only from the local packaging run.
- Settings page scrolling received layout fixes in this release line, but should still be sanity-checked in a packaged app before wider rollout.
- Apple notarization is not enabled for this release.