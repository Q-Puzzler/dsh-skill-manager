import { describe, expect, it } from 'vitest'

import { extractFrontmatterDescription } from '../src/frontmatter'

describe('extractFrontmatterDescription', () => {
  it('reads a plain scalar description', () => {
    const md = ['---', 'name: find-skills', 'description: Helps users discover skills.', '---', '', '# Body'].join('\n')
    expect(extractFrontmatterDescription(md)).toBe('Helps users discover skills.')
  })

  it('keeps colons and quotes inside a plain scalar', () => {
    const md = ['---', 'description: does X: "quoted" things, fast', '---'].join('\n')
    expect(extractFrontmatterDescription(md)).toBe('does X: "quoted" things, fast')
  })

  it('reads double-quoted and single-quoted scalars', () => {
    expect(extractFrontmatterDescription(['---', 'description: "hello: world"', '---'].join('\n'))).toBe('hello: world')
    expect(extractFrontmatterDescription(['---', "description: 'it''s fine'", '---'].join('\n'))).toBe("it's fine")
  })

  it('joins folded block scalars with spaces', () => {
    const md = ['---', 'description: >', '  first line', '  second line', '---'].join('\n')
    expect(extractFrontmatterDescription(md)).toBe('first line second line')
  })

  it('keeps newlines in literal block scalars', () => {
    const md = ['---', 'description: |', '  first line', '  second line', '---'].join('\n')
    expect(extractFrontmatterDescription(md)).toBe('first line\nsecond line')
  })

  it('strips trailing comments from plain scalars', () => {
    const md = ['---', 'description: does things # not part of it', '---'].join('\n')
    expect(extractFrontmatterDescription(md)).toBe('does things')
  })

  it('returns undefined without frontmatter', () => {
    expect(extractFrontmatterDescription('# Just a heading')).toBeUndefined()
    expect(extractFrontmatterDescription('')).toBeUndefined()
  })

  it('returns undefined when frontmatter has no description', () => {
    expect(extractFrontmatterDescription(['---', 'name: x', '---'].join('\n'))).toBeUndefined()
  })

  it('returns undefined for an empty description', () => {
    expect(extractFrontmatterDescription(['---', 'description:', '---'].join('\n'))).toBeUndefined()
  })

  it('returns undefined when the closing fence is missing', () => {
    expect(extractFrontmatterDescription(['---', 'description: x'].join('\n'))).toBeUndefined()
  })
})
