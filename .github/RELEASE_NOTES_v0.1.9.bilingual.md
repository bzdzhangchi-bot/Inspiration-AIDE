# Inspiration 0.1.9

## English

Inspiration 0.1.9 is a focused rendering polish release for Markdown readability in chat and workspace preview.

### Highlights

- Fixed Markdown inline code rendering so single-backtick fragments such as `.jsonl`, `.env`, and similar extensions stay inline instead of being expanded into block code.
- Restored Mermaid fenced-code rendering in the workspace Markdown preview after the renderer refactor.
- Refined inline code styling to a quieter neutral appearance that stays distinguishable without competing with surrounding body text.

### Included artifacts

- macOS arm64 DMG: `Inspiration-0.1.9-arm64.dmg`
- macOS arm64 ZIP: `Inspiration-0.1.9-arm64.zip`
- macOS x64 DMG: `Inspiration-0.1.9-x64.dmg`
- macOS x64 ZIP: `Inspiration-0.1.9-x64.zip`

### Notes

- Recommended download for end users: the `.dmg` artifact.
- This release focuses on Markdown rendering behavior only; no workflow or storage migrations are included.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

### Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Inspiration into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

### Known limitations

- Apple notarization is not enabled for this release.
- Release assets are currently provided as separate arm64 and x64 macOS builds.

---

## 中文

Inspiration 0.1.9 是一次聚焦 Markdown 渲染细节的修复版本，主要改善聊天区和工作区预览的可读性。

### 版本亮点

- 修复 Markdown 行内代码渲染，像 `.jsonl`、`.env` 这类单反引号包裹的片段不再被错误扩展成块级代码。
- 修复工作区 Markdown 预览中的 Mermaid fenced code 渲染，避免在渲染器调整后失效。
- 收敛行内代码的视觉样式，改为更克制的中性标签感，既可识别又不抢正文。

### 发布产物

- macOS arm64 DMG：`Inspiration-0.1.9-arm64.dmg`
- macOS arm64 ZIP：`Inspiration-0.1.9-arm64.zip`
- macOS x64 DMG：`Inspiration-0.1.9-x64.dmg`
- macOS x64 ZIP：`Inspiration-0.1.9-x64.zip`

### 说明

- 面向使用者，优先推荐下载 `.dmg` 安装包。
- 本次发布只涉及 Markdown 渲染修复，不包含工作流或数据存储迁移。
- 由于当前构建未进行 notarization，macOS 可能会在首次打开时提示安全确认。
- 因环境中未配置完整的 Apple notarization 凭据，本次发布跳过了 notarization。

### 安装

1. 从 Releases 下载最新的 `.dmg`。
2. 打开磁盘镜像，将 Inspiration 拖入 Applications。
3. 如果 macOS 阻止打开，可右键应用并选择“打开”。

### 当前限制

- 本版本暂未启用 Apple notarization。
- 当前发布产物仍以 arm64 和 x64 两套独立 macOS 构建提供。
