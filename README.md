# dsh-skill-manager

A DeepSeek Harness (dsh) plugin for browsing, installing, updating and uninstalling skills from [skills.sh](https://www.skills.sh/), with a dedicated entry in the dsh WebUI settings.

> Work in progress. 当前进度：T4（已安装技能管理——列表、卸载、更新，端到端）已完成——设置页新增已安装区块（名称、Source、安装时间、空态），一键检查更新（commit SHA 比对 → Update Available badge；404 类响应 → Source Invalid badge：禁更新、保卸载），更新复用安装管线原子替换（本地修改在确认流中警告，任何失败保留旧版本与 Registry），卸载经两段式 Confirmation 删除目录与 Registry 记录、Unmanaged 目标一律拒绝。

## 功能（T4）

在 T3 基础上新增：

- `POST /skill-manager/api/check-updates`：对每个 Registry 记录查询 Source 默认分支上该技能路径的最新 commit（GitHub API，与安装同款 helper），与记录的 commitSha 比对 → 每技能 `{updateAvailable, sourceInvalid, latestCommitSha?, error?}`。404/410 或路径无 commit → sourceInvalid 并**持久化到记录**（list-installed 直接带 badge、update 无需联网即可拒绝；健康复查自动清除）；其他网络/上游失败 → 每技能可重试 error，不标记失效。逐技能检查串行经过与安装/更新/卸载相同的 per-skill 互斥锁，网络并发受 fetchConcurrency 上限约束。
- `POST /skill-manager/api/update`（body `{skillId, confirm?}`）：两段式 Confirmation——确认前重算目录内容哈希，与记录不符即本地修改，confirmation-required 响应携带 `localModified: true`（确认门在任何网络/写入之前）。记录 sourceInvalid → 409 拒绝（卸载仍可用）；无记录 → not-managed 拒绝。确认后复用安装管线（解析 HEAD → tarball → 白名单解出 → 暂存 → 备份换入，失败回滚），刷新记录（commitSha、contentHash、新增 updatedAt；installedAt 保留、sourceInvalid 清除）；任何失败保留旧版本与 Registry 不变。
- `POST /skill-manager/api/uninstall`（body `{skillId, confirm?}`）：零网络。只作用于 Registry 登记目标——重新校验 skillId 语法 + 目标路径 resolve 前缀校验；无记录 → not-managed 结构化错误（绝不删除 Unmanaged 目录）；目录缺失但记录在 → 仅删记录（良性）。先删目录后删记录，记录删除失败重试可自愈。
- Registry 记录新增可选字段：`sourceInvalid`（持久化的 Source 失效标记）、`updatedAt`（最近更新时间；installedAt 始终为首次安装时间）。
- 设置页：搜索区下方新增已安装区块——Managed Skill 列表（名称、Source、安装时间）、空态、加载失败可重试；全局「检查更新」按钮（在途防重）；Update Available / Source Invalid badge（Source Invalid 禁用更新、保留卸载）；每行更新/卸载按钮复用共享 ConfirmModal（更新弹窗在本地修改时显示覆盖警告）；host 错误按 code 本地化（not-managed / source-invalid / skill-not-found）。中文文案 + en 镜像。

## 功能（T3）

在 T2 基础上新增：

- `POST /skill-manager/api/install`（body `{source, skillId, confirm?}`）：安装管线（ADR-0001）——校验 Skill ID / Source → 解析 Source 默认分支 HEAD commit（GitHub API）→ 下载 codeload tarball → 与简介相同的探测顺序（`skills/<id>/` → `<id>/` → 仓库根）定位技能子目录 → 严格白名单只解出普通文件（全档扫描拒绝绝对路径与 `..` 条目、跳过 symlink/hardlink、逐文件 resolve 前缀校验）→ Skills Directory 内暂存 → 原子重命名到位（已存在时先换出备份，失败回滚）→ sha256 内容哈希（排序相对路径 + 文件内容）→ 写入 Registry 记录（`~/.dsh/skills/.skill-manager/<skillId>.json`：source、skillId、skillPath、installedAt、commitSha——技能路径上最后 commit、contentHash）。
- 两段式 Confirmation 协议（ADR-0004）首次落地：目标不存在 → 直接安装；目标已 Managed → 重装需确认；目标为 Unmanaged 同名目录 → Overwrite 需确认。未带 `confirm: true` 的需确认调用返回 `{status:'confirmation-required', action, skillId, source, targetPath}` 且零写入零网络；host 不信任 UI 已询问。
- `GET /skill-manager/api/list-installed`：Registry 中全部 Managed Skill 记录（畸形记录跳过）。
- 新增 Config 字段：`githubApiBase`（默认 `https://api.github.com`）、`githubCodeloadBase`（默认 `https://codeload.github.com`）、`installFetchTimeoutMs`（默认 30000）、`skillsDir`（默认按 dsh 解析 `$DSH_HOME/skills`，缺省 `~/.dsh/skills`）。
- 设置页：每条结果提供安装按钮（安装 / 安装中 / 已安装——点击即重装走确认 / 失败可重试），「已安装」状态来自 list-installed；共享 Confirmation modal（写明技能、Source、目标路径、动作：重装/覆盖安装，确认/取消）承载两段式流程。

## 功能（T2）

- 设置页注册进 `settings.section` slot（id `skill-manager`，order 20），与内置设置区同款 seam。
- host 侧 SkillManager 服务在 `ctx.webServer` 上注册插件独立前缀 `/skill-manager/api`：
  - `GET /skill-manager/api/search?q=<关键词>`：代理 Catalog 搜索 API，返回名称、Skill ID、Source、安装量、Catalog 页面 URL。
  - `GET /skill-manager/api/fetch-description?source=<owner/repo>&skillId=<id>`：从 Source 仓库 SKILL.md frontmatter 解析简介（探测顺序 `skills/<id>/SKILL.md` → `<id>/SKILL.md` → 根 `SKILL.md`），带缓存与并发上限；任何失败静默返回 `null`（页面显示「暂无简介」）。
- 部署可调值均为带默认值的插件 Config 字段：`catalogUrl`、`githubRawBase`、`fetchConcurrency`、`descriptionCacheMaxEntries`。
- 设置页 i18n：`ctx.locale.register` 双语词典（zh-CN 默认 + en）。


## 安装

对照 dsh 0.1.1-rc.2 实测（dsh 0.1.x 为 preview，无 semver 承诺）。`dsh plugin add` 会转发到 profile 目录下的 pnpm，请确保环境中 pnpm 可用（实测 pnpm 11.24）。

从 GitHub 源安装（示例用 `web` profile，替换为目标 profile 名）：

```bash
dsh plugin --profile web add github:Q-Puzzler/dsh-skill-manager
```

### 用户侧前置步骤：allowBuilds

仓库以自包含 `prepare` 脚本在安装时构建 host 与 client 产物。pnpm ≥ 10 默认拦截 git 依赖的构建脚本，首次安装会失败并报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`：

```
The git-hosted package "@q-puzzler/dsh-skill-manager@<version>" needs to execute build scripts
but is not in the "allowBuilds" allowlist.

Add the package to "allowBuilds" in your project's pnpm-workspace.yaml to allow it to run scripts.
For example:
allowBuilds:
  @q-puzzler/dsh-skill-manager@https://codeload.github.com/Q-Puzzler/dsh-skill-manager/tar.gz/<commit-sha>: true
```

把报错中打印的**完整 key**（`包名@codeload-tarball-URL` 形式；实测仅写包名不生效）加入 profile 的 `pnpm-workspace.yaml`（位于 `~/.dsh/profiles/<profile>/`），然后重跑同一条 `add` 命令：

```yaml
allowBuilds:
  '@q-puzzler/dsh-skill-manager@https://codeload.github.com/Q-Puzzler/dsh-skill-manager/tar.gz/<commit-sha>': true
```

注意：该 URL 内含 commit SHA，插件每次更新到新提交后需把 key 更新为 pnpm 新打印的值。

### 验证安装

```bash
dsh --profile web --dump-config
```

输出中应出现 `skill-manager` 层（`# == @q-puzzler/dsh-skill-manager` 与 `- id: skill-manager`）。随后重启 dsh web 并硬刷新浏览器；client 产物由 `/plugins/@q-puzzler/dsh-skill-manager/client.js` 伺服。
