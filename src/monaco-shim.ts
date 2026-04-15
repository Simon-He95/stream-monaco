// Small shim to centralize the monaco import. Tests can mock this file to
// avoid resolving the real 'monaco-editor' package during vitest runs.
//
// IMPORTANT:
// Use the ESM `editor.api` entrypoint so Monaco's language contributions under
// `monaco-editor/esm/vs/**` register against the same singleton instance.
// In legacy bundlers (Webpack 4), mixing `import 'monaco-editor'` with
// `import 'monaco-editor/esm/vs/...'` can create duplicate module instances,
// causing tokenizers/providers to register on the "other" instance (no colors).
import * as _monaco from 'monaco-editor/esm/vs/editor/editor.api'

// re-export the original module but also provide a `monaco` namespace default
// so existing imports like `import * as monaco from '.../monaco-shim'` keep
// the `monaco.editor` typing available.
const monaco: typeof _monaco = _monaco as any

export const ScrollType
  = Reflect.get(_monaco as object, 'ScrollType') ?? (_monaco as any).editor?.ScrollType
export { monaco as default }
export * from 'monaco-editor/esm/vs/editor/editor.api'
