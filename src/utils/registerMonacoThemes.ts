import type { SpecialTheme, ThemeInput } from 'shiki'
import { shikiToMonaco } from '@shikijs/monaco'
import { createHighlighter } from 'shiki'
import * as monaco from '../monaco-shim'
import { arraysEqual } from './arraysEqual'

let themesRegistered = false
let languagesRegistered = false
let currentThemes: (ThemeInput | string | SpecialTheme)[] = []
let currentLanguages: string[] = []
// promise that resolves to a shiki highlighter or null when registration completes
let themeRegisterPromise: Promise<import('../type').ShikiHighlighter | null> | null = null
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
  registerMonacoLanguages(languages)

  if (
    themesRegistered
    && arraysEqual(themes, currentThemes)
    && arraysEqual(languages, currentLanguages)
  ) {
    // return existing highlighter if available
    const existing = highlighterCache.get(serializeThemes(themes))
    return existing ? existing.promise : Promise.resolve(null)
  }

  const p = (async () => {
    const highlighter = await getOrCreateHighlighter(themes, languages)
    shikiToMonaco(highlighter, monaco)

    themesRegistered = true
    // Copy inputs so later in-place mutations from consumers don't trick our
    // shallow equality check (arraysEqual short-circuits on reference equality).
    currentThemes = themes.slice()
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
