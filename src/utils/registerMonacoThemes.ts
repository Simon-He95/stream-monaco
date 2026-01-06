import type { SpecialTheme, ThemeInput } from 'shiki'
import { shikiToMonaco } from '@shikijs/monaco'
import { createHighlighter } from 'shiki'
import * as monaco from '../monaco-shim'
import { arraysEqual } from './arraysEqual'

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
const monacoThemeByKey = new Map<string, ThemeInput | string | SpecialTheme>()
const monacoLanguageSet = new Set<string>()

function themeKey(t: ThemeInput | string | SpecialTheme) {
  return typeof t === 'string' ? t : (t as any).name ?? JSON.stringify(t)
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
    monacoHighlighterPromise = createHighlighter({ themes: initialThemes, langs: initialLangs })
      .then(h => h)
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
  const p = createHighlighter({ themes: wantsThemes, langs: wantsLangs })
    .then(hh => hh)
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
    const p = createHighlighter({ themes, langs: langsArray })
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
  const p = createHighlighter({ themes, langs: Array.from(requestedSet) })
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
    registerMonacoLanguages(languages)

    const p = (async () => {
      const highlighter = await ensureMonacoHighlighter(themes, languages)

      // Patch Monaco once per shared-highlighter instance.
      if (lastPatchedHighlighter !== highlighter) {
        shikiToMonaco(highlighter, monaco)
        lastPatchedHighlighter = highlighter
      }

      // Track last language set for Monaco language registration short-circuit.
      currentLanguages = languages.slice()
      return highlighter
    })()

    setThemeRegisterPromise(p)
    try {
      const res = await p
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
