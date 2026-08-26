import { describe, expect, it } from 'vitest'

import { SearchError, SkillManager } from '../src/service'
import type { Fetcher, FetchResult, SkillManagerOptions } from '../src/service'

/** Canned-route fetcher: first matching route wins, unmatched URLs 404. */
function makeFetcher(routes: Array<{ match: string; status?: number; body?: string }> = []) {
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

function makeService(fetcher: Fetcher, overrides: Partial<SkillManagerOptions> = {}): SkillManager {
  return new SkillManager({
    catalogUrl: 'https://www.skills.sh',
    githubRawBase: 'https://raw.githubusercontent.com',
    fetchConcurrency: 5,
    descriptionCacheMaxEntries: 200,
    fetcher,
    ...overrides,
  })
}

const CATALOG_PAYLOAD = JSON.stringify({
  query: 'find',
  skills: [
    { id: 'vercel-labs/skills/find-skills', skillId: 'find-skills', name: 'find-skills', installs: 3117610, source: 'vercel-labs/skills' },
    { id: 'mattpocock/skills/wayfinder', skillId: 'wayfinder', name: 'Wayfinder', installs: 389100, source: 'mattpocock/skills' },
  ],
})

const SKILL_MD = ['---', 'name: wayfinder', 'description: Navigates large codebases.', '---', '', '# Wayfinder'].join('\n')

describe('SkillManager.search', () => {
  it('maps Catalog entries to result items', async () => {
    const { calls, fetcher } = makeFetcher([{ match: '/api/search', body: CATALOG_PAYLOAD }])
    const service = makeService(fetcher)
    const items = await service.search('find')
    expect(items).toEqual([
      {
        name: 'find-skills',
        skillId: 'find-skills',
        source: 'vercel-labs/skills',
        installs: 3117610,
        pageUrl: 'https://www.skills.sh/vercel-labs/skills/find-skills',
      },
      {
        name: 'Wayfinder',
        skillId: 'wayfinder',
        source: 'mattpocock/skills',
        installs: 389100,
        pageUrl: 'https://www.skills.sh/mattpocock/skills/wayfinder',
      },
    ])
    expect(calls).toEqual(['https://www.skills.sh/api/search?q=find'])
  })

  it('encodes the keyword and returns an empty list for empty results', async () => {
    const { calls, fetcher } = makeFetcher([{ match: '/api/search', body: '{"query":"x","skills":[]}' }])
    const service = makeService(fetcher)
    expect(await service.search('pdf tools')).toEqual([])
    expect(calls).toEqual(['https://www.skills.sh/api/search?q=pdf%20tools'])
  })

  it('drops malformed entries instead of failing the search', async () => {
    const body = JSON.stringify({
      skills: [
        { id: 'a/b/ok', skillId: 'ok', source: 'a/b', installs: 3 },
        { skillId: 'no-id', source: 'a/b' },
        'garbage',
      ],
    })
    const { fetcher } = makeFetcher([{ match: '/api/search', body }])
    const service = makeService(fetcher)
    const items = await service.search('ok')
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('ok')
    expect(items[0].installs).toBe(3)
  })

  it('throws SearchError on an empty keyword without contacting the Catalog', async () => {
    const { calls, fetcher } = makeFetcher()
    const service = makeService(fetcher)
    await expect(service.search('   ')).rejects.toBeInstanceOf(SearchError)
    expect(calls).toEqual([])
  })

  it('throws SearchError on upstream HTTP failure', async () => {
    const { fetcher } = makeFetcher([{ match: '/api/search', status: 500, body: 'oops' }])
    const service = makeService(fetcher)
    await expect(service.search('find')).rejects.toBeInstanceOf(SearchError)
  })

  it('throws SearchError on network failure', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('socket hang up')
    }
    const service = makeService(fetcher)
    await expect(service.search('find')).rejects.toBeInstanceOf(SearchError)
  })

  it('throws SearchError on a non-JSON or malformed response', async () => {
    const { fetcher } = makeFetcher([{ match: '/api/search', body: '<html>not json</html>' }])
    const service = makeService(fetcher)
    await expect(service.search('find')).rejects.toBeInstanceOf(SearchError)

    const { fetcher: fetcher2 } = makeFetcher([{ match: '/api/search', body: '{"unexpected":true}' }])
    const service2 = makeService(fetcher2)
    await expect(service2.search('find')).rejects.toBeInstanceOf(SearchError)
  })
})

describe('SkillManager.fetchDescription', () => {
  it('probes candidate paths in order and parses frontmatter', async () => {
    const { calls, fetcher } = makeFetcher([{ match: '/HEAD/wayfinder/SKILL.md', body: SKILL_MD }])
    const service = makeService(fetcher)
    expect(await service.fetchDescription('mattpocock/skills', 'wayfinder')).toBe('Navigates large codebases.')
    expect(calls).toEqual([
      'https://raw.githubusercontent.com/mattpocock/skills/HEAD/skills/wayfinder/SKILL.md',
      'https://raw.githubusercontent.com/mattpocock/skills/HEAD/wayfinder/SKILL.md',
    ])
  })

  it('falls back to the repository root SKILL.md', async () => {
    const { calls, fetcher } = makeFetcher([{ match: '/HEAD/SKILL.md', body: SKILL_MD }])
    const service = makeService(fetcher)
    expect(await service.fetchDescription('owner/repo', 'wayfinder')).toBe('Navigates large codebases.')
    expect(calls).toEqual([
      'https://raw.githubusercontent.com/owner/repo/HEAD/skills/wayfinder/SKILL.md',
      'https://raw.githubusercontent.com/owner/repo/HEAD/wayfinder/SKILL.md',
      'https://raw.githubusercontent.com/owner/repo/HEAD/SKILL.md',
    ])
  })

  it('returns the null sentinel when every probe path misses', async () => {
    const { calls, fetcher } = makeFetcher()
    const service = makeService(fetcher)
    expect(await service.fetchDescription('owner/repo', 'missing')).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it('stops probing when a found SKILL.md carries no description', async () => {
    const { calls, fetcher } = makeFetcher([{ match: '/HEAD/skills/x/SKILL.md', body: '# no frontmatter here' }])
    const service = makeService(fetcher)
    expect(await service.fetchDescription('owner/repo', 'x')).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('returns the null sentinel on network failures', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('connection reset')
    }
    const service = makeService(fetcher)
    expect(await service.fetchDescription('owner/repo', 'x')).toBeNull()
  })

  it('rejects invalid Source and Skill ID input without any fetch', async () => {
    const { calls, fetcher } = makeFetcher([{ match: '/HEAD/', body: SKILL_MD }])
    const service = makeService(fetcher)
    expect(await service.fetchDescription('owner/repo/extra', 'x')).toBeNull()
    expect(await service.fetchDescription('owner/../repo', 'x')).toBeNull()
    expect(await service.fetchDescription('', 'x')).toBeNull()
    expect(await service.fetchDescription('owner/repo', 'BAD_ID')).toBeNull()
    expect(await service.fetchDescription('owner/repo', '')).toBeNull()
    expect(calls).toEqual([])
  })

  it('caches positive and negative outcomes', async () => {
    const { calls, fetcher } = makeFetcher([{ match: '/HEAD/skills/x/SKILL.md', body: SKILL_MD }])
    const service = makeService(fetcher)
    expect(await service.fetchDescription('owner/repo', 'x')).toBe('Navigates large codebases.')
    expect(await service.fetchDescription('owner/repo', 'x')).toBe('Navigates large codebases.')
    expect(calls).toHaveLength(1)

    expect(await service.fetchDescription('owner/repo', 'missing')).toBeNull()
    const afterMiss = calls.length
    expect(await service.fetchDescription('owner/repo', 'missing')).toBeNull()
    expect(calls).toHaveLength(afterMiss)
  })

  it('evicts the oldest entry past the configured cache size', async () => {
    const { calls, fetcher } = makeFetcher([{ match: '/HEAD/skills/', body: SKILL_MD }])
    const service = makeService(fetcher, { descriptionCacheMaxEntries: 2 })
    await service.fetchDescription('owner/repo', 'a')
    await service.fetchDescription('owner/repo', 'b')
    await service.fetchDescription('owner/repo', 'c')
    expect(calls).toHaveLength(3)
    // 'a' was evicted by 'c'; fetching it again costs a new probe round,
    // which in turn evicts 'b' — the cache now holds {c, a}.
    await service.fetchDescription('owner/repo', 'a')
    expect(calls).toHaveLength(4)
    await service.fetchDescription('owner/repo', 'c')
    await service.fetchDescription('owner/repo', 'a')
    expect(calls).toHaveLength(4)
    await service.fetchDescription('owner/repo', 'b')
    expect(calls).toHaveLength(5)
  })

  it('bounds concurrent Source fetches', async () => {
    let inflight = 0
    let peak = 0
    const gates: Array<() => void> = []
    const fetcher: Fetcher = (url) => {
      expect(url).toContain('https://raw.githubusercontent.com/')
      inflight++
      peak = Math.max(peak, inflight)
      return new Promise<FetchResult>((resolve) => {
        gates.push(() => {
          inflight--
          resolve({ ok: true, status: 200, text: async () => SKILL_MD })
        })
      })
    }
    const service = makeService(fetcher, { fetchConcurrency: 2 })
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((id) => service.fetchDescription('owner/repo', id))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peak).toBe(2)
    expect(gates).toHaveLength(2)
    while (gates.length > 0) {
      gates.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(await Promise.all(tasks)).toEqual(Array(5).fill('Navigates large codebases.'))
    expect(peak).toBe(2)
  })

  it('deduplicates in-flight fetches for the same skill', async () => {
    let fetches = 0
    const fetcher: Fetcher = async () => {
      fetches++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { ok: true, status: 200, text: async () => SKILL_MD }
    }
    const service = makeService(fetcher)
    const [first, second] = await Promise.all([
      service.fetchDescription('owner/repo', 'x'),
      service.fetchDescription('owner/repo', 'x'),
    ])
    expect(first).toBe('Navigates large codebases.')
    expect(second).toBe('Navigates large codebases.')
    expect(fetches).toBe(1)
  })
})
