import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply, Config, name, ROUTE_PREFIX } from '../src/index'

describe('plugin exports', () => {
  it('exposes the cordis plugin shape (no static inject — webServer is a soft dependency)', () => {
    expect(name).toBe('skill-manager')
    expect(typeof apply).toBe('function')
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

describe('webServer soft dependency', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function testConfig(): Promise<ReturnType<typeof Config>> {
    const skillsDir = await mkdtemp(join(tmpdir(), 'skm-plugin-test-'))
    tempDirs.push(skillsDir)
    return Config({ skillsDir })
  }

  function captureWarnings(ctx: Context): unknown[] {
    const warnings: unknown[] = []
    ctx.logger.exporter({
      // cordis drops messages above the threshold (default INFO=1); WARN is 2.
      levels: { default: 3 },
      export(message) {
        if (message.type === 'warn') warnings.push(message.args[0])
      },
    })
    return warnings
  }

  it('registers the route prefix when webServer is provided', async () => {
    const ctx = new Context()
    const register = vi.fn().mockReturnValue(() => {})
    ctx.provide('webServer', { register } as unknown as Context['webServer'])
    const warnings = captureWarnings(ctx)
    const fiber = await ctx.plugin({ name, apply }, await testConfig())
    // The nested ctx.inject fiber loads asynchronously after apply returns.
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1))
    expect(register.mock.calls[0]?.[0]).toMatchObject({ kind: 'prefix', path: ROUTE_PREFIX })
    expect(warnings).toEqual([])
    await fiber.dispose()
  })

  it('activates without webServer: no routes, no throw, one warning', async () => {
    const ctx = new Context()
    const warnings = captureWarnings(ctx)
    const fiber = await ctx.plugin({ name, apply }, await testConfig())
    // The entry fiber itself is ACTIVE (2) — it never pends on webServer, so a
    // WebUI-less profile boots fine; the plugin simply stays inactive.
    expect(fiber.state).toBe(2)
    expect(ctx.get('webServer')).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0])).toContain('webServer')
    await fiber.dispose()
  })
})
