/**
 * Host half of the plugin: a SkillManager service (all logic, service.ts)
 * exposed as plain HTTP routes on ctx.webServer under the plugin-unique
 * `/skill-manager/api` prefix (ADR-0006). The prefix avoids both the dsh-owned
 * `/api` RPC bridge and the `/plugins/<id>/client.js` bundle route; the
 * registration rides ctx.effect so plugin unload disposes the route.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { SearchError, SkillManager } from './service'

/** Plugin name, matching the loader entry id in cordis.patch.yml. */
export const name = 'skill-manager'

/** Host services required before activation: the route registry. */
export const inject: string[] = ['webServer']

export interface Config {
  /** Catalog base URL — the sole online data source for searching and linking Skills. */
  catalogUrl: string
  /** Base URL for raw Source file fetches (SKILL.md descriptions). */
  githubRawBase: string
  /** Upper bound of concurrent Source fetches for descriptions. */
  fetchConcurrency: number
  /** Upper bound of cached description outcomes (positive and negative). */
  descriptionCacheMaxEntries: number
  /** Per-request Source fetch timeout for descriptions, in milliseconds. */
  descriptionFetchTimeoutMs: number
}

export const Config = Schema.object({
  catalogUrl: Schema.string()
    .description('Catalog base URL — the sole online data source for searching and linking Skills.')
    .default('https://www.skills.sh'),
  githubRawBase: Schema.string()
    .description('Base URL for raw Source file fetches (SKILL.md descriptions).')
    .default('https://raw.githubusercontent.com'),
  fetchConcurrency: Schema.natural()
    .description('Upper bound of concurrent Source fetches for descriptions.')
    .default(5),
  descriptionCacheMaxEntries: Schema.natural()
    .description('Upper bound of cached description outcomes (positive and negative).')
    .default(200),
  descriptionFetchTimeoutMs: Schema.natural()
    .description('Per-request Source fetch timeout for descriptions, in milliseconds.')
    .default(10_000),
})

/** Plugin-unique route prefix (ADR-0006); every endpoint below hangs off it. */
export const ROUTE_PREFIX = '/skill-manager/api'

/** Abuse guard on the query string; generous for real keyword searches. */
const MAX_QUERY_LENGTH = 200

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.once('error', () => {})
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* client disconnected */
  }
}

export function apply(ctx: Context, config: Config): void {
  const service = new SkillManager({ ...config, fetcher: (url, init) => fetch(url, init) })
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname.replace(/\/+$/, '')
          try {
            if (req.method !== 'GET') {
              json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
              return
            }
            if (path === `${ROUTE_PREFIX}/search`) {
              const query = url.searchParams.get('q') ?? ''
              if (query.trim() === '') {
                json(res, 400, { ok: false, error: 'missing query parameter: q' })
                return
              }
              if (query.length > MAX_QUERY_LENGTH) {
                json(res, 400, { ok: false, error: 'query parameter q is too long' })
                return
              }
              try {
                const skills = await service.search(query)
                json(res, 200, { ok: true, data: { skills } })
              } catch (error) {
                const message = error instanceof SearchError ? error.message : 'catalog search failed'
                json(res, 502, { ok: false, error: message })
              }
              return
            }
            if (path === `${ROUTE_PREFIX}/fetch-description`) {
              const source = url.searchParams.get('source') ?? ''
              const skillId = url.searchParams.get('skillId') ?? ''
              if (source === '' || skillId === '') {
                json(res, 400, { ok: false, error: 'missing query parameters: source, skillId' })
                return
              }
              // Never a failure surface: invalid input and every upstream
              // problem collapse to the null sentinel inside the service.
              const description = await service.fetchDescription(source, skillId)
              json(res, 200, { ok: true, data: { description } })
              return
            }
            json(res, 404, { ok: false, error: `unknown endpoint: ${path}` })
          } catch (error) {
            ctx.logger(name).warn('request failed', error)
            json(res, 500, { ok: false, error: 'internal error' })
          }
        },
      }),
    'skill-manager: http routes',
  )
}
