# dsh-skill-manager

A DeepSeek Harness (dsh) plugin for browsing, installing, updating and uninstalling skills from [skills.sh](https://www.skills.sh/), with a dedicated entry in the dsh WebUI settings.

> Work in progress. 当前进度：T3（安装技能，端到端）已完成——每条搜索结果提供安装入口，一键落入 Skills Directory（dsh 无需重启即可发现），每次安装写入 Registry 记录；Managed 结果显示「已安装」，重装与覆盖 Unmanaged 同名目录均走两段式 Confirmation（host 强制，未确认零写入）。更新/卸载将在后续 ticket 落地。

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
