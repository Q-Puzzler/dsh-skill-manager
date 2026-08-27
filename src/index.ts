/**
 * Host half of the plugin: a SkillManager service (all logic, service.ts)
 * exposed as plain HTTP routes on ctx.webServer under the plugin-unique
 * `/skill-manager/api` prefix (ADR-0006). The prefix avoids both the dsh-owned
 * `/api` RPC bridge and the `/plugins/<id>/client.js` bundle route; the
 * registration rides ctx.effect so plugin unload disposes the route.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from '@deepseek-ai/schemastery'
import { InstallError } from './install'
import type { InstallErrorCode } from './install'
import { SearchError, SkillManager } from './service'

/** Plugin name, matching the loader entry id in cordis.patch.yml. */
export const name = 'skill-manager'

/** Host services required before activation: the route registry. */
export const inject: string[] = ['webServer']

/**
 * Skills Directory resolution, mirroring dsh: `$DSH_HOME/skills`, defaulting
 * to `~/.dsh/skills`. Config-overridable so tests inject a temp root — the
 * real user Skills Directory is never touched by tests.
 */
export function defaultSkillsDir(): string {
  const dshHome = process.env.DSH_HOME
  return dshHome !== undefined && dshHome !== '' ? join(dshHome, 'skills') : join(homedir(), '.dsh', 'skills')
}

export interface Config {
  /** Catalog base URL — the sole online data source for searching and linking Skills. */
  catalogUrl: string
  /** Base URL for raw Source file fetches (SKILL.md descriptions). */
  githubRawBase: string
  /** GitHub API base for install-time commit resolution. */
  githubApiBase: string
  /** Codeload base for install-time tarball downloads. */
  githubCodeloadBase: string
  /** Skills Directory root (default: the dsh $DSH_HOME/skills resolution). */
  skillsDir: string
  /** Upper bound of concurrent Source fetches for descriptions. */
  fetchConcurrency: number
  /** Upper bound of cached description outcomes (positive and negative). */
  descriptionCacheMaxEntries: number
  /** Per-request Source fetch timeout for descriptions, in milliseconds. */
  descriptionFetchTimeoutMs: number
  /** Per-request timeout for install-time API and tarball fetches, in milliseconds. */
  installFetchTimeoutMs: number
}

export const Config = Schema.object({
  catalogUrl: Schema.string()
    .description('Catalog base URL — the sole online data source for searching and linking Skills.')
    .default('https://www.skills.sh'),
  githubRawBase: Schema.string()
    .description('Base URL for raw Source file fetches (SKILL.md descriptions).')
    .default('https://raw.githubusercontent.com'),
  githubApiBase: Schema.string()
    .description('GitHub API base for install-time commit resolution.')
    .default('https://api.github.com'),
  githubCodeloadBase: Schema.string()
    .description('Codeload base for install-time tarball downloads.')
    .default('https://codeload.github.com'),
  skillsDir: Schema.string()
    .description('Skills Directory root (default: $DSH_HOME/skills, or ~/.dsh/skills).')
    .default(defaultSkillsDir()),
  fetchConcurrency: Schema.natural()
    .description('Upper bound of concurrent Source fetches for descriptions.')
    .default(5),
  descriptionCacheMaxEntries: Schema.natural()
    .description('Upper bound of cached description outcomes (positive and negative).')
    .default(200),
  descriptionFetchTimeoutMs: Schema.natural()
    .description('Per-request Source fetch timeout for descriptions, in milliseconds.')
    .default(10_000),
  installFetchTimeoutMs: Schema.natural()
    .description('Per-request timeout for install-time API and tarball fetches, in milliseconds.')
    .default(30_000),
})

/** Plugin-unique route prefix (ADR-0006); every endpoint below hangs off it. */
export const ROUTE_PREFIX = '/skill-manager/api'

/** Abuse guard on the query string; generous for real keyword searches. */
const MAX_QUERY_LENGTH = 200

/** Abuse guard on JSON request bodies (install requests are tiny). */
const MAX_BODY_BYTES = 64 * 1024

/** InstallError code → HTTP status. */
const INSTALL_ERROR_STATUS: Record<InstallErrorCode, number> = {
  'invalid-input': 400,
  'skill-not-found': 404,
  'not-managed': 404,
  'source-invalid': 409,
  'unsafe-archive': 422,
  'upstream': 502,
  'fs': 500,
}

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

/** Read a JSON request body with a size cap; undefined when absent/invalid. */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config): void {
  const service = new SkillManager({
    ...config,
    fetcher: (url, init) => fetch(url, init),
    binaryFetcher: (url, init) => fetch(url, init),
  })
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname.replace(/\/+$/, '')
          try {
            if (path === `${ROUTE_PREFIX}/search`) {
              if (req.method !== 'GET') {
                json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
                return
              }
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
              if (req.method !== 'GET') {
                json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
                return
              }
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
            if (path === `${ROUTE_PREFIX}/list-installed`) {
              if (req.method !== 'GET') {
                json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
                return
              }
              const skills = await service.listInstalled()
              json(res, 200, { ok: true, data: { skills } })
              return
            }
            if (path === `${ROUTE_PREFIX}/install`) {
              if (req.method !== 'POST') {
                json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
                return
              }
              const body = await readJsonBody(req)
              const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
              if (typeof payload.source !== 'string' || typeof payload.skillId !== 'string') {
                json(res, 400, { ok: false, error: 'invalid JSON body: expected { source, skillId, confirm? }' })
                return
              }
              try {
                const result = await service.install({
                  source: payload.source,
                  skillId: payload.skillId,
                  confirm: payload.confirm === true,
                })
                json(res, 200, { ok: true, data: result })
              } catch (error) {
                if (error instanceof InstallError) {
                  // `code` rides along so the client maps its own localized
                  // copy (host messages stay English by convention).
                  json(res, INSTALL_ERROR_STATUS[error.code], { ok: false, code: error.code, error: error.message })
                  return
                }
                throw error
              }
              return
            }
            if (path === `${ROUTE_PREFIX}/check-updates`) {
              // POST, not GET: the check persists sourceInvalid flag updates.
              if (req.method !== 'POST') {
                json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
                return
              }
              const states = await service.checkUpdates()
              json(res, 200, { ok: true, data: { skills: states } })
              return
            }
            if (path === `${ROUTE_PREFIX}/update`) {
              if (req.method !== 'POST') {
                json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
                return
              }
              const body = await readJsonBody(req)
              const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
              if (typeof payload.skillId !== 'string') {
                json(res, 400, { ok: false, error: 'invalid JSON body: expected { skillId, confirm? }' })
                return
              }
              try {
                const result = await service.update({ skillId: payload.skillId, confirm: payload.confirm === true })
                json(res, 200, { ok: true, data: result })
              } catch (error) {
                if (error instanceof InstallError) {
                  // `code` rides along so the client maps its own localized
                  // copy (host messages stay English by convention).
                  json(res, INSTALL_ERROR_STATUS[error.code], { ok: false, code: error.code, error: error.message })
                  return
                }
                throw error
              }
              return
            }
            if (path === `${ROUTE_PREFIX}/uninstall`) {
              if (req.method !== 'POST') {
                json(res, 405, { ok: false, error: `method not allowed: ${req.method}` })
                return
              }
              const body = await readJsonBody(req)
              const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
              if (typeof payload.skillId !== 'string') {
                json(res, 400, { ok: false, error: 'invalid JSON body: expected { skillId, confirm? }' })
                return
              }
              try {
                const result = await service.uninstall({ skillId: payload.skillId, confirm: payload.confirm === true })
                json(res, 200, { ok: true, data: result })
              } catch (error) {
                if (error instanceof InstallError) {
                  json(res, INSTALL_ERROR_STATUS[error.code], { ok: false, code: error.code, error: error.message })
                  return
                }
                throw error
              }
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
