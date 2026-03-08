# Assistant Desk 0.1.4

## English

Assistant Desk 0.1.4 is a workflow-focused release for day-to-day coding sessions, centered on a built-in Git workspace, broader Native Agent coverage, and a small but important workspace stability fix.

### Highlights

- Added a JetBrains-like built-in Git workspace with staged and unstaged change lists, diff preview, and commit actions.
- Expanded Native Agent workflows with better inspector visibility, richer workspace-context handling, and improved local coding-task support.
- Fixed a workspace-context render loop that could trigger unnecessary rerenders while working inside the desktop workspace.
- Refined project and chat UX with current-branch visibility in the Project header and tighter integration between project navigation and Git.

### Included artifacts

- macOS arm64 DMG: `Assistant Desk-0.1.4-arm64.dmg`
- macOS arm64 ZIP: `Assistant Desk-0.1.4-arm64.zip`
- macOS x64 DMG: `Assistant Desk-0.1.4-x64.dmg`
- macOS x64 ZIP: `Assistant Desk-0.1.4-x64.zip`

### Notes

- Recommended download for end users: the `.dmg` artifact.
- Native Agent now exposes more of its assembled runtime context in the inspector, making prompt/input debugging easier during local workflows.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

### Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Assistant Desk into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

### Known limitations

- Apple notarization is not enabled for this release.
- Release assets are currently provided as separate arm64 and x64 macOS builds.
- Exact runtime request inspection is still strongest in Native Agent mode; CLI-style runtimes remain more limited.

---

## 中文

Assistant Desk 0.1.4 是一次聚焦工作流体验的更新，重点落在内置 Git 工作区、更完整的 Native Agent 工作流，以及一处影响工作区稳定性的修复。

### 版本亮点

- 新增类似 JetBrains 的内置 Git 工作区，支持 staged / unstaged 变更列表、diff 预览和提交操作。
- 扩展了 Native Agent 工作流，增强 Inspector 可见性、workspace context 处理能力，以及本地编码任务下的可用性。
- 修复了 workspace context 的渲染循环问题，减少桌面工作区中的不必要重复渲染。
- 优化项目与聊天体验，在 Project 头部展示当前分支，并加强项目导航与 Git 之间的联动。

### 发布产物

- macOS arm64 DMG：`Assistant Desk-0.1.4-arm64.dmg`
- macOS arm64 ZIP：`Assistant Desk-0.1.4-arm64.zip`
- macOS x64 DMG：`Assistant Desk-0.1.4-x64.dmg`
- macOS x64 ZIP：`Assistant Desk-0.1.4-x64.zip`

### 说明

- 面向使用者，优先推荐下载 `.dmg` 安装包。
- Native Agent 现在会在 Inspector 中展示更多运行时组装上下文，便于排查本地工作流中的提示词与输入问题。
- 由于当前构建未进行 notarization，macOS 可能会在首次打开时提示安全确认。
- 因环境中未配置完整的 Apple notarization 凭据，本次发布跳过了 notarization。

### 安装

1. 从 Releases 下载最新的 `.dmg`。
2. 打开磁盘镜像，将 Assistant Desk 拖入 Applications。
3. 如果 macOS 阻止打开，可右键应用并选择“打开”。

### 当前限制

- 本版本暂未启用 Apple notarization。
- 当前发布产物仍以 arm64 和 x64 两套独立 macOS 构建提供。
- 精确的运行时请求检查目前仍以 Native Agent 模式支持得更完整，CLI 风格运行时相对受限。
