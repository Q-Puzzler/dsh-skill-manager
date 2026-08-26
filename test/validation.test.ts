import { describe, expect, it } from 'vitest'

import { isValidSkillId, parseSource } from '../src/validation'

describe('isValidSkillId', () => {
  it('accepts the dsh skill-name grammar', () => {
    for (const id of ['pdf', 'pdf-tools', 'a1', '1a', 'x-y-z', 'find-skills']) {
      expect(isValidSkillId(id), id).toBe(true)
    }
  })

  it('rejects malformed ids', () => {
    for (const id of ['', 'PDF', 'pdf_tools', '-pdf', 'pdf-', 'pdf--x', 'a b', 'a/b', 'a.b']) {
      expect(isValidSkillId(id), id).toBe(false)
    }
  })
})

describe('parseSource', () => {
  it('parses GitHub-legal owner/repo pairs', () => {
    expect(parseSource('vercel-labs/skills')).toEqual({ owner: 'vercel-labs', repo: 'skills' })
    expect(parseSource('github/awesome-copilot')).toEqual({ owner: 'github', repo: 'awesome-copilot' })
    expect(parseSource('a-b/c.d_e')).toEqual({ owner: 'a-b', repo: 'c.d_e' })
    expect(parseSource('A1/b')).toEqual({ owner: 'A1', repo: 'b' })
  })

  it('rejects wrong segment counts and empty segments', () => {
    for (const source of ['', 'owner', 'owner/repo/extra', 'owner/', '/repo', '/']) {
      expect(parseSource(source), source).toBeUndefined()
    }
  })

  it('rejects GitHub-illegal owner segments', () => {
    for (const source of ['-owner/repo', 'owner-/repo', 'ow ner/repo', 'ow_ner/repo', 'a'.repeat(40) + '/repo']) {
      expect(parseSource(source), source).toBeUndefined()
    }
  })

  it('rejects dot segments and traversal', () => {
    for (const source of ['owner/..', 'owner/.', 'owner/re..po', '../repo', 'owner/../repo']) {
      expect(parseSource(source), source).toBeUndefined()
    }
  })

  it('rejects slashes and whitespace inside segments', () => {
    for (const source of ['own er/repo', 'owner/re po', 'owner\t/repo']) {
      expect(parseSource(source), source).toBeUndefined()
    }
  })
})
