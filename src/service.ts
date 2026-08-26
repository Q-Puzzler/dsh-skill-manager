/**
 * SkillManager — the host-side service holding all Catalog search logic
 * (ADR-0005: the single test seam). Plain class with an injected fetcher, so
 * tests run without network; the cordis plugin (index.ts) wires it to HTTP.
 *
 * Two data flows, honoring the exam's source constraints:
 * - search: only the Catalog is contacted (`GET <catalogUrl>/api/search?q=`).
 * - description: fetched lazily from the Source repository the Catalog entry
 *   itself names, via raw SKILL.md frontmatter; every failure degrades to the
 *   null sentinel (the UI shows its placeholder) — never an error state.
 */
import { extractFrontmatterDescription } from './frontmatter'
import { isValidSkillId, parseSource } from './validation'

/** Minimal structural subset of fetch/Response the service relies on. */
export interface FetchResult {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResult>

export interface SkillManagerOptions {
  /** Catalog base URL — the sole online data source for searching and linking Skills. */
  catalogUrl: string
  /** Base URL for raw Source file fetches (SKILL.md descriptions). */
  githubRawBase: string
  /** Upper bound of concurrent Source fetches. */
  fetchConcurrency: number
  /** Upper bound of cached description outcomes (positive and negative). */
  descriptionCacheMaxEntries: number
  fetcher: Fetcher
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

/** Per-request Source fetch timeout; long enough for a cold GitHub raw hit. */
const DESCRIPTION_FETCH_TIMEOUT_MS = 10_000

/** Thrown by search failures; the route maps it to an error response. */
export class SearchError extends Error {}

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
  private readonly fetcher: Fetcher
  private readonly semaphore: Semaphore
  private readonly cache: BoundedCache<string | null>
  private readonly pending = new Map<string, Promise<string | null>>()

  constructor(options: SkillManagerOptions) {
    this.catalogUrl = options.catalogUrl.replace(/\/+$/, '')
    this.githubRawBase = options.githubRawBase.replace(/\/+$/, '')
    this.fetcher = options.fetcher
    this.semaphore = new Semaphore(Math.max(1, Math.floor(options.fetchConcurrency)))
    this.cache = new BoundedCache(Math.max(1, Math.floor(options.descriptionCacheMaxEntries)))
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
        response = await this.fetcher(url, { signal: AbortSignal.timeout(DESCRIPTION_FETCH_TIMEOUT_MS) })
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
