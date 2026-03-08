# Assistant Desk 0.1.2

Assistant Desk 0.1.2 is a focused performance release aimed at making the packaged app feel substantially smoother in real use.

## Highlights

- Reduced packaged-app UI lag by debouncing and filtering recursive workspace file-watch events before they reach the renderer.
- Limited workspace refresh work so Explorer and open editors refresh only the paths affected by a file change instead of reloading everything.
- Reworked Claude CLI debug-log polling to use lighter tail reads, adaptive polling intervals, and subscription-aware teardown.
- Stopped Claude runtime inspection work from staying active outside Claude CLI mode.
- Lazy-loaded the terminal stack so `xterm` code stays out of the initial renderer startup path until the terminal is opened.
- Split Markdown, Mermaid, and syntax-highlighting preview code into a deferred preview chunk, reducing the main renderer bundle size significantly.

## Included artifacts

- macOS arm64 DMG: `Assistant Desk-0.1.2-arm64.dmg`
- macOS arm64 ZIP: `Assistant Desk-0.1.2-arm64.zip`

## Notes

- Recommended download for end users: the `.dmg` artifact.
- This build was manually verified for improved responsiveness in local packaged-app testing before packaging.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

## Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Assistant Desk into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

## Known limitations

- Apple notarization is not enabled for this release.
- Some preview-related chunks remain large because Mermaid and diagram dependencies are still substantial even after splitting.