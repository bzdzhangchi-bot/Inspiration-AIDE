# Assistant Desk 0.1.4

## English

Assistant Desk 0.1.4 is a focused agent workflow and project UX release for improving day-to-day coding sessions, with stronger profile management, better Native Agent visibility, and a more practical built-in Git workflow.

### Highlights

- Added a JetBrains-like built-in Git workspace with staged and unstaged change lists, diff preview, and commit actions.
- Added a Native Agent Inspector that shows workspace memory, assembled model inputs, recent tool activity, and captured request payloads.
- Improved profile management with per-profile chat history, default profile controls, profile help, duplication and removal actions, and local Copilot gateway support in Native Agent mode.
- Refined project and chat UX with current branch display in the Project header, clickable branch navigation to Git, smaller chat typography, and a more reliable assistant drawer toggle.

### Included artifacts

- macOS arm64 DMG: `Assistant Desk-0.1.4-arm64.dmg`
- macOS arm64 ZIP: `Assistant Desk-0.1.4-arm64.zip`
- macOS x64 DMG: `Assistant Desk-0.1.4-x64.dmg`
- macOS x64 ZIP: `Assistant Desk-0.1.4-x64.zip`

### Notes

- Recommended download for end users: the `.dmg` artifact.
- Native Agent now injects selected workspace memory excerpts into its prompt and exposes those inputs directly in the inspector for easier debugging.
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

### Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Assistant Desk into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

### Known limitations

- Apple notarization is not enabled for this release.
- Release assets are currently provided as separate arm64 and x64 macOS builds.
- Claude CLI runtime inspection still depends on PTY and debug-log observation, so only Native Agent can show the exact assembled request payload.

---

## 中文

Assistant Desk 0.1.4 是一次聚焦于 agent 工作流与项目交互体验的更新，同时补充了更强的 profile 管理能力、更可见的 Native Agent 调试能力，以及更实用的内置 Git 工作区。

### 版本亮点

- 新增类似 JetBrains 的内置 Git 工作区，支持 staged / unstaged 变更列表、diff 预览和提交操作。
- 新增 Native Agent Inspector，可查看工作区 memory、实际组装后的模型输入、最近工具调用，以及捕获到的请求载荷。
- 增强 profile 管理，支持按 profile 保存聊天历史、默认 profile 控制、profile 帮助、复制/删除操作，以及 Native Agent 模式下的本地 Copilot gateway。
- 优化项目和聊天体验，在 Project 头部显示当前分支并可点击跳转 Git，减小聊天字体，并修复 Assistant 抽屉切换不稳定的问题。

### 发布产物

- macOS arm64 DMG：`Assistant Desk-0.1.4-arm64.dmg`
- macOS arm64 ZIP：`Assistant Desk-0.1.4-arm64.zip`
- macOS x64 DMG：`Assistant Desk-0.1.4-x64.dmg`
- macOS x64 ZIP：`Assistant Desk-0.1.4-x64.zip`

### 说明

- 面向使用者，优先推荐下载 `.dmg` 安装包。
- Native Agent 现在会把筛选后的 workspace memory 摘要注入提示词，并在 Inspector 中直接展示这些输入，便于排查与调优。
- 由于当前构建未进行 notarization，macOS 可能会在首次打开时提示安全确认。
- 因环境中未配置完整的 Apple notarization 凭据，本次发布跳过了 notarization。

### 安装

1. 从 Releases 下载最新的 `.dmg`。
2. 打开磁盘镜像，将 Assistant Desk 拖入 Applications。
3. 如果 macOS 阻止打开，可右键应用并选择“打开”。

### 当前限制

- 本版本暂未启用 Apple notarization。
- 当前发布产物仍以 arm64 和 x64 两套独立 macOS 构建提供。
- Claude CLI 运行态检查仍依赖 PTY 与 debug log 观察，因此只有 Native Agent 能展示精确的最终请求载荷。