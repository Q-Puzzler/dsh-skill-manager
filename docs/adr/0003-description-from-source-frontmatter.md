# Skill descriptions fetched from Source frontmatter, not HTML

The Catalog search API returns name, installs, and Source but no description, while the exam requires showing one per result. The Catalog skill page HTML does not expose the description in a stable, parseable position (verified by fetching pages directly). We instead fetch the raw `SKILL.md` from the Source repository and read its frontmatter `description` — a required field in the skill spec — lazy-loaded per visible result with caching, degrading to a placeholder on failure.

Considered and rejected: scraping the Catalog skill page HTML, whose structure is unstable and already observed to be unreliable.
