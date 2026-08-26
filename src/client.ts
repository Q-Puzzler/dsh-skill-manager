/**
 * Client half of the plugin. The build wraps this module's CJS form into the
 * loader's lazy-CJS factory format (`window.__ModuleLoader__.load({ id, factory })`),
 * so this source stays a plain module; runtime services arrive via the plugin
 * context, cross-package imports stay type-only (bundle-purity gate).
 */

/** No-op for the scaffold; the settings section registration lands in a later ticket. */
export function apply(): void {}

/** Client-side cordis services the plugin declares; none yet. */
export const inject: string[] = []
