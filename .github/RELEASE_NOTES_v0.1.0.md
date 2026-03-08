# Assistant Desk 0.1.0

Assistant Desk 0.1.0 is the first packaged preview release of the desktop AI coding workspace.

## Highlights

- Electron desktop app with assistant chat, terminal, and multi-project explorer in one workspace.
- Explorer interaction refined toward a denser VS Code-like flow, including multi-root support, root switching, drag reordering, remove-from-workspace, and reveal-current-file.
- macOS packaging pipeline is now in place, with GitHub Actions building release artifacts for arm64 and x64.

## Notes

- Recommended download for end users: the `.dmg` artifact.
- The app may show macOS security prompts because this build is not notarized.
- API tokens are not compiled into the application bundle; they are stored locally at runtime in app settings.

## Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Assistant Desk into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

## Known limitations

- This release focuses on macOS distribution.
- Apple notarization is not enabled for this release.