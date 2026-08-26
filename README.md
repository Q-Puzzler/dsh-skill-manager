# dsh-skill-manager

A DeepSeek Harness (dsh) plugin for browsing, installing, updating and uninstalling skills from [skills.sh](https://www.skills.sh/), with a dedicated entry in the dsh WebUI settings.

> Work in progress.

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
