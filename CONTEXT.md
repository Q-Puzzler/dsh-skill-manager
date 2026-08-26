# dsh-skill-manager

Domain language for a dsh plugin that lets users browse, install, update and uninstall skills from the Catalog, surfaced as a dedicated entry in the dsh WebUI settings.

## Language

**Catalog**:
skills.sh — the sole online data source for searching and linking Skills.
_Avoid_: marketplace, store, registry

**Skill**:
An agent skill: a directory containing a `SKILL.md` whose YAML frontmatter carries a `name` (lowercase alphanumerics and hyphens) and a `description`.
_Avoid_: plugin, extension, package

**Source**:
The GitHub repository (`owner/repo`) that hosts one or more Skills, typically under a `skills/<name>/` layout.
_Avoid_: publisher, origin, registry

**Skill ID**:
The Skill's directory name within its Source; also the last path segment of its Catalog page URL. Must match the dsh skill-name grammar.
_Avoid_: slug, key

**Skills Directory**:
The dsh user-level skills root (`~/.dsh/skills`), which dsh watches for automatic skill discovery.
_Avoid_: install dir, target folder

**Managed Skill**:
A Skill installed into the Skills Directory by this plugin and recorded in the Registry. Only Managed Skills are listed, updated, or uninstalled by the plugin.
_Avoid_: installed skill (ambiguous — see Unmanaged Skill)

**Unmanaged Skill**:
A skill directory present in the Skills Directory but not recorded in the Registry (e.g. placed manually). The plugin never updates or deletes it, but installing a same-named Skill over it is an Overwrite.
_Avoid_: foreign skill, orphan skill

**Registry**:
The plugin's record of Managed Skills: Source, Skill ID, install time, and the Source commit the install was taken from. The sole authority for "managed by this plugin".
_Avoid_: database, index, state file

**Description**:
The `description` field of a Skill's SKILL.md frontmatter. Not returned by the Catalog search API; fetched from the Source.

**Update Available**:
State of a Managed Skill whose Source has a newer commit than the one recorded in the Registry.
_Avoid_: outdated, stale

**Overwrite**:
Installing a Skill whose target directory already exists in the Skills Directory, whether Managed or Unmanaged. Always requires Confirmation.
_Avoid_: reinstall, force-install

**Source Invalid**:
State of a Managed Skill whose Source is unreachable or no longer contains the Skill. The local copy keeps working; updates are impossible; uninstall remains allowed.
_Avoid_: broken skill, dead link

**Confirmation**:
Explicit user approval required before any Overwrite, update, or uninstall. Enforced on the host side, not merely in the UI.
_Avoid_: prompt, dialog

**Path Safety**:
The invariant that every write, update, and delete performed by the plugin stays inside the Skills Directory.
_Avoid_: sandboxing
