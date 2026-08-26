import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import type { Headers, Pack } from 'tar-stream'
import { afterEach, describe, expect, it } from 'vitest'

import { InstallError } from '../src/install'
import type { RegistryRecord } from '../src/registry'
import { SkillManager } from '../src/service'
import type { BinaryFetcher, Fetcher } from '../src/service'

/* ---------------------------------------------------------------- fixtures */

/** Codeload top-level prefix every entry name shares (`<repo>-<sha>/`). */
const PREFIX = 'skills-e818fe5'
const HEAD_SHA = 'a'.repeat(40)
const PATH_SHA = 'b'.repeat(40)

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

/* -------------------------------------------------------------- fetch mock */

interface TextRoute {
  match: string
  status?: number
  body?: string
}

function makeTextFetcher(routes: TextRoute[] = []) {
  const calls: string[] = []
  const fetcher: Fetcher = async (url) => {
    calls.push(url)
    for (const route of routes) {
      if (url.includes(route.match)) {
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

/* ------------------------------------------------------------ harness bits */

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeTempRoot(): Promise<{ tmp: string; skillsDir: string }> {
  const tmp = await mkdtemp(join(tmpdir(), 'skm-install-test-'))
  tempRoots.push(tmp)
  return { tmp, skillsDir: join(tmp, 'skills') }
}

function makeService(skillsDir: string, textRoutes: TextRoute[], binaryRoutes: BinaryRoute[]) {
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

/* ------------------------------------------------------------------ tests */

describe('SkillManager.install', () => {
  it('installs a skill end to end: files land, registry written, hash stable', async () => {
    const { tmp, skillsDir } = await makeTempRoot()
    const tarGz = await buildTarGz(standardEntries())
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: tarGz }])

    const result = await service.install(INSTALL)
    expect(result).toMatchObject({
      status: 'installed',
      action: 'install',
      skillId: 'wayfinder',
      source: 'owner/repo',
      targetPath: join(skillsDir, 'wayfinder'),
      commitSha: PATH_SHA,
    })
    if (result.status !== 'installed') throw new Error('unreachable')
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(new Date(result.installedAt).toISOString()).toBe(result.installedAt)

    // Only the skill subdirectory was extracted — no repo README, no other skills.
    expect(await listFilesRecursive(join(skillsDir, 'wayfinder'))).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(await readFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8')).toBe(skillMd('wayfinder'))
    expect(await readFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')

    // Registry record carries every field; nothing else is in the temp root.
    const record = await readRegistryRecord(skillsDir, 'wayfinder')
    expect(record).toEqual({
      source: 'owner/repo',
      skillId: 'wayfinder',
      skillPath: 'skills/wayfinder',
      installedAt: result.installedAt,
      commitSha: PATH_SHA,
      contentHash: result.contentHash,
    })
    expect(await readdir(join(skillsDir, '.skill-manager'))).toEqual(['wayfinder.json'])
    expect(await readdir(tmp)).toEqual(['skills'])

    // The content hash is an honest, deterministic hash of the landed files.
    expect(result.contentHash).toBe(await hashInstalled(join(skillsDir, 'wayfinder')))
    expect(await service.listInstalled()).toEqual([record])
  })

  it.each([
    { label: 'skills/<id>/ layout', location: 'skills/wayfinder' },
    { label: '<id>/ layout', location: 'wayfinder' },
    { label: 'repo-root layout', location: '' },
  ])('finds the skill at the $label probe location', async ({ location }) => {
    const { skillsDir } = await makeTempRoot()
    const base = location === '' ? PREFIX : `${PREFIX}/${location}`
    const tarGz = await buildTarGz([
      { name: `${base}/SKILL.md`, content: skillMd('wayfinder') },
      { name: `${base}/notes.md`, content: 'notes' },
    ])
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: tarGz }])
    const result = await service.install(INSTALL)
    expect(result.status).toBe('installed')
    expect(await listFilesRecursive(join(skillsDir, 'wayfinder'))).toEqual(['SKILL.md', 'notes.md'])
    const record = await readRegistryRecord(skillsDir, 'wayfinder')
    expect(record.skillPath).toBe(location)
  })

  it('falls back to the HEAD sha when the path-commit lookup finds nothing', async () => {
    const { skillsDir } = await makeTempRoot()
    const tarGz = await buildTarGz(standardEntries())
    const { service } = makeService(skillsDir, githubRoutes({ pathSha: null }), [{ match: '/tar.gz/', body: tarGz }])
    const result = await service.install(INSTALL)
    expect(result).toMatchObject({ status: 'installed', commitSha: HEAD_SHA })
  })

  it('requires confirmation for a Managed reinstall, then reinstalls', async () => {
    const { skillsDir } = await makeTempRoot()
    const v1 = await buildTarGz(standardEntries())
    const { service, textCalls, binaryCalls } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: v1 }])
    await service.install(INSTALL)

    // Second source state: new commits, changed script content.
    const v2 = await buildTarGz(standardEntries({ scriptContent: '#!/bin/sh\necho v2\n' }))
    const nextSha = 'c'.repeat(40)
    const nextPathSha = 'd'.repeat(40)
    const { service: service2, textCalls: textCalls2, binaryCalls: binaryCalls2 } = makeService(
      skillsDir,
      githubRoutes({ headSha: nextSha, pathSha: nextPathSha }),
      [{ match: '/tar.gz/', body: v2 }],
    )

    const textCallsBefore = textCalls2.length + textCalls.length
    const binaryCallsBefore = binaryCalls2.length + binaryCalls.length
    const required = await service2.install(INSTALL)
    expect(required).toEqual({
      status: 'confirmation-required',
      action: 'reinstall',
      skillId: 'wayfinder',
      source: 'owner/repo',
      targetPath: join(skillsDir, 'wayfinder'),
    })
    // Zero writes AND zero network before confirmation: v1 content and the
    // original registry record are untouched.
    expect(textCalls2.length + textCalls.length).toBe(textCallsBefore)
    expect(binaryCalls2.length + binaryCalls.length).toBe(binaryCallsBefore)
    expect(await readFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n')
    expect((await readRegistryRecord(skillsDir, 'wayfinder')).commitSha).toBe(PATH_SHA)

    const confirmed = await service2.install({ ...INSTALL, confirm: true })
    expect(confirmed).toMatchObject({ status: 'installed', action: 'reinstall', commitSha: nextPathSha })
    expect(await readFile(join(skillsDir, 'wayfinder', 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho v2\n')
    const record = await readRegistryRecord(skillsDir, 'wayfinder')
    expect(record.commitSha).toBe(nextPathSha)
    expect(record.contentHash).toBe(await hashInstalled(join(skillsDir, 'wayfinder')))
    // The swap left no staging/backup residue.
    expect(await readdir(join(skillsDir, '.skill-manager'))).toEqual(['wayfinder.json'])
  })

  it('requires confirmation to overwrite an Unmanaged directory (zero writes until confirmed)', async () => {
    const { skillsDir } = await makeTempRoot()
    await mkdir(join(skillsDir, 'wayfinder'), { recursive: true })
    await writeFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'user-managed content', 'utf8')

    const tarGz = await buildTarGz(standardEntries())
    const { service, textCalls, binaryCalls } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: tarGz }])

    const required = await service.install(INSTALL)
    expect(required).toEqual({
      status: 'confirmation-required',
      action: 'overwrite',
      skillId: 'wayfinder',
      source: 'owner/repo',
      targetPath: join(skillsDir, 'wayfinder'),
    })
    // Zero writes and zero network: the Unmanaged directory is byte-identical
    // and no registry was created.
    expect(textCalls).toEqual([])
    expect(binaryCalls).toEqual([])
    expect(await readFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8')).toBe('user-managed content')
    expect(await listFilesRecursive(join(skillsDir, '.skill-manager'))).toEqual([])

    const confirmed = await service.install({ ...INSTALL, confirm: true })
    expect(confirmed).toMatchObject({ status: 'installed', action: 'overwrite' })
    expect(await readFile(join(skillsDir, 'wayfinder', 'SKILL.md'), 'utf8')).toBe(skillMd('wayfinder'))
    expect((await readRegistryRecord(skillsDir, 'wayfinder')).skillId).toBe('wayfinder')
  })

  it('fails with a clear error when the Source is missing the skill (zero writes)', async () => {
    const { tmp, skillsDir } = await makeTempRoot()
    const tarGz = await buildTarGz([{ name: `${PREFIX}/skills/other-skill/SKILL.md`, content: skillMd('other-skill') }])
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: tarGz }])
    await expect(service.install(INSTALL)).rejects.toBeInstanceOf(InstallError)
    await expect(service.install(INSTALL)).rejects.toMatchObject({ code: 'skill-not-found' })
    await expect(service.install(INSTALL)).rejects.toThrow(/Source 缺失该技能/)
    expect(await readdir(tmp)).toEqual([])
  })

  it.each([
    { label: 'uppercase skill id', skillId: 'BAD_ID' },
    { label: 'skill id with slash', skillId: 'a/b' },
    { label: 'empty skill id', skillId: '' },
    { label: 'traversal source', source: 'owner/../repo' },
    { label: 'single-segment source', source: 'bad' },
    { label: 'empty source', source: '' },
  ])('rejects invalid input ($label) before any network or write', async (input) => {
    const { tmp, skillsDir } = await makeTempRoot()
    const { service, textCalls, binaryCalls } = makeService(skillsDir, githubRoutes(), [])
    const request = { source: input.source ?? INSTALL.source, skillId: input.skillId ?? INSTALL.skillId }
    await expect(service.install(request)).rejects.toMatchObject({ name: 'InstallError', code: 'invalid-input' })
    expect(textCalls).toEqual([])
    expect(binaryCalls).toEqual([])
    expect(await readdir(tmp)).toEqual([])
  })

  it.each([
    { label: 'inside the skill dir', name: `${PREFIX}/skills/wayfinder/../../evil.txt` },
    { label: 'at the repo root', name: `${PREFIX}/../evil.txt` },
  ])('rejects tar traversal entries ($label) and writes nothing', async ({ name }) => {
    const { tmp, skillsDir } = await makeTempRoot()
    const tarGz = await buildTarGz([...standardEntries(), { name, content: 'pwned' }])
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: tarGz }])
    await expect(service.install(INSTALL)).rejects.toMatchObject({ name: 'InstallError', code: 'unsafe-archive' })
    expect(await readdir(tmp)).toEqual([])
  })

  it('rejects absolute-path entries and writes nothing', async () => {
    const { tmp, skillsDir } = await makeTempRoot()
    const tarGz = await buildTarGz([...standardEntries(), { name: '/abs/evil.txt', content: 'pwned' }])
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: tarGz }])
    await expect(service.install(INSTALL)).rejects.toMatchObject({ name: 'InstallError', code: 'unsafe-archive' })
    expect(await readdir(tmp)).toEqual([])
  })

  it('skips symlink and hardlink entries instead of materializing them', async () => {
    const { tmp, skillsDir } = await makeTempRoot()
    const tarGz = await buildTarGz([
      ...standardEntries(),
      { name: `${PREFIX}/skills/wayfinder/link.sh`, type: 'symlink', linkname: 'scripts/run.sh' },
      { name: `${PREFIX}/skills/wayfinder/hard.sh`, type: 'link', linkname: `${PREFIX}/skills/wayfinder/scripts/run.sh` },
    ])
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: tarGz }])
    const result = await service.install(INSTALL)
    expect(result.status).toBe('installed')
    expect(await listFilesRecursive(join(skillsDir, 'wayfinder'))).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(await readdir(tmp)).toEqual(['skills'])
  })

  it('fails cleanly on a mid-download network failure (no partial files)', async () => {
    const { tmp, skillsDir } = await makeTempRoot()
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', throws: true }])
    await expect(service.install(INSTALL)).rejects.toMatchObject({ name: 'InstallError', code: 'upstream' })
    expect(await readdir(tmp)).toEqual([])
  })

  it('fails cleanly on download and API HTTP errors (no partial files)', async () => {
    const { tmp, skillsDir } = await makeTempRoot()
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', status: 500, body: Buffer.from('oops') }])
    await expect(service.install(INSTALL)).rejects.toMatchObject({ code: 'upstream' })
    expect(await readdir(tmp)).toEqual([])

    const { tmp: tmp2, skillsDir: skillsDir2 } = await makeTempRoot()
    const { service: service2 } = makeService(
      skillsDir2,
      [{ match: '/repos/owner/repo', status: 404, body: '{"message":"Not Found"}' }],
      [],
    )
    await expect(service2.install(INSTALL)).rejects.toMatchObject({ code: 'upstream' })
    expect(await readdir(tmp2)).toEqual([])
  })

  it('fails cleanly on a corrupted (non-gzip) download', async () => {
    const { tmp, skillsDir } = await makeTempRoot()
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: Buffer.from('not gzip data') }])
    await expect(service.install(INSTALL)).rejects.toMatchObject({ code: 'upstream' })
    expect(await readdir(tmp)).toEqual([])
  })
})

describe('SkillManager.listInstalled', () => {
  it('returns an empty list when nothing is installed', async () => {
    const { skillsDir } = await makeTempRoot()
    const { service } = makeService(skillsDir, [], [])
    expect(await service.listInstalled()).toEqual([])
  })

  it('skips malformed registry files instead of failing', async () => {
    const { skillsDir } = await makeTempRoot()
    const tarGz = await buildTarGz(standardEntries())
    const { service } = makeService(skillsDir, githubRoutes(), [{ match: '/tar.gz/', body: tarGz }])
    await service.install(INSTALL)
    const registryDir = join(skillsDir, '.skill-manager')
    await writeFile(join(registryDir, 'broken.json'), '{not json', 'utf8')
    await writeFile(join(registryDir, 'shapeless.json'), '{"foo":1}', 'utf8')
    await writeFile(join(registryDir, 'notes.txt'), 'ignored', 'utf8')
    const records = await service.listInstalled()
    expect(records).toHaveLength(1)
    expect(records[0].skillId).toBe('wayfinder')
  })
})
