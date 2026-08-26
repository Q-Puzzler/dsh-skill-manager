import { describe, expect, it } from 'vitest'

import { apply, Config, inject, name } from '../src/index'

describe('plugin exports', () => {
  it('exposes the cordis four-export shape', () => {
    expect(name).toBe('skill-manager')
    expect(typeof apply).toBe('function')
    expect(Array.isArray(inject)).toBe(true)
  })

  it('Config is a schemastery schema that parses defaults', () => {
    expect(Config({})).toEqual({ catalogUrl: 'https://www.skills.sh' })
  })
})
