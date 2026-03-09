# Assistant Desk 0.1.5

## English

Assistant Desk 0.1.5 is a focused assistant-experience release centered on layout flexibility, cleaner chat ergonomics, and more reliable Claude CLI conversation syncing.

### Highlights

- Added two assistant workspace layouts: `Collaborate` for side-by-side coding and `Immerse` for assistant-first focus with workspace context on demand.
- Refined the assistant surface with clearer left/right message alignment, a less cramped profile selector area, and a better-balanced composer/send row.
- Fixed Claude CLI chat syncing so runtime replies are pushed back into ChatPage incrementally instead of getting stuck on placeholder text.
- Improved provider guidance and connection diagnostics, especially for Anthropic-compatible gateways and mixed protocol setups.

### Included artifacts

- macOS arm64 DMG: `Assistant Desk-0.1.5-arm64.dmg`
- macOS arm64 ZIP: `Assistant Desk-0.1.5-arm64.zip`
- macOS x64 DMG: `Assistant Desk-0.1.5-x64.dmg`
- macOS x64 ZIP: `Assistant Desk-0.1.5-x64.zip`

### Notes

- Recommended download for end users: the `.dmg` artifact.
- The Profiles help and provider naming now explain Anthropic-compatible vs OpenAI-compatible flows more explicitly.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

### Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Assistant Desk into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

### Known limitations

- Apple notarization is not enabled for this release.
- Release assets are currently provided as separate arm64 and x64 macOS builds.
- Claude CLI runtime inspection still depends on PTY/debug-log observation, so its sync is best-effort rather than a documented structured stream.

---

## 中文

Assistant Desk 0.1.5 是一次聚焦 Assistant 使用体验的更新，重点在于布局灵活性、更顺手的聊天界面，以及更可靠的 Claude CLI 对话同步。

### 版本亮点

- 新增 `Collaborate` 与 `Immerse` 两种 Assistant 工作布局，可在并排协作和沉浸对话之间切换。
- 优化 Assistant 主界面，改善消息左右分布、profile 选择区拥挤问题，以及输入框与发送按钮的整体比例。
- 修复 Claude CLI 聊天同步问题，让运行时回复能以增量方式更稳定地回流到 ChatPage，而不是卡在占位文案。
- 增强 provider 指引与连接诊断，尤其是对 Anthropic-compatible 网关和混合协议场景的说明。

### 发布产物

- macOS arm64 DMG：`Assistant Desk-0.1.5-arm64.dmg`
- macOS arm64 ZIP：`Assistant Desk-0.1.5-arm64.zip`
- macOS x64 DMG：`Assistant Desk-0.1.5-x64.dmg`
- macOS x64 ZIP：`Assistant Desk-0.1.5-x64.zip`

### 说明

- 面向使用者，优先推荐下载 `.dmg` 安装包。
- Profiles help 与 provider 命名现在更明确地区分了 Anthropic-compatible 和 OpenAI-compatible 两种接入方式。
- 由于当前构建未进行 notarization，macOS 可能会在首次打开时提示安全确认。
- 因环境中未配置完整的 Apple notarization 凭据，本次发布跳过了 notarization。

### 安装

1. 从 Releases 下载最新的 `.dmg`。
2. 打开磁盘镜像，将 Assistant Desk 拖入 Applications。
3. 如果 macOS 阻止打开，可右键应用并选择“打开”。

### 当前限制

- 本版本暂未启用 Apple notarization。
- 当前发布产物仍以 arm64 和 x64 两套独立 macOS 构建提供。
- Claude CLI 运行态检查仍然依赖 PTY / debug log 观察，因此消息同步属于 best-effort，而不是官方结构化事件流。
