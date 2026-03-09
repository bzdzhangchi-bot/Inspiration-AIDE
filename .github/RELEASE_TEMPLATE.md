# Inspiration <version>

Use this file as the source template for future release notes.

Suggested workflow:

1. Copy this file to `.github/RELEASE_NOTES_v<version>.bilingual.md` as the default release note source.
2. Replace placeholders like `<version>`, `<headline>`, `<scope>`, and artifact names.
3. If needed, derive `.github/RELEASE_NOTES_v<version>.md` and `.github/RELEASE_NOTES_v<version>.zh-CN.md` from the corresponding sections below.
4. Publish the final body with `gh release edit v<version> --notes-file <file>`.

---

## Bilingual Template

```md
# Inspiration <version>

## English

Inspiration <version> is a focused <headline> release for <scope>, with <secondary-summary>.

### Highlights

- <highlight-1>
- <highlight-2>
- <highlight-3>
- <optional-highlight-4>

### Included artifacts

- macOS arm64 DMG: `Inspiration-<version>-arm64.dmg`
- macOS arm64 ZIP: `Inspiration-<version>-arm64.zip`
- macOS x64 DMG: `Inspiration-<version>-x64.dmg`
- macOS x64 ZIP: `Inspiration-<version>-x64.zip`

### Notes

- Recommended download for end users: the `.dmg` artifact.
- <carry-forward-note>
- The app may show macOS security prompts because this build is not notarized.
- Apple notarization was skipped for this build because notarization credentials were not configured in the environment.

### Install

1. Download the latest `.dmg` from Releases.
2. Open the disk image and drag Inspiration into Applications.
3. If macOS blocks launch, right-click the app and choose Open.

### Known limitations

- Apple notarization is not enabled for this release.
- Release assets are currently provided as separate arm64 and x64 macOS builds.
- <optional-known-limitation>

---

## 中文

Inspiration <version> 是一次聚焦于<headline>的更新，同时补充了<secondary-summary>。

### 版本亮点

- <highlight-1-zh>
- <highlight-2-zh>
- <highlight-3-zh>
- <optional-highlight-4-zh>

### 发布产物

- macOS arm64 DMG：`Inspiration-<version>-arm64.dmg`
- macOS arm64 ZIP：`Inspiration-<version>-arm64.zip`
- macOS x64 DMG：`Inspiration-<version>-x64.dmg`
- macOS x64 ZIP：`Inspiration-<version>-x64.zip`

### 说明

- 面向使用者，优先推荐下载 `.dmg` 安装包。
- <carry-forward-note-zh>
- 由于当前构建未进行 notarization，macOS 可能会在首次打开时提示安全确认。
- 因环境中未配置完整的 Apple notarization 凭据，本次发布跳过了 notarization。

### 安装

1. 从 Releases 下载最新的 `.dmg`。
2. 打开磁盘镜像，将 Inspiration 拖入 Applications。
3. 如果 macOS 阻止打开，可右键应用并选择“打开”。

### 当前限制

- 本版本暂未启用 Apple notarization。
- 当前发布产物仍以 arm64 和 x64 两套独立 macOS 构建提供。
- <optional-known-limitation-zh>
```

---

## Optional split files

- English-only file: copy the `## English` section into `.github/RELEASE_NOTES_v<version>.md`
- Chinese-only file: copy the `## 中文` section into `.github/RELEASE_NOTES_v<version>.zh-CN.md`
