import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import type { Headers, Pack } from 'tar-stream'
import { afterEach, describe, expect, it } from 'vitest'

import { pathExists } from '../src/install'
import type { RegistryRecord } from '../src/registry'
import { SkillManager } from '../src/service'
import type { BinaryFetcher, Fetcher, SkillManagerOptions } from '../src/service'

/* ---------------------------------------------------------------- fixtures */

/** Codeload top-level prefix every entry name shares (`<repo>-<sha>/`). */
const PREFIX = 'skills-e818fe5'
const HEAD_SHA = 'a'.repeat(40)
const PATH_SHA = 'b'.repeat(40)

/** 40-char hex-looking SHA from one character (test commit ids). */
function sha(char: string): string {
  return char.repeat(40)
}

interface FixtureEntry {
  name: string
  type?: 'file' | 'directory' | 'symlink' | 'link'
  content?: string
  linkname?: string
}

function writeEntry(archive: Pack, headers: Headers, content?: Buffer): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const callback = (error?: Error | null) => (error ? rejectPromise(error) : resolvePromise())
    if (content !== undefined) archive.entry(headers, content, callback)
    else archive.entry(headers, callback).end()
  })
}

/** Build a minimal valid tar.gz in-test (the same shape codeload serves). */
async function buildTarGz(entries: FixtureEntry[]): Promise<Buffer> {
  const archive = pack()
  const chunks: Buffer[] = []
  archive.on('data', (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<void>((resolvePromise, rejectPromise) => {
    archive.on('end', resolvePromise)
    archive.on('error', rejectPromise)
  })
  for (const entry of entries) {
    if (entry.type === 'symlink' || entry.type === 'link') {
      await writeEntry(archive, { name: entry.name, type: entry.type, linkname: entry.linkname ?? '' })
    } else if (entry.type === 'directory') {
      await writeEntry(archive, { name: entry.name.endsWith('/') ? entry.name : `${entry.name}/`, type: 'directory' })
    } else {
      await writeEntry(archive, { name: entry.name, type: 'file' }, Buffer.from(entry.content ?? '', 'utf8'))
    }
  }
  archive.finalize()
  await finished
  return gzipSync(Buffer.concat(chunks))
}

function skillMd(name: string): string {
  return ['---', `name: ${name}`, `description: ${name} description`, '---', '', `# ${name}`].join('\n')
}

/** A multi-skill repo tarball; `wayfinder` lives at `skills/wayfinder/`. */
function standardEntries(overrides: { skillContent?: string; scriptContent?: string } = {}): FixtureEntry[] {
  return [
    { name: `${PREFIX}/`, type: 'directory' },
    { name: `${PREFIX}/README.md`, content: 'repo readme — not part of any skill' },
    { name: `${PREFIX}/skills/wayfinder/SKILL.md`, content: overrides.skillContent ?? skillMd('wayfinder') },
    { name: `${PREFIX}/skills/wayfinder/scripts/run.sh`, content: overrides.scriptContent ?? '#!/bin/sh\necho hi\n' },
    { name: `${PREFIX}/skills/other-skill/SKILL.md`, content: skillMd('other-skill') },
  ]
}

/** A one-skill repo tarball with the skill at `skills/<skillId>/`. */
function singleSkillEntries(prefix: string, skillId: string, scriptContent: string): FixtureEntry[] {
  return [
    { name: `${prefix}/`, type: 'directory' },
    { name: `${prefix}/skills/${skillId}/SKILL.md`, content: skillMd(skillId) },
    { name: `${prefix}/skills/${skillId}/scripts/run.sh`, content: scriptContent },
  ]
}

/* -------------------------------------------------------------- fetch mock */

interface TextRoute {
  match: string
  status?: number
  body?: string
  throws?: boolean
}

function makeTextFetcher(routes: TextRoute[] = []) {
  const calls: string[] = []
  const fetcher: Fetcher = async (url) => {
    calls.push(url)
    for (const route of routes) {
      if (url.includes(route.match)) {
        if (route.throws === true) throw new Error('connection reset')
        const status = route.status ?? 200
        return { ok: status >= 200 && status < 300, status, text: async () => route.body ?? '' }
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' }
  }
  return { calls, fetcher }
}

interface BinaryRoute {
  match: string
  status?: number
  body?: Buffer
  throws?: boolean
}

function makeBinaryFetcher(routes: BinaryRoute[] = []) {
  const calls: string[] = []
  const fetcher: BinaryFetcher = async (url) => {
    calls.push(url)
    for (const route of routes) {
      if (url.includes(route.match)) {
        if (route.throws === true) throw new Error('connection reset')
        const status = route.status ?? 200
        const body = route.body ?? Buffer.alloc(0)
        return {
          ok: status >= 200 && status < 300,
          status,
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        }
      }
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  return { calls, fetcher }
}

/** GitHub API routes for owner/repo: repo info, HEAD commit, path commit. */
function githubRoutes(options: { headSha?: string; pathSha?: string | null } = {}): TextRoute[] {
  const headSha = options.headSha ?? HEAD_SHA
  const pathSha = options.pathSha === undefined ? PATH_SHA : options.pathSha
  return [
    ...(pathSha !== null ? [{ match: 'path=', body: JSON.stringify([{ sha: pathSha }]) }] : []),
    { match: '/commits?', body: JSON.stringify([{ sha: headSha }]) },
    { match: '/repos/owner/repo', body: JSON.stringify({ default_branch: 'main' }) },
  ]
}

/**
 * Per-repo GitHub API routes (multi-skill checkUpdates scenarios). The
 * path-commit route goes first: its URL also matches the generic commits
 * route, and first match wins. `pathSha: null` answers an empty commit list
 * (the path never existed on the default branch).
 */
function repoRoutes(repo: string, options: { headSha: string; pathSha: string | null }): TextRoute[] {
  const routes: TextRoute[] = []
  if (options.pathSha !== null) {
    routes.push({ match: `${repo}/commits?sha=main&path=`, body: JSON.stringify([{ sha: options.pathSha }]) })
  } else {
    routes.push({ match: `${repo}/commits?sha=main&path=`, body: '[]' })
  }
  routes.push({ match: `${repo}/commits?`, body: JSON.stringify([{ sha: options.headSha }]) })
  routes.push({ match: `/repos/${repo}`, body: JSON.stringify({ default_branch: 'main' }) })
  return routes
}

/* ------------------------------------------------------------ harness bits */

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeTempRoot(): Promise<{ tmp: string; skillsDir: string }> {
  const tmp = await mkdtemp(join(tmpdir(), 'skm-manage-test-'))
  tempRoots.push(tmp)
  return { tmp, skillsDir: join(tmp, 'skills') }
}

function makeService(
  skillsDir: string,
  textRoutes: TextRoute[],
  binaryRoutes: BinaryRoute[],
  extras: Partial<SkillManagerOptions> = {},
) {
  const text = makeTextFetcher(textRoutes)
  const binary = makeBinaryFetcher(binaryRoutes)
  const service = new SkillManager({
    catalogUrl: 'https://www.skills.sh',
    githubRawBase: 'https://raw.githubusercontent.com',
    githubApiBase: 'https://api.github.com',
    githubCodeloadBase: 'https://codeload.github.com',
    skillsDir,
    fetchConcurrency: 5,
    descriptionCacheMaxEntries: 200,
    descriptionFetchTimeoutMs: 10_000,
    installFetchTimeoutMs: 30_000,
    fetcher: text.fetcher,
    binaryFetcher: binary.fetcher,
    ...extras,
  })
  return { service, textCalls: text.calls, binaryCalls: binary.calls }
}

/** Sorted relative paths of every entry under root (missing root → []). */
async function listFilesRecursive(root: string, relative = ''): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const rel = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(join(root, entry.name), rel)))
    else out.push(rel)
  }
  return out.sort()
}

/** Independent re-hash of an installed directory (determinism oracle). */
async function hashInstalled(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (const rel of await listFilesRecursive(root)) {
    hash.update(rel)
    hash.update('\0')
    hash.update(await readFile(join(root, ...rel.split('/'))))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function readRegistryRecord(skillsDir: string, skillId: string): Promise<RegistryRecord> {
  return JSON.parse(await readFile(join(skillsDir, '.skill-manager', `${skillId}.json`), 'utf8')) as RegistryRecord
}

const INSTALL = { source: 'owner/repo', skillId: 'wayfinder' } as const

/** Install one single-skill repo skill (skills/<id>/ layout); fails the test on any non-installed outcome. */
async function installOne(
  skillsDir: string,
  repo: string,
  skillId: string,
  shas: { head: string; path: string },
  script: string,
): Promise<void> {
  const tarGz = await buildTarGz(singleSkillEntries(`${repo.split('/')[1]}-e818fe5`, skillId, script))
  const { service } = makeService(skillsDir, repoRoutes(repo, { headSha: shas.head, pathSha: shas.path }), [
    { match: `/${repo}/tar.gz/`, body: tarGz },
  ])
  const result = await service.install({ source: repo, skillId })
  if (result.status !== 'installed') throw new Error(`setup install of ${skillId} failed: ${JSON.stringify(result)}`)
}

/* ------------------------------------------------------------------ tests */

describe('SkillManager.checkUpdates', () => {
  it('returns an empty list when nothing is installed (zero network)', async () => {
    const { skillsDir } = await makeTempRoot()
    const { service, textCalls } = makeService(skillsDir, [], [])
    expect(await service.checkUpdates()).toEqual([])
    expect(textCalls).toEqual([])
  })

  it('flags up-to-date, stale, invalid, and transient-error skills correctly', async () => {
    const { skillsDir } = await makeTempRoot()
    await installOne(skillsDir, 'owner/repo-a', 'skill-a', { head: sha('1'), path: sha('a') }, 'echo a')
    await installOne(skillsDir, 'owner/repo-b', 'skill-b', { head: sha('2'), path: sha('b') }, 'echo b')
    await installOne(skillsDir, 'owner/repo-c', 'skill-c', { head: sha('3'), path: sha('c') }, 'echo c')
    await installOne(skillsDir, 'owner/repo-d', 'skill-d', { head: sha('4'), path: sha('d') }, 'echo d')

    const { service } = makeService(
      skillsDir,
      [
        // skill-a: the path commit is unchanged → up to date.
        ...repoRoutes('owner/repo-a', { headSha: sha('1'), pathSha: sha('a') }),
        // skill-b: the skill path saw a newer commit → update available.
        ...repoRoutes('owner/repo-b', { headSha: sha('2'), pathSha: sha('e') }),
        // skill-c: the repo is gone (404) → source invalid.
        { match: '/repos/owner/repo-c', status: 404, body: '{"message":"Not Found"}' },
        // skill-d: the network itself fails → retryable error, NOT invalid.
        { match: '/repos/owner/repo-d', throws: true },
      ],
      [],
    )
    const states = await service.checkUpdates()
    const byId = new Map(states.map((state) => [state.skillId, state]))
    expect([...byId.keys()].sort()).toEqual(['skill-a', 'skill-b', 'skill-c', 'skill-d'])

    expect(byId.get('skill-a')).toEqual({
      skillId: 'skill-a',
      source: 'owner/repo-a',
      updateAvailable: false,
      sourceInvalid: false,
      latestCommitSha: sha('a'),
    })
    expect(byId.get('skill-b')).toEqual({
      skillId: 'skill-b',
      source: 'owner/repo-b',
      updateAvailable: true,
      sourceInvalid: false,
      latestCommitSha: sha('e'),
    })
    expect(byId.get('skill-c')).toEqual({
      skillId: 'skill-c',
      source: 'owner/repo-c',
      updateAvailable: false,
      sourceInvalid: true,
    })
    const stale = byId.get('skill-d')
    expect(stale).toMatchObject({ skillId: 'skill-d', updateAvailable: false, sourceInvalid: false })
    expect(stale?.error).toEqual(expect.any(String))
    expect(stale?.latestCommitSha).toBeUndefined()

    // sourceInvalid persists onto the record; healthy/failed checks leave the
    // other records' flags untouched.
    expect((await readRegistryRecord(skillsDir, 'skill-c')).sourceInvalid).toBe(true)
    expect(await readRegistryRecord(skillsDir, 'skill-a')).not.toHaveProperty('sourceInvalid')
    expect(await readRegistryRecord(skillsDir, 'skill-b')).not.toHaveProperty('sourceInvalid')
    expect(await readRegistryRecord(skillsDir, 'skill-d')).not.toHaveProperty('sourceInvalid')

    // The persisted flag makes update() refuse without a network call, while
    // uninstall stays available for the invalid skill.
    await expect(service.update({ skillId: 'skill-c', confirm: true })).rejects.toMatchObject({
      name: 'InstallError',
      code: 'source-invalid',
    })
    const uninstalled = await service.uninstall({ skillId: 'skill-c', confirm: true })
    expect(uninstalled).toMatchObject({ status: 'uninstalled', skillId: 'skill-c' })
    expect(await pathExists(join(skillsDir, 'skill-c'))).toBe(false)
    expect((await service.listInstalled()).map((record) => record.skillId)).toEqual(['skill-a', 'skill-b', 'skill-d'])
  })

  it('marks a skill invalid when its path has no commits on the default branch', async () => {
    const { skillsDir } = await makeTempRoot()
    await installOne(skillsDir, 'owner/repo-c', 'skill-c', { head: sha('3'), path: sha('c') }, 'echo c')
    const { service } = makeService(skillsDir, repoRoutes('owner/repo-c', { headSha: sha('3'), pathSha: null }), [])
    const states = await service.checkUpdates()
    expect(states).toEqual([
      { skillId: 'skill-c', source: 'owner/repo-c', updateAvailable: false, sourceInvalid: true },
    ])
    expect((await readRegistryRecord(skillsDir, 'skill-c')).sourceInvalid).toBe(true)
  })

  it('clears a stale sourceInvalid flag on a healthy re-check (staleness self-heals)', async () => {
    const { skillsDir } = await makeTempRoot()
    await installOne(skillsDir, 'owner/repo-c', 'skill-c', { head: sha('3'), path: sha('c') }, 'echo c')
    const gone = makeService(skillsDir, [{ match: '/repos/owner/repo-c', status: 404, body: '{"message":"Not Found"}' }], [])
    expect((await gone.service.checkUpdates())[0]).toMatchObject({ sourceInvalid: true })
    expect((await readRegistryRecord(skillsDir, 'skill-c')).sourceInvalid).toBe(true)

    const back = makeService(skillsDir, repoRoutes('owner/repo-c', { headSha: sha('3'), pathSha: sha('c') }), [])
    expect(await back.service.checkUpdates()).toEqual([
      {
        skillId: 'skill-c',
        source: 'owner/repo-c',
        updateAvailable: false,
        sourceInvalid: false,
        latestCommitSha: sha('c'),
      },
    ])
    expect(await readRegistryRecord(skillsDir, 'skill-c')).not.toHaveProperty('sourceInvalid')
  })
})

describe('SkillManager.update', () => {
  it('requires confirmation without a warning when the local copy is pristine (zero network, zero writes)', async () => {
    const { skillsDir } = await makeTempRoot()
    const v1 = await buildTarGz(standardEntries())
    const { service: service1 } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: v1 }])
    await service1.install(INSTALL)

    const v2 = await buildTarGz(standardEntries({ scriptContent: '#!/bin/sh\necho v2\n' }))
    const { service: service2, textCalls, binaryCalls } = makeService(
      skillsDir,
      githubRoutes({ headSha: 'c'.repeat(40), pathSha: 'd'.repeat(40) }),
      [{ match: '/tar.gz/', body: v2 }],
    )
    const required = await service2.update({ skillId: 'wayfinder' })
    // No localModified key at all: the pristine copy carries no warning.
    expect(required).toEqual({
      status: 'confirmation-required',
      action: 'update',
      skillId: 'wayfinder',
      source: 'owner/repo',
      targetPath: join(skillsDir, 'wayfinder'),
    })
    // The gate precedes every network call and write: v1 content and the
    // original record are untouched.
    expect(textCalls).toEqual([])
    expect(binaryCalls).toEqual([])
    expect(await readFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
    expect((await readRegistryRecord(skillsDir, 'wayfinder')).commitSha).toBe(PATH_SHA)
  })

  it('applies a confirmed update: content swapped, registry bumped, installedAt preserved', async () => {
    const { skillsDir } = await makeTempRoot()
    const v1 = await buildTarGz(standardEntries())
    const { service: service1 } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: v1 }])
    const installed = await service1.install(INSTALL)
    if (installed.status !== 'installed') throw new Error('unreachable')

    const v2 = await buildTarGz(standardEntries({ scriptContent: '#!/bin/sh\necho v2\n' }))
    const nextHead = 'c'.repeat(40)
    const nextPath = 'd'.repeat(40)
    const { service: service2 } = makeService(skillsDir, githubRoutes({ headSha: nextHead, pathSha: nextPath }), [
      { match: '/tar.gz/', body: v2 },
    ])
    const updated = await service2.update({ skillId: 'wayfinder', confirm: true })
    expect(updated).toMatchObject({
      status: 'updated',
      action: 'update',
      skillId: 'wayfinder',
      source: 'owner/repo',
      targetPath: join(skillsDir, 'wayfinder'),
      installedAt: installed.installedAt,
      commitSha: nextPath,
    })
    if (updated.status !== 'updated') throw new Error('unreachable')
    expect(new Date(updated.updatedAt).toISOString()).toBe(updated.updatedAt)

    // New content is in, the old script is gone, and nothing else changed.
    expect(await listFilesRecursive(join(skillsDir, 'wayfinder'))).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(await readFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8')).toBe(skillMd('wayfinder'))
    expect(await readFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho v2\n')
    expect(updated.contentHash).toBe(await hashInstalled(join(skillsDir, 'wayfinder')))

    // The record advanced: new commitSha/contentHash/updatedAt, original
    // installedAt kept, no residue in the registry directory.
    expect(await readRegistryRecord(skillsDir, 'wayfinder')).toEqual({
      source: 'owner/repo',
      skillId: 'wayfinder',
      skillPath: 'skills/wayfinder',
      installedAt: installed.installedAt,
      updatedAt: updated.updatedAt,
      commitSha: nextPath,
      contentHash: updated.contentHash,
    })
    expect(await readdir(join(skillsDir, '.skill-manager'))).toEqual(['wayfinder.json'])
  })

  it('carries localModified: true when the on-disk content was edited, then overwrites on confirm', async () => {
    const { skillsDir } = await makeTempRoot()
    const v1 = await buildTarGz(standardEntries())
    const { service: service1 } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: v1 }])
    await service1.install(INSTALL)
    // The user edits the installed copy after install.
    await writeFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), '#!/bin/sh\necho local edit\n', 'utf8')

    const v2 = await buildTarGz(standardEntries({ scriptContent: '#!/bin/sh\necho v2\n' }))
    const nextPath = 'd'.repeat(40)
    const { service: service2 } = makeService(
      skillsDir,
      githubRoutes({ headSha: 'c'.repeat(40), pathSha: nextPath }),
      [{ match: '/tar.gz/', body: v2 }],
    )
    const required = await service2.update({ skillId: 'wayfinder' })
    expect(required).toEqual({
      status: 'confirmation-required',
      action: 'update',
      skillId: 'wayfinder',
      source: 'owner/repo',
      targetPath: join(skillsDir, 'wayfinder'),
      localModified: true,
    })
    // The confirmation phase itself changed nothing: the local edit stands.
    expect(await readFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho local edit\n')

    const updated = await service2.update({ skillId: 'wayfinder', confirm: true })
    expect(updated).toMatchObject({ status: 'updated', commitSha: nextPath })
    // The local modification was overwritten by the new upstream content.
    expect(await readFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho v2\n')
    const record = await readRegistryRecord(skillsDir, 'wayfinder')
    expect(record.commitSha).toBe(nextPath)
    expect(record.contentHash).toBe(await hashInstalled(join(skillsDir, 'wayfinder')))
  })

  it('preserves the old version byte-for-byte and the registry unchanged on a download failure', async () => {
    const { skillsDir } = await makeTempRoot()
    const v1 = await buildTarGz(standardEntries())
    const { service: service1 } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: v1 }])
    await service1.install(INSTALL)
    const v1Record = await readRegistryRecord(skillsDir, 'wayfinder')

    const { service: service2 } = makeService(
      skillsDir,
      githubRoutes({ headSha: 'c'.repeat(40), pathSha: 'd'.repeat(40) }),
      [{ match: '/tar.gz/', throws: true }],
    )
    await expect(service2.update({ skillId: 'wayfinder', confirm: true })).rejects.toMatchObject({
      name: 'InstallError',
      code: 'upstream',
    })
    expect(await listFilesRecursive(join(skillsDir, 'wayfinder'))).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(await readFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8')).toBe(skillMd('wayfinder'))
    expect(await readFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
    expect(await hashInstalled(join(skillsDir, 'wayfinder'))).toBe(v1Record.contentHash)
    expect(await readRegistryRecord(skillsDir, 'wayfinder')).toEqual(v1Record)
    expect(await readdir(join(skillsDir, '.skill-manager'))).toEqual(['wayfinder.json'])
  })

  it('refuses to update an Unmanaged target (not-managed, zero network, zero writes)', async () => {
    const { skillsDir } = await makeTempRoot()
    await mkdir(join(skillsDir, 'wayfinder'), { recursive: true })
    await writeFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'user-managed content', 'utf8')
    const { service, textCalls, binaryCalls } = makeService(skillsDir, githubRoutes(), [])
    await expect(service.update({ skillId: 'wayfinder' })).rejects.toMatchObject({ code: 'not-managed' })
    await expect(service.update({ skillId: 'wayfinder', confirm: true })).rejects.toMatchObject({ code: 'not-managed' })
    expect(textCalls).toEqual([])
    expect(binaryCalls).toEqual([])
    expect(await readFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8')).toBe('user-managed content')
  })

  it.each([{ skillId: '..' }, { skillId: 'a/..' }, { skillId: 'BAD_ID' }])(
    'refuses a tampered skill id ($skillId) before any network or write',
    async ({ skillId }) => {
      const { skillsDir } = await makeTempRoot()
      const v1 = await buildTarGz(standardEntries())
      const { service, textCalls, binaryCalls } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: v1 }])
      await expect(service.update({ skillId, confirm: true })).rejects.toMatchObject({ code: 'invalid-input' })
      await expect(service.uninstall({ skillId, confirm: true })).rejects.toMatchObject({ code: 'invalid-input' })
      expect(textCalls).toEqual([])
      expect(binaryCalls).toEqual([])
    },
  )
})

describe('SkillManager.uninstall', () => {
  it('requires confirmation (zero deletes), then removes the directory and the record', async () => {
    const { skillsDir } = await makeTempRoot()
    const v1 = await buildTarGz(standardEntries())
    const { service, textCalls, binaryCalls } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: v1 }])
    await service.install(INSTALL)
    const callsBefore = textCalls.length
    const binaryCallsBefore = binaryCalls.length

    const required = await service.uninstall({ skillId: 'wayfinder' })
    expect(required).toEqual({
      status: 'confirmation-required',
      action: 'uninstall',
      skillId: 'wayfinder',
      source: 'owner/repo',
      targetPath: join(skillsDir, 'wayfinder'),
    })
    // Zero deletes and zero network before confirmation.
    expect(textCalls.length).toBe(callsBefore)
    expect(binaryCalls.length).toBe(binaryCallsBefore)
    expect(await readFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8')).toBe(skillMd('wayfinder'))
    expect((await readRegistryRecord(skillsDir, 'wayfinder')).skillId).toBe('wayfinder')

    const uninstalled = await service.uninstall({ skillId: 'wayfinder', confirm: true })
    expect(uninstalled).toEqual({
      status: 'uninstalled',
      skillId: 'wayfinder',
      source: 'owner/repo',
      targetPath: join(skillsDir, 'wayfinder'),
      removedDirectory: true,
    })
    expect(await pathExists(join(skillsDir, 'wayfinder'))).toBe(false)
    expect(await readdir(join(skillsDir, '.skill-manager'))).toEqual([])
    expect(await service.listInstalled()).toEqual([])
    // Uninstall never touches the network.
    expect(textCalls.length).toBe(callsBefore)
  })

  it('removes only the record when the directory is already missing (benign)', async () => {
    const { skillsDir } = await makeTempRoot()
    const v1 = await buildTarGz(standardEntries())
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: v1 }])
    await service.install(INSTALL)
    await rm(join(skillsDir, 'wayfinder'), { recursive: true })

    const uninstalled = await service.uninstall({ skillId: 'wayfinder', confirm: true })
    expect(uninstalled).toMatchObject({ status: 'uninstalled', removedDirectory: false })
    expect(await readdir(join(skillsDir, '.skill-manager'))).toEqual([])
    expect(await service.listInstalled()).toEqual([])
  })

  it('refuses an Unmanaged target with a structured error and deletes nothing', async () => {
    const { skillsDir } = await makeTempRoot()
    await mkdir(join(skillsDir, 'wayfinder'), { recursive: true })
    await writeFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'user-managed content', 'utf8')
    const { service, textCalls, binaryCalls } = makeService(skillsDir, [], [])
    await expect(service.uninstall({ skillId: 'wayfinder' })).rejects.toMatchObject({
      name: 'InstallError',
      code: 'not-managed',
    })
    await expect(service.uninstall({ skillId: 'wayfinder', confirm: true })).rejects.toMatchObject({
      code: 'not-managed',
    })
    // Zero deletes, zero network: the Unmanaged directory is byte-identical.
    expect(textCalls).toEqual([])
    expect(binaryCalls).toEqual([])
    expect(await readFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8')).toBe('user-managed content')
    expect(await listFilesRecursive(join(skillsDir, '.skill-manager'))).toEqual([])
  })
})
