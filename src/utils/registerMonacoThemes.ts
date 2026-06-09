import type { SpecialTheme, ThemeInput } from 'shiki'
import { shikiToMonaco } from '@shikijs/monaco'
import { createHighlighter } from 'shiki'
import * as monaco from '../monaco-shim'
import { arraysEqual } from './arraysEqual'

const LEGACY_ONIG_INIT_KEY = '__streamMonacoLegacyOnigurumaInit__'
const LEGACY_ENGINE_KEY = '__streamMonacoLegacyShikiEngine__'
const LEGACY_MONACO_LANGS_INIT_KEY = '__streamMonacoLegacyMonacoLangsInit__'
// Private benchmark hooks; not a public API.
const PERF_HOOKS_ENABLED_KEY = '__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__'

async function awaitLegacyOnigurumaInitIfPresent() {
  try {
    const p = (globalThis as any)?.[LEGACY_ONIG_INIT_KEY]
    if (p && typeof p.then === 'function')
      await p
  }
  catch {}
}

async function awaitLegacyMonacoLanguageContributionsIfPresent() {
  try {
    const p = (globalThis as any)?.[LEGACY_MONACO_LANGS_INIT_KEY]
    if (p && typeof p.then === 'function')
      await p
  }
  catch {}
}

async function getLegacyShikiEngineIfPresent() {
  try {
    const p = (globalThis as any)?.[LEGACY_ENGINE_KEY]
    if (p && typeof p.then === 'function')
      return await p
  }
  catch {}
  return null
}

async function createHighlighterWithLegacyEngineIfNeeded(options: any) {
  await awaitLegacyOnigurumaInitIfPresent()
  await awaitLegacyMonacoLanguageContributionsIfPresent()
  const engine = await getLegacyShikiEngineIfPresent()
  if (engine)
    return createHighlighter({ ...options, engine })
  return createHighlighter(options)
}

let languagesRegistered = false
let currentLanguages: string[] = []
// promise that resolves to a shiki highlighter or null when registration completes
let themeRegisterPromise: Promise<import('../type').ShikiHighlighter | null> | null = null

// Serialize registrations to avoid races where multiple calls patch Monaco's
// global `editor.setTheme` with different highlighters in an interleaved order.
let registrationQueue: Promise<unknown> = Promise.resolve()
function enqueueRegistration<T>(task: () => Promise<T>): Promise<T> {
  const next = registrationQueue.then(task, task)
  // keep queue alive even if a task rejects
  registrationQueue = next.then(() => undefined, () => undefined)
  return next
}
export function getThemeRegisterPromise() {
  return themeRegisterPromise
}
export function setThemeRegisterPromise(p: Promise<import('../type').ShikiHighlighter | null> | null) {
  return themeRegisterPromise = p
}

interface HighlighterEntry {
  // promise that resolves to a shiki highlighter
  promise: Promise<any>
  // set of languages this highlighter was created with
  languages: Set<string>
}

const highlighterCache = new Map<string, HighlighterEntry>()

// Monaco integration is global (monaco.editor.setTheme is patched by shikiToMonaco).
// When multiple editors/code blocks initialize concurrently with different theme
// sets, repeatedly calling shikiToMonaco with different highlighters causes the
// last one to win, and themes not present in that last highlighter can throw.
//
// To avoid that, keep a single shared highlighter for Monaco and incrementally
// load themes/languages into it.
let monacoHighlighterPromise: Promise<import('../type').ShikiHighlighter> | null = null
let lastPatchedHighlighter: import('../type').ShikiHighlighter | null = null
let lastPatchedLanguages = new Set<string>()
const monacoThemeByKey = new Map<string, ThemeInput | string | SpecialTheme>()
const monacoLanguageSet = new Set<string>()

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function isPerfHooksEnabled() {
  try {
    return (globalThis as any)?.[PERF_HOOKS_ENABLED_KEY] === true
  }
  catch {
    return false
  }
}

function getPerfHook(name: 'recordTokenize' | 'recordGrammarTokenize' | 'recordThemeRegistration') {
  if (!isPerfHooksEnabled())
    return null
  try {
    const hook = (globalThis as any).__STREAM_MONACO_PERF__?.[name]
    return typeof hook === 'function' ? hook : null
  }
  catch {
    return null
  }
}

function getTokenizationPerfHook() {
  return getPerfHook('recordTokenize')
}

function getGrammarTokenizationPerfHook() {
  return getPerfHook('recordGrammarTokenize')
}

function getThemeRegistrationPerfHook() {
  return getPerfHook('recordThemeRegistration')
}

function recordTokenize(
  hook: ((event: {
    language: string
    durationMs: number
    lineLength: number
    lineSample: string
    tokenCount: number
    failed: boolean
  }) => void) | null,
  language: string,
  durationMs: number,
  line: string,
  tokenCount: number,
  failed: boolean,
) {
  if (!hook)
    return
  try {
    hook({
      language,
      durationMs,
      lineLength: line.length,
      lineSample: line.slice(0, 120),
      tokenCount,
      failed,
    })
  }
  catch {}
}

function recordGrammarTokenize(
  language: string,
  durationMs: number,
  line: string,
  stoppedEarly: boolean,
  tokenCount: number,
) {
  const hook = getGrammarTokenizationPerfHook()
  if (!hook)
    return
  try {
    hook({
      language,
      durationMs,
      lineLength: line.length,
      lineSample: line.slice(0, 120),
      stoppedEarly,
      tokenCount,
    })
  }
  catch {}
}

function recordThemeRegistration(
  event: {
    durationMs: number
    ensureHighlighterMs: number
    patchMonacoMs: number
    themes: number
    languages: number
    patchedMonaco: boolean
  },
) {
  const hook = getThemeRegistrationPerfHook()
  if (!hook)
    return
  try {
    hook(event)
  }
  catch {}
}

function themeKey(t: ThemeInput | string | SpecialTheme) {
  return typeof t === 'string' ? t : (t as any).name ?? JSON.stringify(t)
}

function maybeInstrumentHighlighterGrammar(
  highlighter: import('../type').ShikiHighlighter,
) {
  if (!getGrammarTokenizationPerfHook())
    return highlighter
  return new Proxy(highlighter as any, {
    get(target, prop, receiver) {
      if (prop !== 'getLanguage')
        return Reflect.get(target, prop, receiver)
      return (language: string) => {
        const grammar = target.getLanguage(language)
        if (!grammar || typeof grammar.tokenizeLine2 !== 'function')
          return grammar
        return new Proxy(grammar, {
          get(grammarTarget, grammarProp, grammarReceiver) {
            if (grammarProp !== 'tokenizeLine2')
              return Reflect.get(grammarTarget, grammarProp, grammarReceiver)
            const originalTokenizeLine2 = grammarTarget.tokenizeLine2.bind(grammarTarget)
            return (line: string, ruleStack: any, timeLimit: number) => {
              const startedAt = nowMs()
              const result = originalTokenizeLine2(line, ruleStack, timeLimit)
              recordGrammarTokenize(
                language,
                nowMs() - startedAt,
                line,
                !!result?.stoppedEarly,
                typeof result?.tokens?.length === 'number' ? result.tokens.length / 2 : 0,
              )
              return result
            }
          },
        })
      }
    },
  })
}

async function ensureMonacoHighlighter(
  themes: (ThemeInput | string | SpecialTheme)[],
  languages: string[],
) {
  // track union first
  for (const t of themes)
    monacoThemeByKey.set(themeKey(t), t)
  for (const l of languages)
    monacoLanguageSet.add(l)

  // create shared highlighter once
  if (!monacoHighlighterPromise) {
    const initialThemes = Array.from(monacoThemeByKey.values())
    const initialLangs = Array.from(monacoLanguageSet.values())
    monacoHighlighterPromise = createHighlighterWithLegacyEngineIfNeeded({ themes: initialThemes, langs: initialLangs })
      .then((h) => {
        ;(h as any).__streamMonacoLoadedThemes = new Set(
          initialThemes.map(t => themeKey(t)),
        )
        ;(h as any).__streamMonacoLoadedLangs = new Set(initialLangs)
        return h
      })
  }

  const h = await monacoHighlighterPromise

  // Incrementally load missing themes/langs when supported by shiki.
  // If incremental loading isn't available, fall back to re-creating the shared
  // highlighter with the full union (still safe because the union only grows).
  const wantsThemes = Array.from(monacoThemeByKey.values())
  const wantsLangs = Array.from(monacoLanguageSet.values())

  const canLoadTheme = typeof (h as any).loadTheme === 'function'
  const canLoadLanguage = typeof (h as any).loadLanguage === 'function'

  if (canLoadTheme || canLoadLanguage) {
    if (canLoadTheme) {
      // loadTheme is idempotent in shiki; call only for newly requested theme keys
      for (const t of themes) {
        const k = themeKey(t)
        // If we've already loaded it, skip.
        // We can't reliably introspect loaded themes from shiki, so track keys.
        if (!(h as any).__streamMonacoLoadedThemes)
          (h as any).__streamMonacoLoadedThemes = new Set<string>()
        const loaded: Set<string> = (h as any).__streamMonacoLoadedThemes
        if (loaded.has(k))
          continue
        await (h as any).loadTheme(t)
        loaded.add(k)
      }
    }

    if (canLoadLanguage) {
      for (const l of languages) {
        if (!(h as any).__streamMonacoLoadedLangs)
          (h as any).__streamMonacoLoadedLangs = new Set<string>()
        const loaded: Set<string> = (h as any).__streamMonacoLoadedLangs
        if (loaded.has(l))
          continue
        await (h as any).loadLanguage(l)
        loaded.add(l)
      }
    }

    return h
  }

  // fallback: recreate shared highlighter with union
  const p = createHighlighterWithLegacyEngineIfNeeded({ themes: wantsThemes, langs: wantsLangs })
    .then((hh) => {
      ;(hh as any).__streamMonacoLoadedThemes = new Set(
        wantsThemes.map(t => themeKey(t)),
      )
      ;(hh as any).__streamMonacoLoadedLangs = new Set(wantsLangs)
      return hh
    })
  monacoHighlighterPromise = p
  return p
}

/**
 * Clear all cached shiki highlighters.
 *
 * Useful for long-running apps that dynamically create many theme combinations,
 * or in tests to ensure a clean state. Call this when you know the highlighters
 * are no longer needed (for example on app shutdown) to free memory.
 */
export function clearHighlighterCache() {
  highlighterCache.clear()
  monacoHighlighterPromise = null
  lastPatchedHighlighter = null
  lastPatchedLanguages = new Set<string>()
  monacoThemeByKey.clear()
  monacoLanguageSet.clear()
  themeRegisterPromise = null
  languagesRegistered = false
  currentLanguages = []
}

/**
 * Return number of entries currently in the highlighter cache.
 * Helpful for tests and debugging.
 */
export function getHighlighterCacheSize() {
  return highlighterCache.size
}

function serializeThemes(themes: (ThemeInput | string | SpecialTheme)[]) {
  return JSON.stringify(
    themes.map(t => typeof t === 'string' ? t : (t as any).name ?? JSON.stringify(t)).sort(),
  )
}

async function getOrCreateHighlighter(
  themes: (ThemeInput | string | SpecialTheme)[],
  languages: string[],
): Promise<import('../type').ShikiHighlighter> {
  const key = serializeThemes(themes)
  const requestedSet = new Set(languages)
  let existing = highlighterCache.get(key)

  if (existing) {
    // if existing entry already covers requested languages, reuse
    let allIncluded = true
    for (const l of requestedSet) {
      if (!existing.languages.has(l)) {
        allIncluded = false
        break
      }
    }
    if (allIncluded) {
      return existing.promise
    }

    // double-check cache in case a concurrent request already replaced/expanded the entry
    const prev = existing
    const current = highlighterCache.get(key)
    if (current && current !== prev) {
      // if the current cached entry already covers requested languages, reuse it
      let allIncludedCurrent = true
      for (const l of requestedSet) {
        if (!current.languages.has(l)) {
          allIncludedCurrent = false
          break
        }
      }
      if (allIncludedCurrent) {
        return current.promise
      }
      // otherwise prefer the most recent cached entry for the union creation
      existing = current
    }

    // otherwise create a new highlighter with the union of languages
    const union = new Set<string>([...existing.languages, ...requestedSet])
    const langsArray = Array.from(union)
    const p = createHighlighterWithLegacyEngineIfNeeded({ themes, langs: langsArray })
    const newEntry: HighlighterEntry = { promise: p, languages: union }
    highlighterCache.set(key, newEntry)

    // if creation fails, try to restore previous entry (prev)
    p.catch(() => {
      if (highlighterCache.get(key) === newEntry && prev) {
        highlighterCache.set(key, prev)
      }
    })

    return p
  }

  // no cached entry, create and cache
  const p = createHighlighterWithLegacyEngineIfNeeded({ themes, langs: Array.from(requestedSet) })
  const entry: HighlighterEntry = { promise: p, languages: requestedSet }
  highlighterCache.set(key, entry)
  p.catch(() => {
    if (highlighterCache.get(key) === entry) {
      highlighterCache.delete(key)
    }
  })
  return p
}
// Exported for callers that need direct access to the shiki highlighter
export { getOrCreateHighlighter }

/**
 * Update the theme used by the shiki highlighter for a given themes+languages
 * combination. Useful when Monaco themes are already registered (so switching
 * Monaco only requires `monaco.editor.setTheme`) but you also want shiki's
 * standalone renderer to use the new theme without recreating everything.
 */
// NOTE: setHighlighterTheme removed — switching Monaco theme via
// `monaco.editor.setTheme(themeName)` is sufficient for editor theme changes.
// If consumers need to directly control a shiki highlighter they can use
// `getOrCreateHighlighter(...)` and call methods on the returned object.
export async function registerMonacoThemes(
  themes: (ThemeInput | string | SpecialTheme)[],
  languages: string[],
): Promise<import('../type').ShikiHighlighter | null> {
  return enqueueRegistration(async () => {
    const registrationStartedAt = nowMs()
    let ensureHighlighterMs = 0
    let patchMonacoMs = 0
    let patchedMonaco = false
    registerMonacoLanguages(languages)

    const p = (async () => {
      const ensureHighlighterStartedAt = nowMs()
      const highlighter = await ensureMonacoHighlighter(themes, languages)
      ensureHighlighterMs = nowMs() - ensureHighlighterStartedAt

      // Patch Monaco when:
      // - the shared highlighter instance changes, OR
      // - new languages were added (incremental load) and need tokens providers.
      //
      // `shikiToMonaco()` installs tokens providers per language at call-time.
      // When we incrementally load languages into the shared highlighter, we
      // must re-run `shikiToMonaco()` so Monaco receives providers for the newly
      // loaded languages.
      const wantsLangs = Array.from(monacoLanguageSet.values())
      const needsLanguagePatch = lastPatchedHighlighter !== highlighter
        || wantsLangs.some(l => !lastPatchedLanguages.has(l))

      if (needsLanguagePatch) {
        if (lastPatchedHighlighter !== highlighter)
          lastPatchedLanguages = new Set<string>()

        // In some bundlers (notably Webpack 4), Shiki/TextMate tokenization can
        // still throw at runtime (e.g. `null.compileAG`) due to regex engine
        // initialization quirks. Monaco reports these as "unexpected errors"
        // and they crash the app.
        //
        // We cannot monkey-patch `import * as monaco` namespace exports (ESM
        // namespace objects are immutable), so pass a proxy object into
        // `shikiToMonaco()` that wraps `setTokensProvider` instead.
        const realLanguages: any = (monaco as any).languages
        const realEditor: any = (monaco as any).editor
        const setTokensProvider = typeof realLanguages?.setTokensProvider === 'function'
          ? realLanguages.setTokensProvider.bind(realLanguages)
          : null
        const getLanguages = typeof realLanguages?.getLanguages === 'function'
          ? realLanguages.getLanguages.bind(realLanguages)
          : null

        const monacoProxy: any = {
          // Forward everything else (Range, Uri, etc.) via prototype lookup.
          __proto__: monaco as any,
          editor: realEditor,
          languages: {
            __proto__: realLanguages,
            getLanguages,
            setTokensProvider(lang: string, provider: any) {
              if (provider && typeof provider.tokenize === 'function') {
                const originalTokenize = provider.tokenize.bind(provider)
                provider = {
                  ...provider,
                  tokenize(line: string, state: any) {
                    const hook = getTokenizationPerfHook()
                    const startedAt = hook ? nowMs() : 0
                    let tokenCount = 0
                    let failed = false
                    try {
                      const result = originalTokenize(line, state)
                      tokenCount = Array.isArray(result?.tokens) ? result.tokens.length : 0
                      return result
                    }
                    catch {
                      failed = true
                      tokenCount = 1
                      return {
                        endState: state,
                        tokens: [{ startIndex: 0, scopes: '' }],
                      }
                    }
                    finally {
                      if (hook)
                        recordTokenize(hook, lang, nowMs() - startedAt, line, tokenCount, failed)
                    }
                  },
                }
              }
              return setTokensProvider?.(lang, provider)
            },
          },
        }

        const patchMonacoStartedAt = nowMs()
        shikiToMonaco(maybeInstrumentHighlighterGrammar(highlighter), monacoProxy)
        patchMonacoMs = nowMs() - patchMonacoStartedAt
        patchedMonaco = true
        lastPatchedHighlighter = highlighter
        lastPatchedLanguages = new Set(wantsLangs)
      }

      // Track last language set for Monaco language registration short-circuit.
      currentLanguages = languages.slice()
      return highlighter
    })()

    setThemeRegisterPromise(p)
    try {
      const res = await p
      recordThemeRegistration({
        durationMs: nowMs() - registrationStartedAt,
        ensureHighlighterMs,
        patchMonacoMs,
        themes: themes.length,
        languages: languages.length,
        patchedMonaco,
      })
      return res
    }
    catch (e) {
      setThemeRegisterPromise(null)
      throw e
    }
  })
}

function registerMonacoLanguages(languages: string[]) {
  if (languagesRegistered && arraysEqual(languages, currentLanguages)) {
    return
  }

  const existing = new Set(monaco.languages.getLanguages().map(l => l.id))
  for (const lang of languages) {
    if (!existing.has(lang)) {
      try {
        monaco.languages.register({ id: lang })
      }
      catch {
        // ignore unsupported ids
      }
    }
  }

  languagesRegistered = true
  currentLanguages = languages
}
