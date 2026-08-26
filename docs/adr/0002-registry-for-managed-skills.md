# Metadata registry marks Managed Skills

"List skills managed by this plugin" and update detection both require knowing what we installed and from which Source commit. Pure filesystem scanning of the Skills Directory cannot distinguish plugin-installed skills from manually placed ones, so each install records metadata (Source, Skill ID, installed-at, commit SHA, content hash) in a registry directory inside the Skills Directory.

Placement verified against `dsh-skill-filesystem` (dsh 0.1.1-rc.2): a directory without a `SKILL.md` is silently skipped by discovery, and non-`SKILL.md` files inside it never trigger watcher invalidation — so the registry is invisible to dsh. Keeping the metadata out of the skill directories themselves leaves every Managed Skill byte-identical to its upstream content, which makes local-modification detection a simple content-hash comparison.
