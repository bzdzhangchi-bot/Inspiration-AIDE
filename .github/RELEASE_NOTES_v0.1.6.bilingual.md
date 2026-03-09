# Inspiration 0.1.6

## English

Inspiration 0.1.6 is a branding and delivery release focused on making the app feel like a real product: the public name is now `Inspiration`, the icon has been refreshed, and end users can now fetch the latest installer from inside the app.

### Highlights

- Renamed the user-facing app, package artifacts, and in-app branding from `Assistant Desk` to `Inspiration`.
- Replaced the shipped macOS icon with a new minimal white icon treatment to match the new brand direction.
- Added a new `Settings > App` section with in-app update checking, architecture-aware release matching, download progress, and one-click reveal/open for the latest installer.
- Improved version display so development builds show up as local dev builds instead of looking like a published release.

### Included artifacts

- macOS arm64 DMG: `Inspiration-0.1.6-arm64.dmg`
- macOS arm64 ZIP: `Inspiration-0.1.6-arm64.zip`
- macOS x64 DMG: `Inspiration-0.1.6-x64.dmg`
- macOS x64 ZIP: `Inspiration-0.1.6-x64.zip`

### Notes

- Recommended download for end users: the `.dmg` artifact.
- The new in-app updater currently downloads the latest installer and reveals it locally, which is more reliable for unsigned or non-notarized builds than trying to silently replace the running app.
- Existing local data paths remain unchanged for compatibility, so current settings and conversation data continue to load after the rename.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

### Install

1. Download the latest `.dmg` from Releases, or use `Settings > App > Check for updates` inside the app.
2. Open the disk image and drag Inspiration into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

### Known limitations

- Apple notarization is not enabled for this release.
- Release assets are currently provided as separate arm64 and x64 macOS builds.
- The in-app updater currently downloads and opens the installer rather than performing a silent binary swap in place.

---

## 中文

Inspiration 0.1.6 是一次聚焦品牌与交付体验的更新，重点是把应用真正以产品形态推出去：对外名称正式改为 `Inspiration`，图标完成更新，同时用户现在可以直接在应用内拉取最新安装包。

### 版本亮点

- 将对外应用名称、安装包产物名，以及应用内主要品牌文案从 `Assistant Desk` 统一切换为 `Inspiration`。
- 更新 macOS 应用图标，改为新的白色极简视觉方案，和新的品牌方向保持一致。
- 新增 `Settings > App` 页面，支持应用内检查更新、按当前架构匹配最新 release、显示下载进度，并在下载完成后直接打开或定位安装包。
- 优化版本展示方式，让开发态窗口明确显示为本地 dev build，而不是看起来像已经发布的正式版。

### 发布产物

- macOS arm64 DMG：`Inspiration-0.1.6-arm64.dmg`
- macOS arm64 ZIP：`Inspiration-0.1.6-arm64.zip`
- macOS x64 DMG：`Inspiration-0.1.6-x64.dmg`
- macOS x64 ZIP：`Inspiration-0.1.6-x64.zip`

### 说明

- 面向使用者，优先推荐下载 `.dmg` 安装包。
- 当前的应用内更新能力会下载最新安装包并在本地打开/定位，这比对未签名或未 notarize 的构建尝试静默替换更稳妥。
- 为了兼容现有本地数据，内部存储路径保持不变，因此现有设置和对话数据在改名后仍可继续加载。
- 由于当前构建未进行 notarization，macOS 可能会在首次打开时提示安全确认。
- 因环境中未配置完整的 Apple notarization 凭据，本次发布跳过了 notarization。

### 安装

1. 从 Releases 下载最新 `.dmg`，或在应用内使用 `Settings > App > Check for updates`。
2. 打开磁盘镜像，将 Inspiration 拖入 Applications。
3. 如果 macOS 阻止打开，可右键应用并选择“打开”。

### 当前限制

- 本版本暂未启用 Apple notarization。
- 当前发布产物仍以 arm64 和 x64 两套独立 macOS 构建提供。
- 应用内更新当前仍是“下载并打开安装包”模式，而不是静默就地替换运行中的应用。
