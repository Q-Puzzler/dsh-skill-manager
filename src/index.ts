import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Plugin name, matching the loader entry id in cordis.patch.yml. */
export const name = 'skill-manager'

/** Host services required before activation; the scaffold needs none. */
export const inject: string[] = []

export interface Config {
  /** Catalog base URL — the sole online data source for searching and linking Skills. */
  catalogUrl: string
}

export const Config = Schema.object({
  catalogUrl: Schema.string()
    .description('Catalog base URL — the sole online data source for searching and linking Skills.')
    .default('https://www.skills.sh'),
})

export function apply(ctx: Context): void {
  ctx.effect(() => {
    ctx.logger(name).info('host plugin loaded (scaffold, no features yet)')
    return () => {}
  })
}
