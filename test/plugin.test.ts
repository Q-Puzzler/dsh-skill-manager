import { describe, expect, it } from 'vitest'

import { apply, Config, inject, name } from '../src/index'

describe('plugin exports', () => {
  it('exposes the cordis four-export shape', () => {
    expect(name).toBe('skill-manager')
    expect(typeof apply).toBe('function')
    expect(inject).toEqual(['webServer'])
  })

  it('Config is a schemastery schema that parses defaults', () => {
    expect(Config({})).toEqual({
      catalogUrl: 'https://www.skills.sh',
      githubRawBase: 'https://raw.githubusercontent.com',
      fetchConcurrency: 5,
      descriptionCacheMaxEntries: 200,
      descriptionFetchTimeoutMs: 10_000,
    })
  })
})
