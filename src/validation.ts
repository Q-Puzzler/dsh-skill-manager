/**
 * Skill ID and Source validation, shared by every ticket that turns Catalog
 * data into paths or URLs (Path Safety, CONTEXT.md). A Skill ID follows the
 * dsh skill-name grammar; a Source is a GitHub `owner/repo` pair whose two
 * segments are validated independently.
 */

/** dsh skill-name grammar (matches dsh 0.1.1-rc.2 skill identity rules). */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A Skill ID is the Skill's directory name within its Source. */
export function isValidSkillId(value: string): boolean {
  return SKILL_ID_PATTERN.test(value)
}

/**
 * GitHub login segment: alphanumerics and inner hyphens, max 39 chars
 * (GitHub username/org rules; owners are case-insensitive, uppercase legal).
 */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

/**
 * GitHub repository segment: alphanumerics plus `-`, `_`, `.`, max 100 chars.
 * `.`/`..` and any `..` run are rejected by parseSource before this test.
 */
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

/** A validated Source (GitHub repository hosting one or more Skills). */
export interface SourceRef {
  owner: string
  repo: string
}

/**
 * Parse a Catalog `owner/repo` Source into validated segments. Returns
 * undefined for anything malformed: wrong segment count, empty segments,
 * GitHub-illegal characters, or any `..` (path-traversal guard — Source
 * segments become URL and filesystem path parts downstream).
 */
export function parseSource(source: string): SourceRef | undefined {
  if (source.length === 0 || source.includes('..')) return undefined
  const segments = source.split('/')
  if (segments.length !== 2) return undefined
  const [owner, repo] = segments
  if (!OWNER_PATTERN.test(owner)) return undefined
  if (repo === '.' || !REPO_PATTERN.test(repo)) return undefined
  return { owner, repo }
}
