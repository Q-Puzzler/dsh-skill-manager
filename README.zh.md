# dsh-skill-manager

[English](README.md) | 中文

[![许可证](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的技能管理插件：在 dsh WebUI 的设置页里浏览、安装、更新和卸载 [skills.sh](https://www.skills.sh/) 上的技能。

> 已在 dsh **0.1.1-rc.2** 上实测。dsh 0.1.x 处于开发者预览阶段，不承诺版本兼容性。

## 功能

- **搜索浏览**——按关键词搜索 skills.sh 目录；每条结果显示名称、安装量、简介（懒加载）和它的 skills.sh 页面链接。
- **一键安装**——技能装入 dsh 技能目录（`~/.dsh/skills`），dsh 自动发现，无需重启。不同来源的同名技能按"来源加名称"区分，不会被误标为已安装。
- **更新管理**——一键对照来源仓库的最新提交检查更新，每个技能的状态一目了然：**有更新**、**已是最新**、**来源失效**（本地副本仍可使用，更新被禁用，卸载不受限）。
- **改动前必确认**——重装、覆盖、更新和卸载都需要你明确确认；如果更新会覆盖你本地改过的文件，确认框会提前说明。
- **路径安全**——所有写入都被限制在技能目录内，由 host 侧强制：技能名按 dsh 的命名规则校验，来源按 GitHub 的 owner/repo 规则校验，压缩包条目经过滤（拦截路径穿越、绝对路径和符号链接），不归插件管理的目录一概不碰。

## 安装

需要 [dsh](https://github.com/deepseek-ai/deepseek-harness)，以及 pnpm（已在 pnpm 11.24 上实测）。

```bash
dsh plugin --profile web add github:Q-Puzzler/dsh-skill-manager
```

装完重启 `dsh web`，强制刷新浏览器页面，然后打开**设置 → Skill Manager**。

### pnpm ≥ 10：放行构建脚本

插件在安装时会通过 `prepare` 脚本现场构建 host 和 client 产物，而 pnpm ≥ 10 默认禁止 git 来源的依赖执行构建脚本，所以首次安装会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。把报错里 pnpm 打印的**完整 key**（包名加压缩包地址，只写包名不生效）复制到 profile 的 `pnpm-workspace.yaml`（位于 `~/.dsh/profiles/<profile>/`）的 `allowBuilds` 段里：

```yaml
allowBuilds:
  '@q-puzzler/dsh-skill-manager@https://codeload.github.com/Q-Puzzler/dsh-skill-manager/tar.gz/<commit-sha>': true
```

然后重跑同一条安装命令。

> 这个 key 里含有提交哈希，插件每有新提交它就会变。以后安装或升级再次失败时，照同样的方式抄一次新 key 即可。

### 验证安装

```bash
dsh --profile web --dump-config
```

输出里应当包含 `skill-manager` 层（`# == @q-puzzler/dsh-skill-manager` 和 `- id: skill-manager` 两行）。

## 使用

一切都在 dsh WebUI 的**设置 → Skill Manager** 页面里完成：

- **搜索**：按关键词搜索技能，点结果里的链接打开它的 skills.sh 页面。
- **安装**：在结果列表里直接安装。已管理的技能会显示为已安装；重装它、或者覆盖一个同名的未管理目录，都会先向你确认。
- **管理**：在已安装列表里一键检查全部技能的更新，再逐个更新或卸载——每一步都有确认框。

## 运行要求与预期警告

- **需要带 WebUI 的 profile**。插件的全部功能都在 dsh WebUI 里（host 路由挂在 `webServer` 服务上，设置页面由 client 提供），请把它装进提供 `webServer` 的 profile，例如 `web`。装进没有 WebUI 的 profile 也无害：插件保持静默（不注册路由、不挂载界面），profile 照常启动，host 日志里只有一条说明原因的警告。
- **pnpm 的 peer 警告属预期**。安装时 pnpm 可能打印 `@deepseek-ai/cordis` 和 `@deepseek-ai/dsh-client-*` 的 missing peer 警告。这些依赖由 dsh 在运行时通过自己的模块图提供，警告属预期，忽略即可，千万不要把它们装进插件本身。

## 开发

```bash
pnpm install
pnpm build       # tsdown → lib/（host 和 client 产物）
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
```

## 文档

- `CONTEXT.md`——领域语言（Catalog、Source、Managed Skill、Registry 等）
- `docs/adr/`——架构决策记录（下载桥接、Registry、简介来源、确认协议、host/client 分界、HTTP 路由）

## 许可证

[Apache-2.0](LICENSE)
