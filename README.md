# dsh-skill-manager

A DeepSeek Harness (dsh) plugin for browsing, installing, updating and uninstalling skills from the [skills.sh](https://www.skills.sh/) Catalog, with a dedicated entry in the dsh WebUI settings.

Tested against dsh **0.1.1-rc.2** (dsh 0.1.x is a preview series with no semver guarantees).

## Features

- **Search & browse the Catalog** — keyword search from the settings page; each result shows the skill name, install count, a lazily loaded description (from the Source's `SKILL.md` frontmatter), and a link to its skills.sh page.
- **Install** — one-click install into the dsh Skills Directory (`~/.dsh/skills`), discovered by dsh without a restart. Already-managed skills show as installed; reinstalling a Managed Skill and overwriting an Unmanaged same-named directory both require an explicit two-phase Confirmation.
- **Manage installed skills** — list of Managed Skills (name, Source, install time), one-click update checks against the Source's latest commit, update and uninstall (both behind Confirmation). Skills with a newer upstream commit carry an **Update Available** badge; skills whose Source no longer contains them carry a **Source Invalid** badge (local copy keeps working, updates disabled, uninstall still allowed).
- **Local modification warning** — if you edited a Managed Skill's files, the update Confirmation warns that your changes will be overwritten.
- **Path safety** — every write is confined to the Skills Directory, enforced on the host side: Skill ID and Source segments are validated against the dsh name grammar, tarball entries are filtered (no path traversal, absolute paths, or symlinks), and the plugin never touches directories it does not manage.

## Installation

From a GitHub source (example uses the `web` profile — substitute your target profile name):

```bash
dsh plugin --profile web add github:Q-Puzzler/dsh-skill-manager
```

`dsh plugin add` delegates to pnpm inside the profile directory, so pnpm must be available on your PATH (tested with pnpm 11.24).

### Prerequisite: pnpm allowBuilds (pnpm ≥ 10)

The repository builds its host and client bundles at install time via a self-contained `prepare` script. pnpm ≥ 10 blocks build scripts of git-hosted dependencies by default, so the first install fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`:

```
The git-hosted package "@q-puzzler/dsh-skill-manager@<version>" needs to execute build scripts
but is not in the "allowBuilds" allowlist.

Add the package to "allowBuilds" in your project's pnpm-workspace.yaml to allow it to run scripts.
For example:
allowBuilds:
  @q-puzzler/dsh-skill-manager@https://codeload.github.com/Q-Puzzler/dsh-skill-manager/tar.gz/<commit-sha>: true
```

Copy the **full key** pnpm prints (package name plus codeload tarball URL — the bare package name alone does not work) into the `allowBuilds` section of the profile's `pnpm-workspace.yaml` (at `~/.dsh/profiles/<profile>/`), then re-run the same `add` command:

```yaml
allowBuilds:
  '@q-puzzler/dsh-skill-manager@https://codeload.github.com/Q-Puzzler/dsh-skill-manager/tar.gz/<commit-sha>': true
```

Note: the URL embeds a commit SHA, so the key changes with every new commit of the plugin. When an install or upgrade fails again, just copy the new key from pnpm's error message the same way.

### Verify

```bash
dsh --profile web --dump-config
```

The output should contain a `skill-manager` layer (`# == @q-puzzler/dsh-skill-manager` and `- id: skill-manager`). Then restart `dsh web` and hard-refresh the browser — a **Skill Manager** section appears in the settings sidebar. The client bundle is served at `/plugins/@q-puzzler/dsh-skill-manager/client.js`.

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
