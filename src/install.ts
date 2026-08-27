/**
 * Install pipeline (ADR-0001): resolve the Source default-branch commit,
 * download the codeload tarball, whitelist-extract only the Skill's
 * subdirectory, stage inside the Skills Directory, then atomically rename
 * into place. Pure node + tar-stream with injected fetchers — no cordis, no
 * globals — so the SkillManager service (the test seam, ADR-0005) drives it
 * with fake fetchers and a temp Skills Directory root.
 *
 * Path Safety (CONTEXT.md): every tar entry name is scanned BEFORE selection
 * — an absolute path or `..` segment ANYWHERE fails the whole install (fail
 * closed on malicious archives). Selection then keeps only regular files
 * under the chosen prefix: a backslash-traversal entry pointing outside the
 * prefix can never match the prefix and is rejected at selection, while ANY
 * backslash inside the prefix fails the install outright (backslash is not a
 * tar separator but IS one on Windows). Symlink/hardlink entries are skipped
 * (never materialized); duplicate entry names collapse, the later one
 * winning. Each staged path is still resolve-checked against the staging
 * root. Any failure before the final rename leaves zero partial files.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'
import { extract } from 'tar-stream'
import { REGISTRY_DIR } from './registry'
import type { BinaryFetcher, Fetcher } from './service'
import type { SourceRef } from './validation'

const gunzip = promisify(gunzipCallback)

/** Install failure categories; the HTTP route maps each to a status code. */
export type InstallErrorCode =
  | 'invalid-input'
  | 'skill-not-found'
  | 'not-managed'
  | 'source-invalid'
  | 'unsafe-archive'
  | 'upstream'
  | 'fs'

export class InstallError extends Error {
  constructor(
    readonly code: InstallErrorCode,
    message: string,
    /** HTTP status of the failing upstream response, when there was one. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'InstallError'
  }
}

/** Network handles the pipeline needs (GitHub API base is Config-driven). */
export interface InstallNetworkOptions {
  githubApiBase: string
  githubCodeloadBase: string
  fetcher: Fetcher
  binaryFetcher: BinaryFetcher
  timeoutMs: number
}

/** Default-branch HEAD of the Source, resolved via the GitHub API. */
export interface ResolvedHead {
  headSha: string
  defaultBranch: string
}

/**
 * Resolve the Source repository's default branch and its HEAD commit:
 * `GET /repos/<owner>/<repo>` then `GET .../commits?sha=<branch>&per_page=1`.
 */
export async function resolveHead(options: InstallNetworkOptions, ref: SourceRef): Promise<ResolvedHead> {
  const repo = await fetchJson(options, `${options.githubApiBase}/repos/${ref.owner}/${ref.repo}`)
  const defaultBranch = (repo as { default_branch?: unknown }).default_branch
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    throw new InstallError('upstream', `unexpected GitHub repo response for ${ref.owner}/${ref.repo}: no default_branch`)
  }
  const sha = await fetchFirstCommitSha(options, ref, new URLSearchParams({ sha: defaultBranch, per_page: '1' }))
  if (sha === undefined) {
    throw new InstallError('upstream', `cannot resolve HEAD commit of ${ref.owner}/${ref.repo}@${defaultBranch}`)
  }
  return { headSha: sha, defaultBranch }
}

/**
 * Last commit touching the Skill's path on the default branch (recorded in
 * the Registry for update detection). Returns undefined on any failure — the
 * caller falls back to the already-resolved HEAD SHA (a newer, valid commit;
 * never a false "update available" for unchanged content).
 */
export async function resolvePathCommit(
  options: InstallNetworkOptions,
  ref: SourceRef,
  skillPath: string,
  defaultBranch: string,
): Promise<string | undefined> {
  if (skillPath === '') return undefined // repo-root layout: HEAD is the answer
  try {
    return await fetchFirstCommitSha(
      options,
      ref,
      new URLSearchParams({ sha: defaultBranch, path: skillPath, per_page: '1' }),
    )
  } catch {
    return undefined
  }
}

/** Shared `commits?...&per_page=1` lookup: the first (only) commit's SHA, or undefined. */
async function fetchFirstCommitSha(
  options: InstallNetworkOptions,
  ref: SourceRef,
  params: URLSearchParams,
): Promise<string | undefined> {
  const commits = await fetchJson(options, `${options.githubApiBase}/repos/${ref.owner}/${ref.repo}/commits?${params}`)
  const sha = Array.isArray(commits) ? (commits[0] as { sha?: unknown } | undefined)?.sha : undefined
  return typeof sha === 'string' && sha !== '' ? sha : undefined
}

/**
 * The update-check lookup: the latest default-branch commit touching the
 * Skill's path (repo-root layout answers HEAD itself). Unlike the install-time
 * resolvePathCommit this THROWS on failure (an InstallError whose `status`
 * marks 404-class responses) so the caller can tell a dead Source apart from
 * a transient one; undefined means the path has no commits at all — the
 * Source no longer contains the Skill.
 */
export async function queryLatestCommit(
  options: InstallNetworkOptions,
  ref: SourceRef,
  skillPath: string,
): Promise<string | undefined> {
  const { headSha, defaultBranch } = await resolveHead(options, ref)
  if (skillPath === '') return headSha
  return fetchFirstCommitSha(options, ref, new URLSearchParams({ sha: defaultBranch, path: skillPath, per_page: '1' }))
}

/** Download `codeload .../tar.gz/<sha>` and gunzip it into the tar buffer. */
export async function downloadTarball(options: InstallNetworkOptions, ref: SourceRef, sha: string): Promise<Buffer> {
  const url = `${options.githubCodeloadBase}/${ref.owner}/${ref.repo}/tar.gz/${sha}`
  let response
  try {
    response = await options.binaryFetcher(url, { signal: AbortSignal.timeout(options.timeoutMs) })
  } catch (error) {
    throw new InstallError('upstream', `tarball download failed: ${errorMessage(error)}`)
  }
  if (!response.ok) throw new InstallError('upstream', `tarball download failed: HTTP ${response.status}`, response.status)
  let gz: Buffer
  try {
    gz = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    throw new InstallError('upstream', `tarball download failed while reading: ${errorMessage(error)}`)
  }
  try {
    return await gunzip(gz)
  } catch {
    throw new InstallError('upstream', 'tarball download is not valid gzip data')
  }
}

interface TarEntrySummary {
  name: string
  type: string
}

/**
 * Pass 1: list every entry (name + type), enforcing the archive-wide safety
 * invariant — any absolute path or `..` segment anywhere fails the install
 * (fail closed on malicious archives), before anything is selected for
 * extraction. Names are normalized (`./` prefixes stripped).
 */
async function scanTarEntries(tar: Buffer): Promise<TarEntrySummary[]> {
  const entries: TarEntrySummary[] = []
  await walkTar(
    tar,
    () => false, // headers only; file contents are drained unread
    (header) => {
      const name = normalizeEntryName(header.name)
      assertSafeEntryName(name)
      entries.push({ name, type: header.type ?? 'file' })
    },
  )
  return entries
}

/** The Skill's location inside the tarball (extraction prefix + repo path). */
export interface SkillLocation {
  /** Entry-name prefix to extract (ends with `/`). */
  prefix: string
  /** Repo-relative Skill path for the Registry (`skills/<id>`, `<id>`, or ''). */
  skillPath: string
}

/**
 * Locate the Skill subdirectory with the same probe order as descriptions:
 * `skills/<skillId>/`, then `<skillId>/` (a match needs at least one regular
 * file beneath it), then the repository root — which only counts when a root
 * `SKILL.md` exists (otherwise any multi-skill repo would "match" and dump
 * its entire content into the target). Runs the archive-wide safety scan
 * first, so an unsafe archive fails here even when the Skill is present.
 */
export async function locateSkill(tar: Buffer, skillId: string): Promise<SkillLocation | undefined> {
  return selectSkillLocation(await scanTarEntries(tar), skillId)
}

function selectSkillLocation(entries: TarEntrySummary[], skillId: string): SkillLocation | undefined {
  const first = entries[0]
  if (first === undefined) return undefined
  const topSegment = first.name.split('/')[0]
  if (topSegment === first.name || topSegment === '') return undefined
  const repoPrefix = `${topSegment}/`
  const hasFileUnder = (prefix: string): boolean =>
    entries.some((entry) => entry.type === 'file' && entry.name.startsWith(prefix) && entry.name.length > prefix.length)
  for (const skillPath of [`skills/${skillId}`, skillId]) {
    if (hasFileUnder(`${repoPrefix}${skillPath}/`)) return { prefix: `${repoPrefix}${skillPath}/`, skillPath }
  }
  if (entries.some((entry) => entry.type === 'file' && entry.name === `${repoPrefix}SKILL.md`)) {
    return { prefix: repoPrefix, skillPath: '' }
  }
  return undefined
}

/**
 * Pass 2: collect the regular files under the selected prefix. Symlink and
 * hardlink entries are skipped (never followed, never recreated); directory
 * and device/fifo entries are skipped as well. The scan pass already failed
 * on traversal/absolute names, so relative paths here are clean by
 * construction — the staging write still resolve-checks each one.
 */
export async function collectSkillFiles(tar: Buffer, prefix: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const selected = (header: { name: string; type?: string | null }): boolean => {
    const name = normalizeEntryName(header.name)
    return name.startsWith(prefix) && name.length > prefix.length && (header.type ?? 'file') === 'file'
  }
  await walkTar(
    tar,
    (header) => selected(header),
    (header, data) => {
      if (!selected(header) || data === undefined) return
      const name = normalizeEntryName(header.name)
      const relative = name.slice(prefix.length)
      // Backslash is not a tar separator but IS one on Windows — fail closed.
      if (relative.includes('\\')) {
        throw new InstallError('unsafe-archive', `archive entry has an unsafe path: ${name}`)
      }
      files.set(relative, data)
    },
  )
  return files
}

/**
 * Shared tar walk over the buffered archive. `wantsData(header)` decides per
 * entry whether its content is buffered; `handle(header, data)` runs at entry
 * end (data is undefined for skipped entries). Errors thrown by either
 * callback abort the walk and reject; malformed tar data rejects the same
 * way. Callers map non-InstallError rejections to upstream-corruption errors.
 */
async function walkTar(
  tar: Buffer,
  wantsData: (header: { name: string; type?: string | null }) => boolean,
  handle: (header: { name: string; type?: string | null }, data: Buffer | undefined) => void,
): Promise<void> {
  const extractor = extract()
  const done = new Promise<void>((resolvePromise, rejectPromise) => {
    extractor.on('entry', (header, stream, next: (error?: unknown) => void) => {
      let collect: boolean
      try {
        collect = wantsData(header)
      } catch (error) {
        stream.resume()
        next(error)
        return
      }
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => {
        if (collect) chunks.push(chunk)
      })
      stream.on('error', (error: Error) => next(error))
      stream.on('end', () => {
        try {
          handle(header, collect ? Buffer.concat(chunks) : undefined)
          next()
        } catch (error) {
          next(error)
        }
      })
      stream.resume()
    })
    extractor.on('finish', () => resolvePromise())
    extractor.on('error', (error: Error) => rejectPromise(error))
  })
  extractor.end(tar)
  try {
    await done
  } catch (error) {
    if (error instanceof InstallError) throw error
    throw new InstallError('upstream', `tarball is not valid tar data: ${errorMessage(error)}`)
  }
}

/** Strip leading `./` segments so prefix matching is stable. */
function normalizeEntryName(name: string): string {
  let normalized = name
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  return normalized
}

/** Archive-wide invariant: no absolute paths, no `..` segments, ever. */
function assertSafeEntryName(name: string): void {
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name) || name.split('/').includes('..')) {
    throw new InstallError('unsafe-archive', `archive entry has an unsafe path: ${name}`)
  }
}

/**
 * Stage the extracted files under `stagingDir`. Every target path is resolved
 * and prefix-checked against the staging root (the last Path Safety gate).
 */
export async function writeStagedFiles(stagingDir: string, files: Map<string, Buffer>): Promise<void> {
  const root = resolve(stagingDir)
  for (const [relative, content] of files) {
    const target = resolve(root, ...relative.split('/'))
    if (target !== root && !target.startsWith(root + sep)) {
      throw new InstallError('unsafe-archive', `archive entry escapes the staging root: ${relative}`)
    }
    if (target === root) continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
}

/**
 * Move the staged directory into `<skillsDir>/<skillId>` by rename (atomic on
 * the same filesystem — staging lives inside the Skills Directory for exactly
 * this reason). When the target exists it is first renamed aside; the
 * returned backup path lets the caller roll back (registry-write failure) or
 * clean up (success). Throws with the backup restored when the swap fails.
 */
export async function swapIntoPlace(skillsDir: string, stagingDir: string, skillId: string): Promise<string | undefined> {
  const target = join(skillsDir, skillId)
  if (!(await pathExists(target))) {
    await rename(stagingDir, target)
    return undefined
  }
  const backup = join(skillsDir, REGISTRY_DIR, `.backup-${skillId}-${randomBytes(6).toString('hex')}`)
  await rename(target, backup)
  try {
    await rename(stagingDir, target)
  } catch (error) {
    await rename(backup, target)
    throw error
  }
  return backup
}

/** sha256 over sorted relative paths + file contents (update detection). */
export async function hashDirectory(root: string): Promise<string> {
  const files: string[] = []
  async function walk(dir: string, relative: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(join(dir, entry.name), entryRelative)
      else if (entry.isFile()) files.push(entryRelative)
    }
  }
  await walk(root, '')
  files.sort()
  const hash = createHash('sha256')
  for (const relative of files) {
    hash.update(relative)
    hash.update('\0')
    hash.update(await readFile(join(root, ...relative.split('/'))))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Unique staging directory name inside the Skills Directory's registry dir. */
export function stagingPath(skillsDir: string): string {
  return join(skillsDir, REGISTRY_DIR, `.staging-${process.pid}-${randomBytes(6).toString('hex')}`)
}

/** Fetch a JSON URL with timeout; any failure is an upstream InstallError. */
async function fetchJson(options: InstallNetworkOptions, url: string): Promise<unknown> {
  let response
  try {
    response = await options.fetcher(url, { signal: AbortSignal.timeout(options.timeoutMs) })
  } catch (error) {
    throw new InstallError('upstream', `GitHub API request failed: ${errorMessage(error)}`)
  }
  if (!response.ok) throw new InstallError('upstream', `GitHub API request failed: HTTP ${response.status} (${url})`, response.status)
  try {
    return JSON.parse(await response.text())
  } catch {
    throw new InstallError('upstream', 'GitHub API response is not valid JSON')
  }
}

/** Best-effort message for an unknown thrown value (shared with the service layer). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
