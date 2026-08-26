/**
 * Client half of the plugin: the Catalog search settings section. A thin
 * shell (ADR-0005) — it renders state and forwards intent to the host HTTP
 * endpoints with ordinary relative fetch; all logic lives host-side.
 *
 * Registered as a full settings section into the `settings.section` slot
 * (ctx.slots.inject + ctx.slots.register with id/order/label/icon), the same
 * seam the built-in settings pages and the community skill-manager plugin
 * use. The build wraps this module into the loader's lazy-CJS factory format
 * (see tsdown.config.ts); cross-package imports stay type-only (bundle-purity
 * gate), react arrives through the module-graph baseline (peerDependency).
 */
import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace; the settings.section registration binds it via `locale`. */
const NS = 'skill-manager'

type DictKey =
  | 'title'
  | 'desc'
  | 'search.placeholder'
  | 'search.button'
  | 'search.busy'
  | 'state.initial'
  | 'state.empty'
  | 'state.error'
  | 'state.retry'
  | 'result.source'
  | 'result.installs'
  | 'result.page'
  | 'description.empty'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: DictKey
  }
}

/** Default copy is Chinese; English mirrors every key (bilingual balance). */
const DICT: Record<'zh' | 'en', Record<DictKey, string>> = {
  zh: {
    'title': '技能管理',
    'desc': '从 skills.sh Catalog 搜索、浏览技能。',
    'search.placeholder': '输入关键词，如 pdf、frontend',
    'search.button': '搜索',
    'search.busy': '搜索中…',
    'state.initial': '输入关键词，从 skills.sh Catalog 搜索技能。',
    'state.empty': '没有找到与“{keyword}”匹配的技能。',
    'state.error': '搜索失败：{message}',
    'state.retry': '重试',
    'result.source': '来源',
    'result.installs': '{count} 次安装',
    'result.page': 'Catalog 页面',
    'description.empty': '暂无简介',
  },
  en: {
    'title': 'Skill Manager',
    'desc': 'Search and browse skills from the skills.sh Catalog.',
    'search.placeholder': 'Keyword, e.g. pdf, frontend',
    'search.button': 'Search',
    'search.busy': 'Searching…',
    'state.initial': 'Enter a keyword to search the skills.sh Catalog.',
    'state.empty': 'No skills matched “{keyword}”.',
    'state.error': 'Search failed: {message}',
    'state.retry': 'Retry',
    'result.source': 'Source',
    'result.installs': '{count} installs',
    'result.page': 'Catalog page',
    'description.empty': 'No description available',
  },
}

/** Host route prefix — must equal ROUTE_PREFIX in index.ts (bundles stay independent). */
const API_BASE = '/skill-manager/api'

/** One Catalog search result item, as mapped by the host search endpoint. */
interface SearchItem {
  name: string
  skillId: string
  source: string
  installs: number
  pageUrl: string
}

/** Search area state machine: the four states stay visually distinct. */
type SearchState =
  | { phase: 'idle' }
  | { phase: 'loading'; keyword: string }
  | { phase: 'success'; keyword: string; skills: SearchItem[] }
  | { phase: 'error'; keyword: string; message: string }

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
}

async function callApi<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`)
  const body = (await response.json().catch(() => undefined)) as ApiEnvelope<T> | undefined
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    throw new Error(body?.error ?? `HTTP ${response.status}`)
  }
  return body.data
}

/** Section styling rides dsh theme variables; scoped under the skm- prefix. */
const CSS = `
.skm-section{box-sizing:border-box;display:flex;min-width:0;max-width:760px;width:100%;margin:0 auto;flex-direction:column;gap:16px;padding:0 0 32px;color:var(--dsw-alias-label-primary)}
.skm-title{margin:0;font-size:18px;font-weight:600}
.skm-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px}
.skm-search{display:flex;gap:8px}
.skm-input{flex:1;min-width:0;padding:6px 10px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none}
.skm-input:focus{border-color:var(--dsw-alias-button-primary-fill)}
.skm-btn{padding:6px 16px;font-size:13px;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border:none;border-radius:6px;cursor:pointer}
.skm-btn:disabled{opacity:.5;cursor:default}
.skm-note{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.skm-error{margin:0;font-size:13px;color:var(--dsw-alias-state-error-primary)}
.skm-results{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}
.skm-result{display:flex;flex-direction:column;gap:4px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.skm-name{margin:0;font-size:14px;font-weight:600}
.skm-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.skm-link{color:var(--dsw-alias-button-primary-fill);text-decoration:none}
.skm-link:hover{text-decoration:underline}
`

/** Lazily loaded Description line of one result; failure stays silent. */
function DescriptionLine(props: { source: string; skillId: string; placeholder: string }): ReactNode {
  const [description, setDescription] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    callApi<{ description: string | null }>(
      `/fetch-description?source=${encodeURIComponent(props.source)}&skillId=${encodeURIComponent(props.skillId)}`,
    )
      .then((data) => {
        if (!cancelled) setDescription(data.description)
      })
      .catch(() => {
        /* description failure is not an error state — the placeholder stays */
      })
    return () => {
      cancelled = true
    }
  }, [props.source, props.skillId])
  return h('p', { className: 'skm-desc' }, description ?? props.placeholder)
}

function SearchResultItem(props: { item: SearchItem; t: TranslateNS<typeof NS> }): ReactNode {
  const { item, t } = props
  return h(
    'li',
    { className: 'skm-result' },
    h('h3', { className: 'skm-name' }, item.name),
    h(DescriptionLine, { source: item.source, skillId: item.skillId, placeholder: t('description.empty') }),
    h(
      'div',
      { className: 'skm-meta' },
      h('span', null, `${t('result.source')}: ${item.source}`),
      h('span', null, t('result.installs', { count: item.installs })),
      h('a', { className: 'skm-link', href: item.pageUrl, target: '_blank', rel: 'noreferrer' }, t('result.page')),
    ),
  )
}

function SkillManagerSection(props: { t: TranslateNS<typeof NS> }): ReactNode {
  const t = props.t
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>({ phase: 'idle' })
  const inflightRef = useRef(false)

  async function runSearch(keyword: string): Promise<void> {
    const trimmed = keyword.trim()
    if (trimmed === '' || inflightRef.current) return
    inflightRef.current = true
    setState({ phase: 'loading', keyword: trimmed })
    try {
      const data = await callApi<{ skills: SearchItem[] }>(`/search?q=${encodeURIComponent(trimmed)}`)
      setState({ phase: 'success', keyword: trimmed, skills: data.skills })
    } catch (error) {
      setState({
        phase: 'error',
        keyword: trimmed,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      inflightRef.current = false
    }
  }

  const loading = state.phase === 'loading'
  const nodes: ReactNode[] = [
    h('style', { key: 'css' }, CSS),
    h('h2', { key: 'title', className: 'skm-title' }, t('title')),
    h('p', { key: 'desc', className: 'skm-desc' }, t('desc')),
    h(
      'form',
      {
        key: 'search',
        className: 'skm-search',
        onSubmit: (event: { preventDefault(): void }) => {
          event.preventDefault()
          void runSearch(query)
        },
      },
      h('input', {
        className: 'skm-input',
        type: 'search',
        value: query,
        placeholder: t('search.placeholder'),
        disabled: loading,
        onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
      }),
      h('button', { className: 'skm-btn', type: 'submit', disabled: loading }, loading ? t('search.busy') : t('search.button')),
    ),
  ]
  if (state.phase === 'idle') {
    nodes.push(h('p', { key: 'state', className: 'skm-note', role: 'status' }, t('state.initial')))
  } else if (state.phase === 'loading') {
    nodes.push(h('p', { key: 'state', className: 'skm-note', role: 'status' }, t('search.busy')))
  } else if (state.phase === 'error') {
    nodes.push(
      h(
        'div',
        { key: 'state', className: 'skm-search' },
        h('p', { className: 'skm-error', role: 'alert' }, t('state.error', { message: state.message })),
        h('button', { className: 'skm-btn', type: 'button', onClick: () => void runSearch(state.keyword) }, t('state.retry')),
      ),
    )
  } else if (state.skills.length === 0) {
    nodes.push(h('p', { key: 'state', className: 'skm-note', role: 'status' }, t('state.empty', { keyword: state.keyword })))
  } else {
    nodes.push(
      h(
        'ul',
        { key: 'state', className: 'skm-results' },
        state.skills.map((item) => h(SearchResultItem, { key: item.pageUrl, item, t })),
      ),
    )
  }
  return h('section', { className: 'skm-section' }, nodes)
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, DICT), 'skill-manager: dictionaries')
  // `icon` rides along for community-pattern parity: the slot core stores
  // extra options harmlessly (the 0.1.1-rc.2 shell projects id/order/label
  // only). `as const` keeps the literal types the register overloads expect.
  const entry = {
    name: 'settings.section',
    id: 'skill-manager',
    order: 20,
    label: () => ctx.locale.bind(NS)('title'),
    icon: 'skill',
    locale: NS,
  } as const
  ctx.slots.inject('settings.section', () => ctx.slots.register(entry, SkillManagerSection))
}

/** Client-side cordis services the plugin declares. */
export const inject: string[] = ['slots', 'locale']
