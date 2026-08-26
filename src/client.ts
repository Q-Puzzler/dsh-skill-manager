/**
 * Client half of the plugin: the Catalog search settings section plus the
 * installed-skills section below it. A thin shell (ADR-0005) — it renders
 * state and forwards intent to the host HTTP endpoints with ordinary relative
 * fetch; all logic lives host-side.
 *
 * Per-result install buttons (安装 / 安装中 / 已安装→重装 / 失败重试) drive
 * the two-phase Confirmation protocol (ADR-0004): a confirmation-required
 * response opens the shared ConfirmModal, whose 确认 re-calls with
 * `confirm: true`. The 已安装 state comes from the host's list-installed.
 *
 * The installed section lists every Managed Skill (name, Source, installedAt)
 * with per-item 更新/卸载 buttons and one global 检查更新 button (in-flight
 * guarded). check-updates paints the Update Available / Source Invalid
 * badges; Source Invalid disables 更新 but keeps 卸载. Updates and uninstalls
 * ride the same ConfirmModal — the update prompt shows the local-modification
 * warning when the host's confirmation-required response carries one.
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
import type { RegistryRecord } from './registry'
import type { InstallResult, SearchItem, SkillUpdateState, UninstallResult, UpdateResult } from './service'

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
  | 'install.button'
  | 'install.busy'
  | 'install.installed'
  | 'install.retry'
  | 'install.failed'
  | 'install.error.skill-not-found'
  | 'installed.title'
  | 'installed.empty'
  | 'installed.loading'
  | 'installed.error'
  | 'installed.installedAt'
  | 'installed.badge.update'
  | 'installed.badge.invalid'
  | 'check.button'
  | 'check.busy'
  | 'check.failed'
  | 'update.button'
  | 'update.busy'
  | 'update.failed'
  | 'uninstall.button'
  | 'uninstall.busy'
  | 'uninstall.failed'
  | 'error.not-managed'
  | 'error.source-invalid'
  | 'confirm.title'
  | 'confirm.skill'
  | 'confirm.source'
  | 'confirm.target'
  | 'confirm.action'
  | 'confirm.action.reinstall'
  | 'confirm.action.overwrite'
  | 'confirm.action.update'
  | 'confirm.action.uninstall'
  | 'confirm.warning.localModified'
  | 'confirm.ok'
  | 'confirm.cancel'
  | 'confirm.busy'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: DictKey
  }
}

/** Default copy is Chinese; English mirrors every key (bilingual balance). */
const DICT: Record<'zh' | 'en', Record<DictKey, string>> = {
  zh: {
    'title': '技能管理',
    'desc': '从 skills.sh Catalog 搜索、安装、更新、卸载技能。',
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
    'install.button': '安装',
    'install.busy': '安装中…',
    'install.installed': '已安装',
    'install.retry': '重试',
    'install.failed': '安装失败：{message}',
    'install.error.skill-not-found': '该 Source 中不存在此技能',
    'installed.title': '已安装技能',
    'installed.empty': '尚未安装任何技能。',
    'installed.loading': '加载中…',
    'installed.error': '加载已安装列表失败：{message}',
    'installed.installedAt': '安装时间',
    'installed.badge.update': '有更新',
    'installed.badge.invalid': 'Source 失效',
    'check.button': '检查更新',
    'check.busy': '检查中…',
    'check.failed': '检查更新失败：{message}',
    'update.button': '更新',
    'update.busy': '更新中…',
    'update.failed': '更新失败：{message}',
    'uninstall.button': '卸载',
    'uninstall.busy': '卸载中…',
    'uninstall.failed': '卸载失败：{message}',
    'error.not-managed': '该技能不受本插件管理，操作已拒绝。',
    'error.source-invalid': 'Source 已失效，无法更新；仍可卸载。',
    'confirm.title': '确认{action}',
    'confirm.skill': '技能',
    'confirm.source': '来源',
    'confirm.target': '目标路径',
    'confirm.action': '动作',
    'confirm.action.reinstall': '重装',
    'confirm.action.overwrite': '覆盖安装',
    'confirm.action.update': '更新',
    'confirm.action.uninstall': '卸载',
    'confirm.warning.localModified': '检测到本地修改：更新将覆盖你对该技能所做的修改。',
    'confirm.ok': '确认',
    'confirm.cancel': '取消',
    'confirm.busy': '处理中…',
  },
  en: {
    'title': 'Skill Manager',
    'desc': 'Search, install, update, and uninstall skills from the skills.sh Catalog.',
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
    'install.button': 'Install',
    'install.busy': 'Installing…',
    'install.installed': 'Installed',
    'install.retry': 'Retry',
    'install.failed': 'Install failed: {message}',
    'install.error.skill-not-found': 'The Source does not contain this skill',
    'installed.title': 'Installed skills',
    'installed.empty': 'No skills installed yet.',
    'installed.loading': 'Loading…',
    'installed.error': 'Failed to load installed skills: {message}',
    'installed.installedAt': 'Installed',
    'installed.badge.update': 'Update available',
    'installed.badge.invalid': 'Source invalid',
    'check.button': 'Check for updates',
    'check.busy': 'Checking…',
    'check.failed': 'Update check failed: {message}',
    'update.button': 'Update',
    'update.busy': 'Updating…',
    'update.failed': 'Update failed: {message}',
    'uninstall.button': 'Uninstall',
    'uninstall.busy': 'Uninstalling…',
    'uninstall.failed': 'Uninstall failed: {message}',
    'error.not-managed': 'This skill is not managed by the plugin; the operation was refused.',
    'error.source-invalid': 'The Source is invalid; update is unavailable. Uninstall remains possible.',
    'confirm.title': 'Confirm {action}',
    'confirm.skill': 'Skill',
    'confirm.source': 'Source',
    'confirm.target': 'Target path',
    'confirm.action': 'Action',
    'confirm.action.reinstall': 'reinstall',
    'confirm.action.overwrite': 'overwrite install',
    'confirm.action.update': 'update',
    'confirm.action.uninstall': 'uninstall',
    'confirm.warning.localModified': 'Local modifications detected: updating will overwrite your changes to this skill.',
    'confirm.ok': 'Confirm',
    'confirm.cancel': 'Cancel',
    'confirm.busy': 'Working…',
  },
}

/** Host route prefix — must equal ROUTE_PREFIX in index.ts (bundles stay independent). */
const API_BASE = '/skill-manager/api'

/** Search area state machine: the four states stay visually distinct. */
type SearchState =
  | { phase: 'idle' }
  | { phase: 'loading'; keyword: string }
  | { phase: 'success'; keyword: string; skills: SearchItem[] }
  | { phase: 'error'; keyword: string; message: string }

/** Installed section state: list-installed has its own error surface (with retry). */
type InstalledState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; records: RegistryRecord[] }

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
  /** Host machine-readable error category (InstallError code), when present. */
  code?: string
}

/** Host API failure; `code` lets the UI localize known categories via the DICT. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function callApi<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }
      : {}),
  })
  const body = (await response.json().catch(() => undefined)) as ApiEnvelope<T> | undefined
  if (!response.ok || body?.ok !== true || body.data === undefined) {
    throw new ApiError(body?.error ?? `HTTP ${response.status}`, body?.code)
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
.skm-actions{display:flex;align-items:center;gap:8px;margin-top:4px}
.skm-btn-secondary{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.skm-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
.skm-modal{display:flex;flex-direction:column;gap:12px;width:min(480px,90vw);padding:20px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.skm-modal-title{margin:0;font-size:15px;font-weight:600}
.skm-modal-rows{display:flex;flex-direction:column;gap:6px;font-size:13px}
.skm-modal-row{display:flex;gap:8px}
.skm-modal-key{flex:none;min-width:64px;color:var(--dsw-alias-label-tertiary)}
.skm-modal-value{overflow-wrap:anywhere}
.skm-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.skm-subtitle{margin:8px 0 0;font-size:15px;font-weight:600}
.skm-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.skm-badge{display:inline-flex;align-items:center;padding:1px 8px;font-size:11px;border-radius:999px;border:1px solid}
.skm-badge-update{color:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.skm-badge-invalid{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.skm-warning{margin:0;font-size:13px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary))}
`

/**
 * Pending Confirmation modal state (ADR-0004): what the host's
 * confirmation-required response described, plus the re-call closure.
 * The component is shared by install (reinstall/overwrite), update, and
 * uninstall prompts.
 */
interface ConfirmPromptState {
  skillName: string
  skillId: string
  source: string
  targetPath: string
  action: 'reinstall' | 'overwrite' | 'update' | 'uninstall'
  /** Local-modification overwrite warning (update only), already localized. */
  warning?: string
  busy: boolean
  proceed: () => Promise<void>
}

/** Confirmation modal: skill, Source, target path, action, 确认/取消. */
function ConfirmModal(props: {
  prompt: ConfirmPromptState
  t: TranslateNS<typeof NS>
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  const { prompt, t } = props
  const actionKeys: Record<ConfirmPromptState['action'], DictKey> = {
    reinstall: 'confirm.action.reinstall',
    overwrite: 'confirm.action.overwrite',
    update: 'confirm.action.update',
    uninstall: 'confirm.action.uninstall',
  }
  const actionLabel = t(actionKeys[prompt.action])
  const rows: Array<[DictKey, string]> = [
    ['confirm.skill', prompt.skillName],
    ['confirm.source', prompt.source],
    ['confirm.target', prompt.targetPath],
    ['confirm.action', actionLabel],
  ]
  return h(
    'div',
    { className: 'skm-overlay', role: 'presentation' },
    h(
      'div',
      { className: 'skm-modal', role: 'dialog', 'aria-modal': 'true' },
      h('h3', { className: 'skm-modal-title' }, t('confirm.title', { action: actionLabel })),
      h(
        'div',
        { className: 'skm-modal-rows' },
        rows.map(([key, value]) =>
          h(
            'div',
            { key, className: 'skm-modal-row' },
            h('span', { className: 'skm-modal-key' }, t(key)),
            h('span', { className: 'skm-modal-value' }, value),
          ),
        ),
      ),
      prompt.warning !== undefined ? h('p', { className: 'skm-warning', role: 'alert' }, prompt.warning) : null,
      h(
        'div',
        { className: 'skm-modal-actions' },
        h(
          'button',
          { className: 'skm-btn skm-btn-secondary', type: 'button', disabled: prompt.busy, onClick: props.onCancel },
          t('confirm.cancel'),
        ),
        h(
          'button',
          { className: 'skm-btn', type: 'button', disabled: prompt.busy, onClick: props.onConfirm },
          prompt.busy ? t('confirm.busy') : t('confirm.ok'),
        ),
      ),
    ),
  )
}

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

type InstallPhase = { phase: 'idle' } | { phase: 'busy' } | { phase: 'error'; message: string }

function SearchResultItem(props: {
  item: SearchItem
  installed: boolean
  t: TranslateNS<typeof NS>
  onInstalled: () => void
  onConfirm: (prompt: Omit<ConfirmPromptState, 'busy'>) => void
}): ReactNode {
  const { item, installed, t } = props
  const [install, setInstall] = useState<InstallPhase>({ phase: 'idle' })

  /**
   * Two-phase flow: call install → on confirmation-required hand the prompt
   * to the section-level modal → its 确认 re-calls with confirm: true. The
   * host enforces the protocol; this button only reflects it.
   */
  async function doInstall(confirm: boolean): Promise<void> {
    setInstall({ phase: 'busy' })
    try {
      const result = await callApi<InstallResult>('/install', {
        method: 'POST',
        body: { source: item.source, skillId: item.skillId, ...(confirm ? { confirm: true } : {}) },
      })
      if (result.status === 'confirmation-required') {
        setInstall({ phase: 'idle' })
        props.onConfirm({
          skillName: item.name,
          skillId: result.skillId,
          source: result.source,
          targetPath: result.targetPath,
          action: result.action,
          proceed: () => doInstall(true),
        })
        return
      }
      setInstall({ phase: 'idle' })
      props.onInstalled()
    } catch (error) {
      // Host messages are English; known error codes get localized DICT copy
      // instead of surfacing the raw host message.
      const message =
        error instanceof ApiError && error.code === 'skill-not-found'
          ? t('install.error.skill-not-found')
          : error instanceof Error
            ? error.message
            : String(error)
      setInstall({ phase: 'error', message })
    }
  }

  const busy = install.phase === 'busy'
  const actionNode =
    install.phase === 'error'
      ? h(
          'div',
          { className: 'skm-actions' },
          h('p', { className: 'skm-error', role: 'alert' }, t('install.failed', { message: install.message })),
          h('button', { className: 'skm-btn', type: 'button', onClick: () => void doInstall(false) }, t('install.retry')),
        )
      : h(
          'div',
          { className: 'skm-actions' },
          h(
            'button',
            {
              className: installed ? 'skm-btn skm-btn-secondary' : 'skm-btn',
              type: 'button',
              disabled: busy,
              onClick: () => void doInstall(false),
            },
            busy ? t('install.busy') : installed ? t('install.installed') : t('install.button'),
          ),
        )
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
    actionNode,
  )
}

/** Display an ISO timestamp in the user's locale; malformed values pass through. */
function formatInstalledAt(iso: string): string {
  const time = new Date(iso)
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString()
}

type ItemOpPhase =
  | { phase: 'idle' }
  | { phase: 'busy'; op: 'update' | 'uninstall' }
  | { phase: 'error'; op: 'update' | 'uninstall'; message: string }

/** One Managed Skill row: name, Source, installedAt, badges, 更新/卸载. */
function InstalledSkillItem(props: {
  record: RegistryRecord
  updateState?: SkillUpdateState
  t: TranslateNS<typeof NS>
  onChanged: () => void
  onConfirm: (prompt: Omit<ConfirmPromptState, 'busy'>) => void
}): ReactNode {
  const { record, updateState, t } = props
  const [op, setOp] = useState<ItemOpPhase>({ phase: 'idle' })
  // The fresh check outcome wins over the record's persisted flag.
  const sourceInvalid = updateState?.sourceInvalid ?? record.sourceInvalid === true
  const updateAvailable = updateState?.updateAvailable === true && !sourceInvalid

  /** Known host error codes map to localized DICT copy; anything else shows the raw message. */
  function localize(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.code === 'not-managed') return t('error.not-managed')
      if (error.code === 'source-invalid') return t('error.source-invalid')
      if (error.code === 'skill-not-found') return t('install.error.skill-not-found')
    }
    return error instanceof Error ? error.message : String(error)
  }

  /** Two-phase update: confirmation-required opens the modal (with the local-modification warning when the host carries one). */
  async function doUpdate(confirm: boolean): Promise<void> {
    setOp({ phase: 'busy', op: 'update' })
    try {
      const result = await callApi<UpdateResult>('/update', {
        method: 'POST',
        body: { skillId: record.skillId, ...(confirm ? { confirm: true } : {}) },
      })
      if (result.status === 'confirmation-required') {
        setOp({ phase: 'idle' })
        props.onConfirm({
          skillName: record.skillId,
          skillId: result.skillId,
          source: result.source,
          targetPath: result.targetPath,
          action: 'update',
          ...(result.localModified === true ? { warning: t('confirm.warning.localModified') } : {}),
          proceed: () => doUpdate(true),
        })
        return
      }
      setOp({ phase: 'idle' })
      props.onChanged()
    } catch (error) {
      setOp({ phase: 'error', op: 'update', message: localize(error) })
    }
  }

  /** Two-phase uninstall: confirmation-required opens the modal (skill, Source, target path, action). */
  async function doUninstall(confirm: boolean): Promise<void> {
    setOp({ phase: 'busy', op: 'uninstall' })
    try {
      const result = await callApi<UninstallResult>('/uninstall', {
        method: 'POST',
        body: { skillId: record.skillId, ...(confirm ? { confirm: true } : {}) },
      })
      if (result.status === 'confirmation-required') {
        setOp({ phase: 'idle' })
        props.onConfirm({
          skillName: record.skillId,
          skillId: result.skillId,
          source: result.source,
          targetPath: result.targetPath,
          action: 'uninstall',
          proceed: () => doUninstall(true),
        })
        return
      }
      setOp({ phase: 'idle' })
      props.onChanged()
    } catch (error) {
      setOp({ phase: 'error', op: 'uninstall', message: localize(error) })
    }
  }

  const busy = op.phase === 'busy'
  const actionNode =
    op.phase === 'error'
      ? h(
          'div',
          { className: 'skm-actions' },
          h(
            'p',
            { className: 'skm-error', role: 'alert' },
            t(op.op === 'update' ? 'update.failed' : 'uninstall.failed', { message: op.message }),
          ),
          h(
            'button',
            {
              className: 'skm-btn',
              type: 'button',
              onClick: () => void (op.op === 'update' ? doUpdate(false) : doUninstall(false)),
            },
            t('state.retry'),
          ),
        )
      : h(
          'div',
          { className: 'skm-actions' },
          h(
            'button',
            {
              className: 'skm-btn',
              type: 'button',
              disabled: busy || sourceInvalid,
              onClick: () => void doUpdate(false),
            },
            busy && op.op === 'update' ? t('update.busy') : t('update.button'),
          ),
          h(
            'button',
            { className: 'skm-btn skm-btn-secondary', type: 'button', disabled: busy, onClick: () => void doUninstall(false) },
            busy && op.op === 'uninstall' ? t('uninstall.busy') : t('uninstall.button'),
          ),
        )
  return h(
    'li',
    { className: 'skm-result' },
    h(
      'div',
      { className: 'skm-item-head' },
      h('h3', { className: 'skm-name' }, record.skillId),
      updateAvailable ? h('span', { className: 'skm-badge skm-badge-update' }, t('installed.badge.update')) : null,
      sourceInvalid ? h('span', { className: 'skm-badge skm-badge-invalid' }, t('installed.badge.invalid')) : null,
    ),
    h(
      'div',
      { className: 'skm-meta' },
      h('span', null, `${t('result.source')}: ${record.source}`),
      h('span', null, `${t('installed.installedAt')}: ${formatInstalledAt(record.installedAt)}`),
    ),
    updateState?.error !== undefined
      ? h('p', { className: 'skm-error', role: 'alert' }, t('check.failed', { message: updateState.error }))
      : null,
    actionNode,
  )
}

function SkillManagerSection(props: { t: TranslateNS<typeof NS> }): ReactNode {
  const t = props.t
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>({ phase: 'idle' })
  const [installed, setInstalled] = useState<InstalledState>({ phase: 'loading' })
  /** Latest check-updates outcome per skillId (empty until the first check). */
  const [updateStates, setUpdateStates] = useState<Readonly<Record<string, SkillUpdateState>>>({})
  const [checkBusy, setCheckBusy] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<ConfirmPromptState | null>(null)
  const inflightRef = useRef(false)

  /** Refresh the Managed records driving both the installed section and the search results' 已安装 state. */
  async function refreshInstalled(): Promise<void> {
    try {
      const data = await callApi<{ skills: RegistryRecord[] }>('/list-installed')
      setInstalled({ phase: 'ready', records: data.skills })
    } catch (error) {
      // The installed section surfaces the failure (with retry); the search
      // results degrade to plain install buttons — no ready records to match.
      setInstalled({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
  useEffect(() => {
    void refreshInstalled()
  }, [])

  async function runSearch(keyword: string): Promise<void> {
    const trimmed = keyword.trim()
    if (trimmed === '' || inflightRef.current) return
    inflightRef.current = true
    setPrompt(null)
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

  /** Global update check (in-flight guarded): merge per-skill outcomes, then re-read the records — the host persists sourceInvalid flips. */
  async function runCheckUpdates(): Promise<void> {
    if (checkBusy) return
    setCheckBusy(true)
    setCheckError(null)
    try {
      const data = await callApi<{ skills: SkillUpdateState[] }>('/check-updates', { method: 'POST' })
      const next: Record<string, SkillUpdateState> = {}
      for (const skill of data.skills) next[skill.skillId] = skill
      setUpdateStates(next)
      await refreshInstalled()
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error))
    } finally {
      setCheckBusy(false)
    }
  }

  /** An installed item finished an update/uninstall: drop its stale check state and re-read the records. */
  function handleItemChanged(skillId: string): void {
    setUpdateStates((previous) => {
      if (!(skillId in previous)) return previous
      const next = { ...previous }
      delete next[skillId]
      return next
    })
    void refreshInstalled()
  }

  async function confirmPrompt(): Promise<void> {
    if (prompt === null || prompt.busy) return
    setPrompt({ ...prompt, busy: true })
    try {
      await prompt.proceed()
    } finally {
      // proceed() captures its item's doInstall, which handles and displays
      // its own errors — the modal closes either way.
      setPrompt(null)
    }
  }

  const loading = state.phase === 'loading'
  const installedSet = installed.phase === 'ready' ? new Set(installed.records.map((record) => record.skillId)) : null
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
        state.skills.map((item) =>
          h(SearchResultItem, {
            key: item.pageUrl,
            item,
            installed: installedSet?.has(item.skillId) ?? false,
            t,
            onInstalled: () => void refreshInstalled(),
            onConfirm: (next) => setPrompt({ ...next, busy: false }),
          }),
        ),
      ),
    )
  }
  nodes.push(h('h2', { key: 'installed-title', className: 'skm-subtitle' }, t('installed.title')))
  if (installed.phase === 'loading') {
    nodes.push(h('p', { key: 'installed-state', className: 'skm-note', role: 'status' }, t('installed.loading')))
  } else if (installed.phase === 'error') {
    nodes.push(
      h(
        'div',
        { key: 'installed-state', className: 'skm-actions' },
        h('p', { className: 'skm-error', role: 'alert' }, t('installed.error', { message: installed.message })),
        h('button', { className: 'skm-btn', type: 'button', onClick: () => void refreshInstalled() }, t('state.retry')),
      ),
    )
  } else {
    nodes.push(
      h(
        'div',
        { key: 'installed-check', className: 'skm-actions' },
        h(
          'button',
          { className: 'skm-btn skm-btn-secondary', type: 'button', disabled: checkBusy, onClick: () => void runCheckUpdates() },
          checkBusy ? t('check.busy') : t('check.button'),
        ),
        checkError !== null
          ? h('p', { className: 'skm-error', role: 'alert' }, t('check.failed', { message: checkError }))
          : null,
      ),
    )
    if (installed.records.length === 0) {
      nodes.push(h('p', { key: 'installed-list', className: 'skm-note', role: 'status' }, t('installed.empty')))
    } else {
      nodes.push(
        h(
          'ul',
          { key: 'installed-list', className: 'skm-results' },
          installed.records.map((record) =>
            h(InstalledSkillItem, {
              key: record.skillId,
              record,
              updateState: updateStates[record.skillId],
              t,
              onChanged: () => handleItemChanged(record.skillId),
              onConfirm: (next) => setPrompt({ ...next, busy: false }),
            }),
          ),
        ),
      )
    }
  }
  if (prompt !== null) {
    nodes.push(
      h(ConfirmModal, {
        key: 'confirm',
        prompt,
        t,
        onConfirm: () => void confirmPrompt(),
        onCancel: () => {
          if (!prompt.busy) setPrompt(null)
        },
      }),
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
  // Lifecycle: no explicit ctx.effect is needed around the slot registration —
  // the framework manages it per fiber. SlotRegistry.register is documented as
  // "disposal through the caller's ctx.effect (fiber unload = cascade)" and
  // slots.inject as "The controller belongs to the caller's fiber, so plugin
  // unload cancels a pending wait and removes any active contribution"
  // (@deepseek-ai/dsh-client-runtime 0.1.1-rc.2, lib/types/client/slots.d.ts):
  // reloading or unloading this plugin unregisters the settings section.
  ctx.slots.inject('settings.section', () => ctx.slots.register(entry, SkillManagerSection))
}

/** Client-side cordis services the plugin declares. */
export const inject: string[] = ['slots', 'locale']
