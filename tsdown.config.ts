import { defineConfig } from 'tsdown'

const CLIENT_MODULE_ID = '@q-puzzler/dsh-skill-manager'

/**
 * The dsh client loader consumes the "lazy-CJS" format: executing the bundle
 * only registers a factory via `window.__ModuleLoader__.load({ id, factory })`;
 * the module body runs inside `factory(require)` on first import. The build
 * reproduces that format by wrapping the CJS output of src/client.ts — the
 * banner provides the `module`/`exports` pair the CJS body assigns to, and the
 * footer returns them to the loader. Cross-package value imports stay external
 * (the factory's `require` resolves them against the module graph at runtime).
 */
const clientBanner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_MODULE_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`

const clientFooter = `    return module.exports;
  },
});
`

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    sourcemap: false,
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    outExtensions: () => ({ js: '.js' }),
    banner: clientBanner,
    footer: clientFooter,
  },
])
