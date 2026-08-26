/**
 * Minimal YAML-frontmatter `description` extractor for SKILL.md documents
 * (ADR-0003). Only the single field the Catalog search API does not return is
 * read, so a full YAML dependency is not justified; the fence scanning mirrors
 * dsh's own frontmatter handling in dsh-skill-filesystem. Anything unexpected
 * yields undefined — the caller degrades to the placeholder, never an error.
 */

/** A fence line is exactly `---` (a trailing CR is tolerated). */
function isFence(line: string): boolean {
  return line.replace(/\r$/, '') === '---'
}

const KEY_PATTERN = /^description\s*:\s*(.*)$/
const BLOCK_INDICATOR_PATTERN = /^[>|][+-]?$/

/**
 * Extract the frontmatter `description` scalar. Supports the forms seen in
 * real SKILL.md files: plain scalars (with indented continuation lines),
 * single/double-quoted scalars, and `>`/`|` block scalars. Returns undefined
 * when the frontmatter or the field is missing or empty.
 */
export function extractFrontmatterDescription(markdown: string): string | undefined {
  const firstNewline = markdown.indexOf('\n')
  if (firstNewline < 0 || !isFence(markdown.slice(0, firstNewline))) return undefined
  const lines = markdown.slice(firstNewline + 1).split('\n')
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) {
      end = i
      break
    }
  }
  if (end < 0) return undefined
  const frontmatter = lines.slice(0, end)
  for (let i = 0; i < frontmatter.length; i++) {
    const match = KEY_PATTERN.exec(frontmatter[i])
    if (match === null) continue
    const value = readValue(match[1], frontmatter.slice(i + 1))
    return value === '' ? undefined : value
  }
  return undefined
}

/** Read a scalar value: inline form on the key line, or an indented block. */
function readValue(inline: string, following: string[]): string {
  const trimmed = inline.trim()
  if (BLOCK_INDICATOR_PATTERN.test(trimmed)) {
    return readBlockScalar(following, trimmed.startsWith('>'))
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return readQuoted(trimmed)
  }
  const parts = [stripComment(trimmed)]
  for (const line of following) {
    // A blank line or the next top-level key ends a plain scalar.
    if (line.trim() === '' || !/^\s/.test(line)) break
    parts.push(stripComment(line.trim()))
  }
  return parts.filter((part) => part !== '').join(' ').trim()
}

/** Consume the indented lines of a `>` (folded) or `|` (literal) block scalar. */
function readBlockScalar(lines: string[], folded: boolean): string {
  const taken: string[] = []
  for (const line of lines) {
    if (line.trim() !== '' && !/^\s/.test(line)) break
    taken.push(line)
  }
  const indent = Math.min(
    ...taken.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length),
  )
  const body = taken.map((line) => (line.trim() === '' ? '' : line.slice(indent)))
  return (folded ? body.join(' ') : body.join('\n')).trim()
}

/** Unquote a same-line quoted scalar (doubled '' and \" escapes only). */
function readQuoted(value: string): string {
  const quote = value[0]
  let out = ''
  for (let i = 1; i < value.length; i++) {
    const char = value[i]
    if (quote === "'" && char === "'" && value[i + 1] === "'") {
      out += "'"
      i++
      continue
    }
    if (quote === '"' && char === '\\' && i + 1 < value.length) {
      out += value[i + 1]
      i++
      continue
    }
    if (char === quote) return out
    out += char
  }
  return out
}

/** Drop a trailing ` # comment` (a `#` only starts a comment after whitespace). */
function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, '').trim()
}
