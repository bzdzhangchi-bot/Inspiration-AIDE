# Inspiration 0.1.8

## English

Inspiration 0.1.8 is a focused workspace and onboarding release for first-run usability, project navigation, and Claude CLI handoff clarity.

### Highlights

- Added a built-in Starter Project that opens on first launch, including a getting-started guide, preview demos, and a minimal Spring Boot sample.
- Explorer now supports manual refresh for all open projects, and reopening an already-open project now activates and reveals it instead of silently duplicating state.
- Editor tabs now behave more like a desktop IDE, with horizontal overflow, auto-scrolling to the active tab, and context actions for Close All, Close Others, and Close Tabs to the Right.
- Claude CLI mode now uses a clear Terminal handoff panel instead of mirroring unstable CLI output directly into chat messages.

### Included artifacts

- macOS arm64 DMG: `Inspiration-0.1.8-arm64.dmg`
- macOS arm64 ZIP: `Inspiration-0.1.8-arm64.zip`
- macOS x64 DMG: `Inspiration-0.1.8-x64.dmg`
- macOS x64 ZIP: `Inspiration-0.1.8-x64.zip`

### Notes

- Recommended download for end users: the `.dmg` artifact.
- This release bundles a starter workspace under app data and keeps it synchronized across app restarts when the starter project is in use.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

### Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Inspiration into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

### Known limitations

- Apple notarization is not enabled for this release.
- Release assets are currently provided as separate arm64 and x64 macOS builds.
- The bundled Starter Project is intended for onboarding and demo use, not as a production application template.

---

## 中文

Inspiration 0.1.8 是一次聚焦首次上手、项目导航和 Claude CLI 交接体验的更新。

### 版本亮点

- 新增内置 Starter Project，首次启动即可直接进入，并附带新手引导、预览示例和一个最小 Spring Boot 示例工程。
- Explorer 新增“刷新全部已打开项目”能力；如果重复打开已存在的项目，现在会自动激活并定位，而不是悄悄重复进入同一状态。
- 编辑器标签页体验更接近桌面 IDE，支持横向滚动、自动滚动到当前标签，以及 `Close All`、`Close Others`、`Close Tabs to the Right` 等右键操作。
- Claude CLI 模式改为明确的 Terminal 交接面板，不再把不稳定的 CLI 输出直接镜像回聊天消息列表。

### 发布产物

- macOS arm64 DMG：`Inspiration-0.1.8-arm64.dmg`
- macOS arm64 ZIP：`Inspiration-0.1.8-arm64.zip`
- macOS x64 DMG：`Inspiration-0.1.8-x64.dmg`
- macOS x64 ZIP：`Inspiration-0.1.8-x64.zip`

### 说明

- 面向使用者，优先推荐下载 `.dmg` 安装包。
- 本次发布会在应用数据目录中维护 Starter Project，并在使用该项目时随应用启动自动同步模板更新。
- 由于当前构建未进行 notarization，macOS 可能会在首次打开时提示安全确认。
- 因环境中未配置完整的 Apple notarization 凭据，本次发布跳过了 notarization。

### 安装

1. 从 Releases 下载最新的 `.dmg`。
2. 打开磁盘镜像，将 Inspiration 拖入 Applications。
3. 如果 macOS 阻止打开，可右键应用并选择“打开”。

### 当前限制

- 本版本暂未启用 Apple notarization。
- 当前发布产物仍以 arm64 和 x64 两套独立 macOS 构建提供。
- 内置 Starter Project 主要用于上手和演示，不是完整生产项目模板。
