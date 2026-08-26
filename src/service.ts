/**
 * SkillManager — the host-side service holding all Catalog search, Skill
 * install, and Managed-Skill lifecycle logic (ADR-0005: the single test
 * seam). Plain class with injected fetchers and an injected Skills Directory
 * root, so tests run without network and without touching the real
 * `~/.dsh/skills`; the cordis plugin (index.ts) wires it to HTTP.
 *
 * Four data flows, honoring the exam's source constraints:
 * - search: only the Catalog is contacted (`GET <catalogUrl>/api/search?q=`).
 * - description: fetched lazily from the Source repository the Catalog entry
 *   itself names, via raw SKILL.md frontmatter; every failure degrades to the
 *   null sentinel (the UI shows its placeholder) — never an error state.
 * - install: the ADR-0001 pipeline (commit resolution → codeload tarball →
 *   whitelist extraction → staging → atomic rename → Registry record) plus
 *   the two-phase Confirmation protocol (ADR-0004): reinstalls and Overwrites
 *   of Unmanaged directories require `confirm: true`, checked by the host
 *   before any network call or write.
 * - manage: list-installed reads the Registry (the sole authority for
 *   "managed"); check-updates compares each record's commitSha against the
 *   Source's latest default-branch commit touching skillPath (404-class →
 *   persisted sourceInvalid, other failures → retryable per-skill error);
 *   update re-runs the pipeline with backup/rollback and refreshes the
 *   record; uninstall removes the directory and record. Update and uninstall
 *   are Confirmation-gated like install and only ever touch Registry-recorded
 *   targets — an Unmanaged directory is never listed, updated, or deleted.
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
  queryLatestCommit,
  resolveHead,
  resolvePathCommit,
  stagingPath,
  swapIntoPlace,
  writeStagedFiles,
} from './install'
import type { InstallNetworkOptions } from './install'
import { listRecords, readRecord, registryDir, removeRecord, writeRecord } from './registry'
import type { RegistryRecord } from './registry'
import { isValidSkillId, parseSource } from './validation'
import type { SourceRef } from './validation'

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

/** Shared request shape of the per-skill manage operations (update/uninstall). */
export interface ManageRequest {
  skillId: string
  /** Second phase of the Confirmation protocol: explicit user approval. */
  confirm?: boolean
}

/** First-phase manage response: the host refuses to mutate until re-called with confirm: true. */
export interface ManageConfirmationRequired {
  status: 'confirmation-required'
  action: 'update' | 'uninstall'
  skillId: string
  source: string
  targetPath: string
  /**
   * Update only: the on-disk content hash differs from the Registry — the
   * Skill was modified locally and the update will overwrite that. Absent
   * when the local copy is pristine (or the directory is missing).
   */
  localModified?: boolean
}

export interface UpdateSuccess {
  status: 'updated'
  action: 'update'
  skillId: string
  source: string
  targetPath: string
  /** Original install time (preserved across updates). */
  installedAt: string
  /** Time of this update. */
  updatedAt: string
  commitSha: string
  contentHash: string
  /** Non-fatal cleanup notice (same semantics as InstallSuccess.warning). */
  warning?: string
}

export type UpdateResult = UpdateSuccess | ManageConfirmationRequired

export interface UninstallSuccess {
  status: 'uninstalled'
  skillId: string
  source: string
  targetPath: string
  /** False when only the record was removed (the directory was already missing). */
  removedDirectory: boolean
}

export type UninstallResult = UninstallSuccess | ManageConfirmationRequired

/** Per-skill outcome of one check-updates run. */
export interface SkillUpdateState {
  skillId: string
  source: string
  /** The Source's latest commit touching skillPath differs from the record's. */
  updateAvailable: boolean
  /**
   * The Source answered a 404-class response or no longer contains the Skill.
   * Persisted on the record, so the badge and update()'s refusal need no
   * network; a later healthy check clears it again.
   */
  sourceInvalid: boolean
  /** The latest commit found, when the check succeeded. */
  latestCommitSha?: string
  /** Transient per-skill failure (network, rate limit, 5xx); retryable — the record's flag is left untouched. */
  error?: string
}

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
  /** Per-skill mutation mutex: skillId → tail of that skill's serialized op chain. */
  private readonly skillChains = new Map<string, Promise<void>>()

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
    return this.runSerialized(request.skillId, () => this.installSerialized(request))
  }

  /**
   * Serialize mutations of one skill: install, update, uninstall, and the
   * registry-flag writes of checkUpdates all chain onto the same per-skill
   * promise queue. The chain link swallows the outcome, so one failed op
   * cannot jam the queue; each caller still sees their own result.
   */
  private runSerialized<T>(skillId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.skillChains.get(skillId) ?? Promise.resolve()
    const result = previous.then(op)
    const link = result.then(
      () => undefined,
      () => undefined,
    )
    this.skillChains.set(skillId, link)
    void link.then(() => {
      if (this.skillChains.get(skillId) === link) this.skillChains.delete(skillId)
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
    const { record, warning } = await this.runPipeline(root, ref, request.source, request.skillId, {
      source: request.source,
      skillId: request.skillId,
      installedAt: new Date().toISOString(),
    })
    return {
      status: 'installed',
      action,
      skillId: request.skillId,
      source: request.source,
      targetPath,
      installedAt: record.installedAt,
      commitSha: record.commitSha,
      contentHash: record.contentHash,
      ...(warning !== undefined ? { warning } : {}),
    }
  }

  /**
   * The shared ADR-0001 pipeline behind install and update: resolve HEAD →
   * download tarball → locate the Skill subdirectory → whitelist extraction →
   * stage inside the Skills Directory → atomic swap (an existing target is
   * set aside as a backup) → content hash → path-commit resolution → Registry
   * record. `record` carries the caller's own fields (source, skillId,
   * installedAt, and update's updatedAt); the pipeline fills skillPath,
   * commitSha, and contentHash.
   *
   * Any failure before the swap leaves zero partial files; a post-swap
   * failure (hash, commit resolution, or the record write) rolls the previous
   * directory back into place and leaves the previous Registry record
   * untouched, so a failed update preserves the old version AND the old
   * record. A successful run may carry a `warning` when non-fatal backup
   * cleanup failed — residue there is harmless and never rolls the swap back.
   */
  private async runPipeline(
    root: string,
    ref: SourceRef,
    source: string,
    skillId: string,
    record: Omit<RegistryRecord, 'skillPath' | 'commitSha' | 'contentHash'>,
  ): Promise<{ record: RegistryRecord; warning?: string }> {
    const network = this.networkOptions()
    const { headSha, defaultBranch } = await resolveHead(network, ref)
    const tar = await downloadTarball(network, ref, headSha)
    const location = await locateSkill(tar, skillId)
    if (location === undefined) {
      throw new InstallError('skill-not-found', `skill ${skillId} not found in source ${source}`)
    }
    const files = await collectSkillFiles(tar, location.prefix)
    // Staging lives inside the Skills Directory so the final rename is atomic
    // (same filesystem); cleanup on failure leaves zero partial files.
    await mkdir(registryDir(root), { recursive: true })
    const staging = stagingPath(root)
    const targetPath = join(root, skillId)
    let backup: string | undefined
    try {
      await writeStagedFiles(staging, files)
      backup = await swapIntoPlace(root, staging, skillId)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw toInstallError(error)
    }
    try {
      const contentHash = await hashDirectory(targetPath)
      const pathCommit = await resolvePathCommit(network, ref, location.skillPath, defaultBranch)
      const finalRecord: RegistryRecord = {
        ...record,
        skillPath: location.skillPath,
        commitSha: pathCommit ?? headSha,
        contentHash,
      }
      await this.recordWriter(root, finalRecord)
      let warning: string | undefined
      if (backup !== undefined) {
        try {
          await rm(backup, { recursive: true, force: true })
        } catch (cleanupError) {
          // Backup cleanup is best-effort: leftover residue is harmless, so a
          // failed removal degrades to a warning — it must never fail (let
          // alone roll back) an otherwise successful pipeline run.
          warning = `previous-version backup could not be removed (harmless residue at ${backup}): ${errorMessage(cleanupError)}`
        }
      }
      return { record: finalRecord, ...(warning !== undefined ? { warning } : {}) }
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

  /** Network handles for the GitHub API / codeload calls (Config-driven bases). */
  private networkOptions(): InstallNetworkOptions {
    return {
      githubApiBase: this.githubApiBase,
      githubCodeloadBase: this.githubCodeloadBase,
      fetcher: this.fetcher,
      binaryFetcher: this.binaryFetcher,
      timeoutMs: this.installTimeoutMs,
    }
  }

  /** All Managed Skills (Registry records); the sole authority for "managed". */
  async listInstalled(): Promise<RegistryRecord[]> {
    return listRecords(resolve(this.skillsDir))
  }

  /**
   * One user-initiated update check over every Managed Skill: compare each
   * record's commitSha with the Source's latest default-branch commit
   * touching skillPath. A 404-class response (repo gone/private/renamed) or a
   * path with no commits at all marks the record sourceInvalid — persisted,
   * so the list-installed badge and update()'s refusal need no further
   * network; a later healthy check clears the flag again (staleness
   * self-heals). Any other failure (network, rate limit, 5xx) surfaces as a
   * per-skill retryable `error` and never marks the record invalid. Per-skill
   * work chains through the same mutation mutex, so a flag write can never
   * clobber a concurrent install/update record write, and network calls are
   * bounded by the shared fetch semaphore.
   */
  async checkUpdates(): Promise<SkillUpdateState[]> {
    const root = resolve(this.skillsDir)
    const records = await listRecords(root)
    return Promise.all(records.map((record) => this.runSerialized(record.skillId, () => this.checkOne(root, record))))
  }

  /** The per-skill check body; always runs inside that skill's mutex. */
  private async checkOne(root: string, record: RegistryRecord): Promise<SkillUpdateState> {
    const state: SkillUpdateState = {
      skillId: record.skillId,
      source: record.source,
      updateAvailable: false,
      sourceInvalid: record.sourceInvalid === true,
    }
    const ref = parseSource(record.source)
    if (ref === undefined) {
      // A tampered record whose Source no longer parses can never be checked.
      await this.persistSourceInvalid(root, record, true)
      return { ...state, sourceInvalid: true }
    }
    const network = this.networkOptions()
    let latest: string | undefined
    try {
      latest = await this.semaphore.run(() => queryLatestCommit(network, ref, record.skillPath))
    } catch (error) {
      if (error instanceof InstallError && (error.status === 404 || error.status === 410)) {
        await this.persistSourceInvalid(root, record, true)
        return { ...state, sourceInvalid: true }
      }
      // Transient failure: retryable per-skill error, the flag stays untouched.
      return { ...state, error: errorMessage(error) }
    }
    if (latest === undefined) {
      // No commit ever touched the path: the Source no longer contains the
      // Skill (CONTEXT.md Source Invalid).
      await this.persistSourceInvalid(root, record, true)
      return { ...state, sourceInvalid: true }
    }
    await this.persistSourceInvalid(root, record, false)
    return { ...state, sourceInvalid: false, updateAvailable: latest !== record.commitSha, latestCommitSha: latest }
  }

  /**
   * Maintain the record's persisted sourceInvalid flag. Best-effort: the
   * check result stands even when the write fails — update() on a truly dead
   * Source hits the 404 again at resolve time and fails before any write.
   */
  private async persistSourceInvalid(root: string, record: RegistryRecord, sourceInvalid: boolean): Promise<void> {
    if ((record.sourceInvalid === true) === sourceInvalid) return
    const next: RegistryRecord = { ...record }
    if (sourceInvalid) next.sourceInvalid = true
    else delete next.sourceInvalid
    try {
      await this.recordWriter(root, next)
    } catch {
      /* best-effort persist — see docstring */
    }
  }

  /**
   * Update a Managed Skill to its Source's latest default-branch state
   * (Confirmation-gated). The Registry is the sole authority: no record →
   * not-managed refusal; a record flagged sourceInvalid → source-invalid
   * refusal (uninstall stays available). Before the Confirmation gate the
   * current directory's content hash is recomputed — a mismatch against the
   * record means local modification, and the confirmation-required response
   * carries `localModified: true` so the modal can show the overwrite
   * warning. The gate precedes every network call and write. On confirm the
   * install pipeline re-runs and the record is refreshed (commitSha,
   * contentHash, updatedAt; installedAt preserved; sourceInvalid dropped — a
   * successful update proves the Source healthy). Any failure preserves the
   * old version AND the Registry unchanged (runPipeline's rollback).
   */
  async update(request: ManageRequest): Promise<UpdateResult> {
    return this.runSerialized(request.skillId, () => this.updateSerialized(request))
  }

  /** The update body; always runs inside the per-skill mutex. */
  private async updateSerialized(request: ManageRequest): Promise<UpdateResult> {
    if (!isValidSkillId(request.skillId)) {
      throw new InstallError('invalid-input', `invalid skill id: ${JSON.stringify(request.skillId)}`)
    }
    const root = resolve(this.skillsDir)
    const targetPath = join(root, request.skillId)
    if (targetPath !== root && !targetPath.startsWith(root + sep)) {
      // Unreachable given the Skill ID grammar; kept as a hard Path Safety gate.
      throw new InstallError('invalid-input', `target path escapes the skills directory: ${request.skillId}`)
    }
    const record = await readRecord(root, request.skillId)
    if (record === undefined) {
      throw new InstallError('not-managed', `skill ${request.skillId} is not managed by this plugin`)
    }
    if (record.sourceInvalid === true) {
      throw new InstallError(
        'source-invalid',
        `source ${record.source} of skill ${request.skillId} is invalid; update is unavailable`,
      )
    }
    const ref = parseSource(record.source)
    if (ref === undefined) {
      // A tampered record whose Source no longer parses can never be updated;
      // fail closed as source-invalid (uninstall remains available).
      throw new InstallError('source-invalid', `recorded source is malformed: ${JSON.stringify(record.source)}`)
    }
    // Local-modification detection runs BEFORE the Confirmation gate: it is a
    // pure local read (zero network) and the warning must ride the
    // confirmation-required response. A missing directory has nothing local
    // to lose — the pipeline simply recreates it.
    const localModified = (await pathExists(targetPath)) && (await hashDirectory(targetPath)) !== record.contentHash
    if (request.confirm !== true) {
      return {
        status: 'confirmation-required',
        action: 'update',
        skillId: request.skillId,
        source: record.source,
        targetPath,
        ...(localModified ? { localModified: true } : {}),
      }
    }
    const updatedAt = new Date().toISOString()
    const { record: next, warning } = await this.runPipeline(root, ref, record.source, request.skillId, {
      source: record.source,
      skillId: request.skillId,
      installedAt: record.installedAt,
      updatedAt,
    })
    return {
      status: 'updated',
      action: 'update',
      skillId: request.skillId,
      source: record.source,
      targetPath,
      installedAt: next.installedAt,
      updatedAt,
      commitSha: next.commitSha,
      contentHash: next.contentHash,
      ...(warning !== undefined ? { warning } : {}),
    }
  }

  /**
   * Uninstall a Managed Skill (Confirmation-gated, zero network). Only
   * Registry-recorded targets are touched: the skillId is re-validated
   * against the dsh grammar and the target path resolve-prefix-checked
   * against the Skills Directory before anything is deleted; a target with
   * no record is refused with a structured not-managed error — the plugin
   * never deletes an Unmanaged directory. On confirm the directory is removed
   * first and the record second, so a record-removal failure self-heals on
   * retry: a missing directory with an existing record degrades to removing
   * the record alone (benign).
   */
  async uninstall(request: ManageRequest): Promise<UninstallResult> {
    return this.runSerialized(request.skillId, () => this.uninstallSerialized(request))
  }

  /** The uninstall body; always runs inside the per-skill mutex. */
  private async uninstallSerialized(request: ManageRequest): Promise<UninstallResult> {
    if (!isValidSkillId(request.skillId)) {
      throw new InstallError('invalid-input', `invalid skill id: ${JSON.stringify(request.skillId)}`)
    }
    const root = resolve(this.skillsDir)
    const targetPath = join(root, request.skillId)
    if (targetPath !== root && !targetPath.startsWith(root + sep)) {
      // Unreachable given the Skill ID grammar; kept as a hard Path Safety gate.
      throw new InstallError('invalid-input', `target path escapes the skills directory: ${request.skillId}`)
    }
    const record = await readRecord(root, request.skillId)
    if (record === undefined) {
      throw new InstallError(
        'not-managed',
        `skill ${request.skillId} is not managed by this plugin; refusing to delete ${targetPath}`,
      )
    }
    if (request.confirm !== true) {
      return {
        status: 'confirmation-required',
        action: 'uninstall',
        skillId: request.skillId,
        source: record.source,
        targetPath,
      }
    }
    const removedDirectory = await pathExists(targetPath)
    try {
      if (removedDirectory) await rm(targetPath, { recursive: true })
      await removeRecord(root, request.skillId)
    } catch (error) {
      throw toInstallError(error)
    }
    return {
      status: 'uninstalled',
      skillId: request.skillId,
      source: record.source,
      targetPath,
      removedDirectory,
    }
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
