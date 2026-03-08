# Assistant Desk 0.1.3

## English

Assistant Desk 0.1.3 is a focused stability release for Markdown editing and preview switching, with a small documentation refresh.

### Highlights

- Fixed an intermittent issue where the Markdown `Edit` and `Preview` buttons could stop responding after switching between previewable files.
- Aligned Markdown TOC heading ids with rendered preview anchor ids so in-document navigation stays consistent.
- Updated the README with a homepage screenshot and clearer release copy.
- Carries forward the packaged-app responsiveness improvements introduced in 0.1.2.

### Included artifacts

- macOS arm64 DMG: `Assistant.Desk-0.1.3-arm64.dmg`
- macOS arm64 ZIP: `Assistant.Desk-0.1.3-arm64.zip`
- macOS x64 DMG: `Assistant.Desk-0.1.3-x64.dmg`
- macOS x64 ZIP: `Assistant.Desk-0.1.3-x64.zip`

### Notes

- Recommended download for end users: the `.dmg` artifact.
- This build includes the previously shipped packaged-app performance optimizations from 0.1.2.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

### Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Assistant Desk into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

### Known limitations

- Apple notarization is not enabled for this release.
- Release assets are currently provided as separate arm64 and x64 macOS builds.

---

## 中文

Assistant Desk 0.1.3 是一次聚焦于 Markdown 编辑与预览切换稳定性的更新，同时补充了更清晰的项目说明文案。

### 版本亮点

- 修复了 Markdown 文件在多个可预览文档之间切换后，`Edit` / `Preview` 按钮偶现失效的问题。
- 统一了 Markdown 目录锚点与预览实际锚点的生成规则，减少文档内跳转错位。
- README 新增首页截图，并同步整理了版本说明文案。
- 保留并延续了 0.1.2 中已经完成的打包版性能优化。

### 发布产物

- macOS arm64 DMG：`Assistant.Desk-0.1.3-arm64.dmg`
- macOS arm64 ZIP：`Assistant.Desk-0.1.3-arm64.zip`
- macOS x64 DMG：`Assistant.Desk-0.1.3-x64.dmg`
- macOS x64 ZIP：`Assistant.Desk-0.1.3-x64.zip`

### 说明

- 面向使用者，优先推荐下载 `.dmg` 安装包。
- 本版本同时包含 0.1.2 中已经上线的打包版流畅度优化。
- 由于当前构建未进行 notarization，macOS 可能会在首次打开时提示安全确认。
- 因环境中未配置完整的 Apple notarization 凭据，本次发布跳过了 notarization。

### 安装

1. 从 Releases 下载最新的 `.dmg`。
2. 打开磁盘镜像，将 Assistant Desk 拖入 Applications。
3. 如果 macOS 阻止打开，可右键应用并选择“打开”。

### 当前限制

- 本版本暂未启用 Apple notarization。
- 当前发布产物仍以 arm64 和 x64 两套独立 macOS 构建提供。