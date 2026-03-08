# Assistant Desk 0.1.3

Assistant Desk 0.1.3 is a focused stability release for Markdown editing and preview switching, with a small documentation refresh.

## Highlights

- Fixed an intermittent issue where the Markdown `Edit` and `Preview` buttons could stop responding after switching between previewable files.
- Aligned Markdown TOC heading ids with rendered preview anchor ids so in-document navigation stays consistent.
- Updated the README with a homepage screenshot for clearer project presentation.

## Included artifacts

- macOS arm64 DMG: `Assistant Desk-0.1.3-arm64.dmg`
- macOS arm64 ZIP: `Assistant Desk-0.1.3-arm64.zip`

## Notes

- Recommended download for end users: the `.dmg` artifact.
- This build includes the previously shipped packaged-app performance optimizations from 0.1.2.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

## Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Assistant Desk into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

## Known limitations

- Apple notarization is not enabled for this release.