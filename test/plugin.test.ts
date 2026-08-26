import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { apply, Config, inject, name } from '../src/index'

describe('plugin exports', () => {
  it('exposes the cordis four-export shape', () => {
    expect(name).toBe('skill-manager')
    expect(typeof apply).toBe('function')
    expect(inject).toEqual(['webServer'])
  })

  it('Config is a schemastery schema that parses defaults', () => {
    const config = Config({})
    expect(config).toEqual({
      catalogUrl: 'https://www.skills.sh',
      githubRawBase: 'https://raw.githubusercontent.com',
      githubApiBase: 'https://api.github.com',
      githubCodeloadBase: 'https://codeload.github.com',
      skillsDir: config.skillsDir, // env-dependent; asserted separately below
      fetchConcurrency: 5,
      descriptionCacheMaxEntries: 200,
      descriptionFetchTimeoutMs: 10_000,
      installFetchTimeoutMs: 30_000,
    })
  })

  it('resolves the default Skills Directory like dsh ($DSH_HOME/skills, else ~/.dsh/skills)', () => {
    const dshHome = process.env.DSH_HOME
    const expected = dshHome !== undefined && dshHome !== '' ? join(dshHome, 'skills') : join(homedir(), '.dsh', 'skills')
    expect(Config({}).skillsDir).toBe(expected)
  })

  it('honors a Config override for the Skills Directory', () => {
    expect(Config({ skillsDir: '/tmp/custom-skills' }).skillsDir).toBe('/tmp/custom-skills')
  })
})
