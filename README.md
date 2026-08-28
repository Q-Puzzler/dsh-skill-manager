# dsh-skill-manager

English | [中文](README.zh.md)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Q-Puzzler/dsh-skill-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Q-Puzzler/dsh-skill-manager/actions/workflows/ci.yml)

A skill manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): browse, install, update and uninstall [skills.sh](https://www.skills.sh/) skills from a dedicated page in the dsh WebUI settings.

> Tested against dsh **0.1.1-rc.2**. dsh 0.1.x is a developer preview with no semver guarantees.

## Features

- **Search & browse** — keyword search of the skills.sh Catalog; each result shows the name, install count, a lazily loaded description, and a link to its skills.sh page.
- **One-click install** — skills land in the dsh Skills Directory (`~/.dsh/skills`), discovered by dsh without a restart. Skills from other sources sharing the same name are distinguished by Source + name, never mismarked as installed.
- **Update management** — one-click update checks against the Source's latest commit, with three clear states per skill: **Update Available**, **Up to date**, and **Source Invalid** (the local copy keeps working; updates are disabled, uninstall stays available).
- **Confirmation before mutation** — reinstalls, overwrites, updates and uninstalls all require explicit confirmation; if an update would overwrite files you edited locally, the confirmation says so first.
- **Path safety** — every write is confined to the Skills Directory, enforced host-side: Skill IDs are validated against the dsh name grammar, Source segments against GitHub's owner/repo rules, tarball entries are filtered (no path traversal, absolute paths, or symlinks), and directories the plugin does not manage are never touched.

## Installation

Requires [dsh](https://github.com/deepseek-ai/deepseek-harness).

```bash
dsh plugin --profile web add @q-puzzler/dsh-skill-manager
```

This is the recommended path: the npm package ships prebuilt bundles, so there is no install-time build and no pnpm `allowBuilds` entry to manage.

Then restart `dsh web`, hard-refresh the browser, and open **Settings → Skill Manager**.

### Install from GitHub source

Alternatively, install from the git source. This path requires pnpm on your PATH (tested with pnpm 11.24) and builds the host and client bundles at install time via a `prepare` script:

```bash
dsh plugin --profile web add github:Q-Puzzler/dsh-skill-manager
```

pnpm ≥ 10 blocks build scripts of git-hosted dependencies by default, so the first install fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Copy the **full key** pnpm prints (package name plus codeload tarball URL — the bare package name alone does not work) into the `allowBuilds` section of the profile's `pnpm-workspace.yaml` (at `~/.dsh/profiles/<profile>/`):

```yaml
allowBuilds:
  '@q-puzzler/dsh-skill-manager@https://codeload.github.com/Q-Puzzler/dsh-skill-manager/tar.gz/<commit-sha>': true
```

Then re-run the same `add` command.

> The key embeds a commit SHA, so it changes with every new commit of the plugin. When an install or upgrade fails again, copy the new key from pnpm's error message the same way.

### Verify the installation

```bash
dsh --profile web --dump-config
```

The output should contain a `skill-manager` layer (`# == @q-puzzler/dsh-skill-manager` and `- id: skill-manager`).

## Usage

Everything happens in the dsh WebUI under **Settings → Skill Manager**:

- **Search** skills by keyword; follow a result's link to its skills.sh page.
- **Install** from the results list. Already-managed skills show as installed; reinstalling one, or overwriting an unmanaged same-named directory, asks for confirmation first.
- **Manage** the installed list: check updates for everything at once, then update or uninstall individual skills — always behind a confirmation dialog.

## Runtime requirements & expected warnings

- **WebUI profile required.** This plugin's entire surface lives in the dsh WebUI (host routes on the `webServer` service, a settings section in the client), so install it into a profile that provides `webServer` — e.g. the `web` profile. Installing into a profile **without** a WebUI is harmless: the plugin stays idle (no routes registered, nothing mounted), the profile boots normally, and the host log carries one warning explaining why.
- **Expected pnpm peer warnings.** During install pnpm may print `missing peer` warnings for `@deepseek-ai/cordis` and the `@deepseek-ai/dsh-client-*` packages. These are expected and safe to ignore: they are declared as peer dependencies because dsh supplies them at runtime through its own module graph — they must not be installed into the plugin itself.

## Development

```bash
pnpm install
pnpm build       # tsdown → lib/ (host + client bundles)
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
```

## Documentation

- `CONTEXT.md` — domain language (Catalog, Source, Managed Skill, Registry, …)
- `docs/adr/` — architecture decisions (download bridge, Registry, description source, confirmation, host/client seam, HTTP routes)

## License

[Apache-2.0](LICENSE)
