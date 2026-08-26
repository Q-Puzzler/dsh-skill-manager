/**
 * SkillManager — the host-side service holding all Catalog search and Skill
 * install logic (ADR-0005: the single test seam). Plain class with injected
 * fetchers and an injected Skills Directory root, so tests run without
 * network and without touching the real `~/.dsh/skills`; the cordis plugin
 * (index.ts) wires it to HTTP.
 *
 * Three data flows, honoring the exam's source constraints:
 * - search: only the Catalog is contacted (`GET <catalogUrl>/api/search?q=`).
 * - description: fetched lazily from the Source repository the Catalog entry
 *   itself names, via raw SKILL.md frontmatter; every failure degrades to the
 *   null sentinel (the UI shows its placeholder) — never an error state.
 * - install: the ADR-0001 pipeline (commit resolution → codeload tarball →
 *   whitelist extraction → staging → atomic rename → Registry record) plus
 *   the two-phase Confirmation protocol (ADR-0004): reinstalls and Overwrites
 *   of Unmanaged directories require `confirm: true`, checked by the host
 *   before any network call or write.
 */
import { mkdir, rm, rename } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { extractFrontmatterDescription } from './frontmatter'
import {
  InstallError,
  collectSkillFiles,
  downloadTarball,
  errorMessage,
  hashDirectory,
  locateSkill,
  pathExists,
  resolveHead,
  resolvePathCommit,
  stagingPath,
  swapIntoPlace,
  writeStagedFiles,
} from './install'
import type { InstallNetworkOptions } from './install'
import { listRecords, readRecord, registryDir, writeRecord } from './registry'
import type { RegistryRecord } from './registry'
import { isValidSkillId, parseSource } from './validation'

/** Minimal structural subset of fetch/Response the service relies on. */
export interface FetchResult {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResult>

/** Binary subset of fetch/Response for tarball downloads. */
export interface BinaryFetchResult {
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export type BinaryFetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<BinaryFetchResult>

export interface SkillManagerOptions {
  /** Catalog base URL — the sole online data source for searching and linking Skills. */
  catalogUrl: string
  /** Base URL for raw Source file fetches (SKILL.md descriptions). */
  githubRawBase: string
  /** GitHub API base for commit resolution (repo info, commits). */
  githubApiBase: string
  /** Codeload base for tarball downloads. */
  githubCodeloadBase: string
  /** Skills Directory root ($DSH_HOME/skills resolution happens in index.ts). */
  skillsDir: string
  /** Upper bound of concurrent Source fetches. */
  fetchConcurrency: number
  /** Upper bound of cached description outcomes (positive and negative). */
  descriptionCacheMaxEntries: number
  /** Per-request Source fetch timeout in milliseconds. */
  descriptionFetchTimeoutMs: number
  /** Per-request timeout for install-time API and tarball fetches, in milliseconds. */
  installFetchTimeoutMs: number
  fetcher: Fetcher
  binaryFetcher: BinaryFetcher
  /** Registry record writer (test seam for write failures); defaults to registry.writeRecord. */
  writeRecord?: (skillsDir: string, record: RegistryRecord) => Promise<void>
}

/** One Catalog search result, mapped for the settings page. */
export interface SearchItem {
  name: string
  skillId: string
  source: string
  installs: number
  /** Catalog page URL (`<catalogUrl>/<id>`). */
  pageUrl: string
}

/** Probe order for a Skill's SKILL.md within its Source (most specific first). */
export const DESCRIPTION_PROBE_PATHS = [
  (skillId: string) => `skills/${skillId}/SKILL.md`,
  (skillId: string) => `${skillId}/SKILL.md`,
  () => 'SKILL.md',
] as const

/** Thrown by search failures; the route maps it to an error response. */
export class SearchError extends Error {}

/** What installing a Skill will do to the target directory. */
export type InstallAction = 'install' | 'reinstall' | 'overwrite'

export interface InstallRequest {
  source: string
  skillId: string
  /** Second phase of the Confirmation protocol: explicit user approval. */
  confirm?: boolean
}

/** First-phase response: the host refuses to write until re-called with confirm: true. */
export interface ConfirmationRequired {
  status: 'confirmation-required'
  action: 'reinstall' | 'overwrite'
  skillId: string
  source: string
  targetPath: string
}

export interface InstallSuccess {
  status: 'installed'
  action: InstallAction
  skillId: string
  source: string
  targetPath: string
  installedAt: string
  commitSha: string
  contentHash: string
  /** Non-fatal cleanup notice (e.g. a leftover backup directory); absent when all clean. */
  warning?: string
}

export type InstallResult = InstallSuccess | ConfirmationRequired

/** Bounded FIFO cache: oldest entries are evicted past the configured size. */
class BoundedCache<V> {
  private readonly entries = new Map<string, V>()

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    return this.entries.get(key)
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next()
      /* v8 ignore next -- size > max >= 1 guarantees an oldest key */
      this.entries.delete(oldest.value as string)
    }
  }
}

/** Counting semaphore bounding concurrent task execution. */
class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export class SkillManager {
  private readonly catalogUrl: string
  private readonly githubRawBase: string
  private readonly githubApiBase: string
  private readonly githubCodeloadBase: string
  private readonly skillsDir: string
  private readonly fetcher: Fetcher
  private readonly binaryFetcher: BinaryFetcher
  private readonly fetchTimeoutMs: number
  private readonly installTimeoutMs: number
  private readonly semaphore: Semaphore
  private readonly cache: BoundedCache<string | null>
  private readonly pending = new Map<string, Promise<string | null>>()
  private readonly recordWriter: (skillsDir: string, record: RegistryRecord) => Promise<void>
  /** Per-skill install mutex: skillId → tail of that skill's serialized install chain. */
  private readonly installChains = new Map<string, Promise<void>>()

  constructor(options: SkillManagerOptions) {
    this.catalogUrl = options.catalogUrl.replace(/\/+$/, '')
    this.githubRawBase = options.githubRawBase.replace(/\/+$/, '')
    this.githubApiBase = options.githubApiBase.replace(/\/+$/, '')
    this.githubCodeloadBase = options.githubCodeloadBase.replace(/\/+$/, '')
    this.skillsDir = options.skillsDir
    this.fetcher = options.fetcher
    this.binaryFetcher = options.binaryFetcher
    this.fetchTimeoutMs = Math.max(1, Math.floor(options.descriptionFetchTimeoutMs))
    this.installTimeoutMs = Math.max(1, Math.floor(options.installFetchTimeoutMs))
    this.semaphore = new Semaphore(Math.max(1, Math.floor(options.fetchConcurrency)))
    this.cache = new BoundedCache(Math.max(1, Math.floor(options.descriptionCacheMaxEntries)))
    this.recordWriter = options.writeRecord ?? writeRecord
  }

  /**
   * Search the Catalog by keyword. Only the Catalog API is contacted.
   * Throws SearchError on upstream or network failure (the UI shows the
   * error state with retry — search failure IS an error, unlike description).
   */
  async search(keyword: string): Promise<SearchItem[]> {
    const query = keyword.trim()
    if (query === '') throw new SearchError('keyword must not be empty')
    let response: FetchResult
    try {
      response = await this.fetcher(`${this.catalogUrl}/api/search?q=${encodeURIComponent(query)}`)
    } catch (error) {
      throw new SearchError(`catalog search request failed: ${errorMessage(error)}`)
    }
    if (!response.ok) throw new SearchError(`catalog search failed: HTTP ${response.status}`)
    let payload: unknown
    try {
      payload = JSON.parse(await response.text())
    } catch {
      throw new SearchError('catalog search failed: response is not valid JSON')
    }
    const skills = (payload as { skills?: unknown }).skills
    if (!Array.isArray(skills)) throw new SearchError('catalog search failed: unexpected response shape')
    const items: SearchItem[] = []
    for (const raw of skills) {
      const item = mapSearchItem(raw, this.catalogUrl)
      if (item !== undefined) items.push(item)
    }
    return items
  }

  /**
   * Fetch a result's Description from its Source (raw SKILL.md frontmatter),
   * bounded by the concurrency semaphore and cached (negative outcomes too).
   * Returns the null sentinel on ANY failure — invalid input, all probe paths
   * missing, network errors — so the UI silently shows its placeholder.
   */
  async fetchDescription(source: string, skillId: string): Promise<string | null> {
    const ref = parseSource(source)
    if (ref === undefined || !isValidSkillId(skillId)) return null
    const key = `${ref.owner}/${ref.repo}/${skillId}`
    if (this.cache.has(key)) return this.cache.get(key) ?? null
    const pending = this.pending.get(key)
    if (pending !== undefined) return pending
    const task = this.semaphore
      .run(() => this.probeDescription(ref.owner, ref.repo, skillId))
      .catch(() => null)
      .then((description) => {
        this.cache.set(key, description)
        this.pending.delete(key)
        return description
      })
    this.pending.set(key, task)
    return task
  }

  /** Probe the candidate SKILL.md paths in order; first hit wins. */
  private async probeDescription(owner: string, repo: string, skillId: string): Promise<string | null> {
    for (const buildPath of DESCRIPTION_PROBE_PATHS) {
      const url = `${this.githubRawBase}/${owner}/${repo}/HEAD/${buildPath(skillId)}`
      let response: FetchResult
      try {
        response = await this.fetcher(url, { signal: AbortSignal.timeout(this.fetchTimeoutMs) })
      } catch {
        continue
      }
      if (!response.ok) continue
      // A found SKILL.md without a usable description ends the probe: the
      // Skill exists at this location and simply has no description to show.
      return extractFrontmatterDescription(await response.text()) ?? null
    }
    return null
  }

  /**
   * Install a Skill into the Skills Directory (ADR-0001 pipeline):
   * validate → Confirmation check → resolve HEAD → download tarball →
   * locate the Skill subdirectory → whitelist extraction → stage → atomic
   * rename → content hash → Registry record.
   *
   * Two-phase Confirmation (ADR-0004): the target is inspected BEFORE any
   * network call or write. A fresh target installs directly; an existing
   * Managed target is a reinstall and an existing Unmanaged directory is an
   * Overwrite — both return confirmation-required (zero writes) unless the
   * request carries `confirm: true`. The host never trusts the UI to have
   * asked. Throws InstallError (invalid-input / skill-not-found /
   * unsafe-archive / upstream / fs) on failure; any failure before the swap
   * leaves zero partial files, and a post-swap failure rolls the previous
   * directory back into place.
   *
   * Installs of the SAME skill are serialized through a per-skill promise
   * chain, so concurrent staging/swap/record writes can never interleave
   * (the registry temp-file race); different skills still install in
   * parallel. A successful install may carry a `warning` when non-fatal
   * cleanup (removing the previous-version backup) failed — residue there
   * is harmless and never rolls the install back.
   */
  async install(request: InstallRequest): Promise<InstallResult> {
    const previous = this.installChains.get(request.skillId) ?? Promise.resolve()
    const result = previous.then(() => this.installSerialized(request))
    // The chain link swallows the outcome, so one failed install cannot jam
    // the queue; each caller still sees their own result or rejection.
    const link = result.then(
      () => undefined,
      () => undefined,
    )
    this.installChains.set(request.skillId, link)
    void link.then(() => {
      if (this.installChains.get(request.skillId) === link) this.installChains.delete(request.skillId)
    })
    return result
  }

  /** The install pipeline body; always runs inside the per-skill mutex. */
  private async installSerialized(request: InstallRequest): Promise<InstallResult> {
    const ref = parseSource(request.source)
    if (ref === undefined || !isValidSkillId(request.skillId)) {
      throw new InstallError(
        'invalid-input',
        `invalid source or skill id: ${JSON.stringify(request.source)}, ${JSON.stringify(request.skillId)}`,
      )
    }
    const root = resolve(this.skillsDir)
    const targetPath = join(root, request.skillId)
    if (targetPath !== root && !targetPath.startsWith(root + sep)) {
      // Unreachable given the Skill ID grammar; kept as a hard Path Safety gate.
      throw new InstallError('invalid-input', `target path escapes the skills directory: ${request.skillId}`)
    }
    const targetExists = await pathExists(targetPath)
    const existing = targetExists ? await readRecord(root, request.skillId) : undefined
    const action: InstallAction = !targetExists ? 'install' : existing !== undefined ? 'reinstall' : 'overwrite'
    if (action !== 'install' && request.confirm !== true) {
      return {
        status: 'confirmation-required',
        action,
        skillId: request.skillId,
        source: request.source,
        targetPath,
      }
    }
    const network: InstallNetworkOptions = {
      githubApiBase: this.githubApiBase,
      githubCodeloadBase: this.githubCodeloadBase,
      fetcher: this.fetcher,
      binaryFetcher: this.binaryFetcher,
      timeoutMs: this.installTimeoutMs,
    }
    const { headSha, defaultBranch } = await resolveHead(network, ref)
    const tar = await downloadTarball(network, ref, headSha)
    const location = await locateSkill(tar, request.skillId)
    if (location === undefined) {
      throw new InstallError('skill-not-found', `skill ${request.skillId} not found in source ${request.source}`)
    }
    const files = await collectSkillFiles(tar, location.prefix)
    // Staging lives inside the Skills Directory so the final rename is atomic
    // (same filesystem); cleanup on failure leaves zero partial files.
    await mkdir(registryDir(root), { recursive: true })
    const staging = stagingPath(root)
    let backup: string | undefined
    try {
      await writeStagedFiles(staging, files)
      backup = await swapIntoPlace(root, staging, request.skillId)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw toInstallError(error)
    }
    try {
      const contentHash = await hashDirectory(targetPath)
      const pathCommit = await resolvePathCommit(network, ref, location.skillPath, defaultBranch)
      const record: RegistryRecord = {
        source: request.source,
        skillId: request.skillId,
        skillPath: location.skillPath,
        installedAt: new Date().toISOString(),
        commitSha: pathCommit ?? headSha,
        contentHash,
      }
      await this.recordWriter(root, record)
      let warning: string | undefined
      if (backup !== undefined) {
        try {
          await rm(backup, { recursive: true, force: true })
        } catch (cleanupError) {
          // Backup cleanup is best-effort: leftover residue is harmless, so a
          // failed removal degrades to a warning — it must never fail (let
          // alone roll back) an otherwise successful install.
          warning = `previous-version backup could not be removed (harmless residue at ${backup}): ${errorMessage(cleanupError)}`
        }
      }
      return {
        status: 'installed',
        action,
        skillId: request.skillId,
        source: request.source,
        targetPath,
        installedAt: record.installedAt,
        commitSha: record.commitSha,
        contentHash,
        ...(warning !== undefined ? { warning } : {}),
      }
    } catch (error) {
      const failure = toInstallError(error)
      try {
        await rm(targetPath, { recursive: true, force: true })
        if (backup !== undefined) await rename(backup, targetPath)
      } catch (rollbackError) {
        // The original failure stays primary; rollback trouble is appended as
        // supplementary context instead of masking it.
        throw new InstallError(failure.code, `${failure.message} (rollback incomplete: ${errorMessage(rollbackError)})`)
      }
      throw failure
    }
  }

  /** All Managed Skills (Registry records); the sole authority for "managed". */
  async listInstalled(): Promise<RegistryRecord[]> {
    return listRecords(resolve(this.skillsDir))
  }
}

/** Map one raw Catalog skill entry; malformed entries are dropped. */
function mapSearchItem(raw: unknown, catalogUrl: string): SearchItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id === '') return undefined
  if (typeof entry.skillId !== 'string' || entry.skillId === '') return undefined
  if (typeof entry.source !== 'string' || entry.source === '') return undefined
  return {
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.skillId,
    skillId: entry.skillId,
    source: entry.source,
    installs: typeof entry.installs === 'number' && Number.isFinite(entry.installs) ? entry.installs : 0,
    pageUrl: `${catalogUrl}/${entry.id}`,
  }
}

/** Wrap unexpected filesystem failures; InstallErrors pass through unchanged. */
function toInstallError(error: unknown): InstallError {
  if (error instanceof InstallError) return error
  return new InstallError('fs', `filesystem operation failed: ${errorMessage(error)}`)
}
