export * from './index.base'
export { ensureMonacoWorkersLegacy } from './ensureMonacoWorkers.legacy'
export { preloadMonacoWorkers } from './preloadMonacoWorkers.legacy'

import { ensureMonacoWorkersLegacy } from './ensureMonacoWorkers.legacy'
import { processedLanguage } from './code.detect'
import * as monaco from './monaco-shim'

// Force Monaco's built-in tokenizers to be registered in legacy (Webpack 4)
// builds. Without these contributions, Monaco falls back to a single default
// token type (no colors) when Shiki providers fail to install.
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution'
import 'monaco-editor/esm/vs/language/json/monaco.contribution'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'
import 'monaco-editor/esm/vs/language/html/monaco.contribution'
import 'monaco-editor/esm/vs/language/css/monaco.contribution'
import { ISuggestMemoryService } from 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestMemory'
import { IOutlineModelService } from 'monaco-editor/esm/vs/editor/contrib/documentSymbols/browser/outlineModel'

// Eagerly register Monarch tokenizers as a robust fallback. The basic-languages
// contributions use lazy dynamic imports which can fail in some legacy bundler
// setups (Webpack 4), resulting in a single default token type (no colors).
import { conf as jsConf, language as jsLanguage } from 'monaco-editor/esm/vs/basic-languages/javascript/javascript'
import { conf as tsConf, language as tsLanguage } from 'monaco-editor/esm/vs/basic-languages/typescript/typescript'
import { conf as pyConf, language as pyLanguage } from 'monaco-editor/esm/vs/basic-languages/python/python'
import { conf as cppConf, language as cppLanguage } from 'monaco-editor/esm/vs/basic-languages/cpp/cpp'
import { conf as shConf, language as shLanguage } from 'monaco-editor/esm/vs/basic-languages/shell/shell'
import { conf as psConf, language as psLanguage } from 'monaco-editor/esm/vs/basic-languages/powershell/powershell'

const LEGACY_ONIG_INIT_KEY = '__streamMonacoLegacyOnigurumaInit__'
const LEGACY_ENGINE_KEY = '__streamMonacoLegacyShikiEngine__'
const LEGACY_ERROR_FILTER_KEY = '__streamMonacoLegacyMonacoErrorFilterInstalled__'
const LEGACY_FLAG_KEY = '__streamMonacoLegacy__'
const LEGACY_MONACO_LANGS_INIT_KEY = '__streamMonacoLegacyMonacoLangsInit__'
const LEGACY_TOKENS_PROVIDER_GUARD_KEY = '__streamMonacoLegacyTokensProviderGuardInstalled__'

// Ensure these modules are not tree-shaken in legacy builds. Their module side
// effects register critical services used by editor contributions.
void ISuggestMemoryService
void IOutlineModelService

function ensureLegacyOnigurumaInit() {
  if (typeof globalThis === 'undefined')
    return
  const g = globalThis as any
  if (g[LEGACY_ONIG_INIT_KEY])
    return

  // Kick off best-effort Shiki regex engine init early, but don't block module eval.
  // Webpack 4 consumers can otherwise hit a race where Monaco tokenization starts
  // before the TextMate regex engine is ready, causing `null.compileAG`.
  //
  // Strategy:
  // Legacy (Webpack 4) environments are particularly prone to Oniguruma WASM
  // initialization issues that manifest as `null.compileAG` at runtime.
  // To provide deterministic behavior, we default to Shiki's JavaScript regex
  // engine for legacy builds. This avoids WASM entirely and restores syntax
  // highlighting reliably (with a performance trade-off).
  const init = (async () => {
    try {
      const shiki = await import('shiki')
      if (typeof (shiki as any).createJavaScriptRegexEngine === 'function')
        return (shiki as any).createJavaScriptRegexEngine()
      return null
    }
    catch {
      return null
    }
  })()

  g[LEGACY_ONIG_INIT_KEY] = init.then(() => true, () => false)
  g[LEGACY_ENGINE_KEY] = init
}

function ensureLegacyMonacoLanguageContributions() {
  if (typeof globalThis === 'undefined')
    return
  const g = globalThis as any
  if (g[LEGACY_MONACO_LANGS_INIT_KEY])
    return

  const init = Promise.resolve().then(() => {
    // Register a minimal set of Monarch tokenizers synchronously to guarantee
    // syntax highlighting in legacy runtimes (even when Shiki/TextMate fails).
    try {
      const langs: any = (monaco as any).languages
      if (typeof langs?.setMonarchTokensProvider === 'function') {
        langs.setMonarchTokensProvider('javascript', jsLanguage as any)
        langs.setLanguageConfiguration?.('javascript', jsConf as any)

        langs.setMonarchTokensProvider('typescript', tsLanguage as any)
        langs.setLanguageConfiguration?.('typescript', tsConf as any)

        langs.setMonarchTokensProvider('python', pyLanguage as any)
        langs.setLanguageConfiguration?.('python', pyConf as any)

        langs.setMonarchTokensProvider('cpp', cppLanguage as any)
        langs.setLanguageConfiguration?.('cpp', cppConf as any)

        // basic-languages uses `shell` id
        langs.setMonarchTokensProvider('shell', shLanguage as any)
        langs.setLanguageConfiguration?.('shell', shConf as any)

        langs.setMonarchTokensProvider('powershell', psLanguage as any)
        langs.setLanguageConfiguration?.('powershell', psConf as any)
      }
    }
    catch {}

    // Re-apply language ids to force re-tokenization for already-created models.
    // Also apply legacy language normalization (e.g. vue -> html).
    try {
      for (const model of monaco.editor.getModels()) {
        const current = model.getLanguageId()
        const next = processedLanguage(current) || current
        if (next !== current)
          monaco.editor.setModelLanguage(model, next)
        else
          monaco.editor.setModelLanguage(model, current)
      }
    }
    catch {}
  })

  g[LEGACY_MONACO_LANGS_INIT_KEY] = init
}

function ensureLegacyTokensProviderGuard() {
  if (typeof globalThis === 'undefined')
    return
  const g = globalThis as any
  if (g[LEGACY_TOKENS_PROVIDER_GUARD_KEY])
    return
  g[LEGACY_TOKENS_PROVIDER_GUARD_KEY] = true

  try {
    const langs: any = (monaco as any).languages
    const setTokensProvider = typeof langs?.setTokensProvider === 'function'
      ? langs.setTokensProvider.bind(langs)
      : null
    if (!setTokensProvider)
      return

    langs.setTokensProvider = (lang: string, provider: any) => {
      // Wrap tokenization so runtime failures won't crash the app.
      if (provider && typeof provider.tokenize === 'function') {
        const originalTokenize = provider.tokenize.bind(provider)
        const getInitialState = typeof provider.getInitialState === 'function'
          ? provider.getInitialState.bind(provider)
          : null

        const wrappedProvider = {
          ...provider,
          tokenize(line: string, state: any) {
            try {
              return originalTokenize(line, state)
            }
            catch {
              return {
                endState: state,
                tokens: [{ startIndex: 0, scopes: '' }],
              }
            }
          },
        }

        // If this provider throws immediately (e.g. missing Oniguruma/WASM causing
        // `null.compileAG`), don't install it at all so Monaco's built-in
        // tokenizers (loaded via contributions) can remain active.
        try {
          const st = getInitialState ? getInitialState() : null
          wrappedProvider.tokenize('const a = 1', st)
        }
        catch {
          return { dispose() {} } as any
        }

        return setTokensProvider(lang, wrappedProvider)
      }

      return setTokensProvider(lang, provider)
    }
  }
  catch {}
}

function ensureLegacyMonacoErrorFilter() {
  if (typeof globalThis === 'undefined')
    return
  const g = globalThis as any
  if (g[LEGACY_ERROR_FILTER_KEY])
    return
  g[LEGACY_ERROR_FILTER_KEY] = true

  // Best-effort: prevent Monaco from crashing the app on known Shiki/TextMate
  // tokenization failures in legacy (Webpack 4) setups.
  //
  // Monaco funnels internal failures through `vs/base/common/errors`.
  // That module is not public API, but this patch is legacy-only and guarded.
  ;(async () => {
    try {
      const mod: any = await import('monaco-editor/esm/vs/base/common/errors.js')
      const handler = mod?.errorHandler
      if (!handler || typeof handler.unexpectedErrorHandler !== 'function')
        return

      const prev = handler.unexpectedErrorHandler.bind(handler)
      handler.unexpectedErrorHandler = (err: any) => {
        const msg = err?.message ? String(err.message) : String(err)
        if (msg.includes('compileAG') || msg.includes('Cannot read properties of null (reading'))
          return
        return prev(err)
      }
    }
    catch {}
  })()
}

ensureLegacyOnigurumaInit()
;(globalThis as any)[LEGACY_FLAG_KEY] = true
ensureLegacyMonacoLanguageContributions()
ensureLegacyTokensProviderGuard()
ensureLegacyMonacoErrorFilter()
ensureMonacoWorkersLegacy()
