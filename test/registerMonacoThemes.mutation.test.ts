import { describe, expect, it, vi } from 'vitest'

describe('registerMonacoThemes', () => {
  it('re-registers when themes array is mutated in place', async () => {
    vi.resetModules()

    const loadTheme = vi.fn(async () => undefined)
    const createHighlighter = vi.fn(async () => ({ loadTheme }))
    vi.doMock('shiki', () => ({ createHighlighter }))
    vi.doMock('@shikijs/monaco', () => ({ shikiToMonaco: vi.fn() }))
    vi.doMock('../src/monaco-shim', () => {
      const editor = { defineTheme: vi.fn(), setTheme: vi.fn(), create: vi.fn() }
      const languages = { getLanguages: () => [], register: vi.fn(), setTokensProvider: vi.fn() }
      return { default: { editor, languages }, editor, languages, Range: class {} }
    })

    const { registerMonacoThemes } = await import('../src/utils/registerMonacoThemes')

    const themes: any[] = ['vitesse-dark', 'vitesse-light']
    const langs = ['javascript']

    await registerMonacoThemes(themes, langs)
    themes.push('andromeeda')
    await registerMonacoThemes(themes, langs)

    // Shared Monaco highlighter is created once; additional themes are loaded incrementally.
    expect(createHighlighter).toHaveBeenCalledTimes(1)
    expect(loadTheme).toHaveBeenCalledWith('andromeeda')
    expect(loadTheme).toHaveBeenCalledTimes(1)
  })

  it('does not incrementally reload initially created languages', async () => {
    vi.resetModules()

    const loadLanguage = vi.fn(async () => undefined)
    const createHighlighter = vi.fn(async () => ({ loadLanguage }))
    vi.doMock('shiki', () => ({ createHighlighter }))
    vi.doMock('@shikijs/monaco', () => ({ shikiToMonaco: vi.fn() }))
    vi.doMock('../src/monaco-shim', () => {
      const editor = { defineTheme: vi.fn(), setTheme: vi.fn(), create: vi.fn() }
      const languages = { getLanguages: () => [], register: vi.fn(), setTokensProvider: vi.fn() }
      return { default: { editor, languages }, editor, languages, Range: class {} }
    })

    const { registerMonacoThemes } = await import('../src/utils/registerMonacoThemes')

    await registerMonacoThemes(['vitesse-dark', 'vitesse-light'], ['javascript'])
    await registerMonacoThemes(['vitesse-dark', 'vitesse-light'], ['javascript', 'json'])

    expect(createHighlighter).toHaveBeenCalledTimes(1)
    expect(loadLanguage).toHaveBeenCalledWith('json')
    expect(loadLanguage).toHaveBeenCalledTimes(1)
  })

  it('fully resets shared monaco highlighter state when clearing the cache', async () => {
    vi.resetModules()

    const createHighlighter = vi.fn(async () => ({ loadTheme: vi.fn(async () => undefined) }))
    vi.doMock('shiki', () => ({ createHighlighter }))
    vi.doMock('@shikijs/monaco', () => ({ shikiToMonaco: vi.fn() }))
    vi.doMock('../src/monaco-shim', () => {
      const editor = { defineTheme: vi.fn(), setTheme: vi.fn(), create: vi.fn() }
      const languages = { getLanguages: () => [], register: vi.fn(), setTokensProvider: vi.fn() }
      return { default: { editor, languages }, editor, languages, Range: class {} }
    })

    const {
      clearHighlighterCache,
      registerMonacoThemes,
    } = await import('../src/utils/registerMonacoThemes')

    await registerMonacoThemes(['vitesse-dark', 'vitesse-light'], ['javascript'])
    clearHighlighterCache()
    await registerMonacoThemes(['vitesse-dark', 'vitesse-light'], ['javascript'])

    expect(createHighlighter).toHaveBeenCalledTimes(2)
  })

  it('records tokenization timing without weakening the fallback tokenizer', async () => {
    vi.resetModules()

    let installedProvider: any
    const createHighlighter = vi.fn(async () => ({}))
    vi.doMock('shiki', () => ({ createHighlighter }))
    vi.doMock('@shikijs/monaco', () => ({
      shikiToMonaco: vi.fn((_highlighter, monacoProxy) => {
        monacoProxy.languages.setTokensProvider('javascript', {
          tokenize() {
            throw new Error('tokenize failed')
          },
        })
      }),
    }))
    vi.doMock('../src/monaco-shim', () => {
      const editor = { defineTheme: vi.fn(), setTheme: vi.fn(), create: vi.fn() }
      const languages = {
        getLanguages: () => [],
        register: vi.fn(),
        setTokensProvider: vi.fn((_lang, provider) => {
          installedProvider = provider
        }),
      }
      return { default: { editor, languages }, editor, languages, Range: class {} }
    })

    const events: any[] = []
    ;(globalThis as any).__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__ = true
    ;(globalThis as any).__STREAM_MONACO_PERF__ = {
      recordTokenize: (event: any) => events.push(event),
    }

    try {
      const { registerMonacoThemes } = await import('../src/utils/registerMonacoThemes')
      await registerMonacoThemes(['vitesse-dark'], ['javascript'])

      const result = installedProvider.tokenize('const answer = 42', {})

      expect(result).toEqual({
        endState: {},
        tokens: [{ startIndex: 0, scopes: '' }],
      })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        language: 'javascript',
        lineLength: 'const answer = 42'.length,
        lineSample: 'const answer = 42',
        tokenCount: 1,
        failed: true,
      })
      expect(events[0].durationMs).toEqual(expect.any(Number))
    }
    finally {
      delete (globalThis as any).__STREAM_MONACO_PERF__
      delete (globalThis as any).__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__
    }
  })

  it('records theme registration timing when the perf hook is present', async () => {
    vi.resetModules()

    const createHighlighter = vi.fn(async () => ({}))
    const shikiToMonaco = vi.fn()
    vi.doMock('shiki', () => ({ createHighlighter }))
    vi.doMock('@shikijs/monaco', () => ({ shikiToMonaco }))
    vi.doMock('../src/monaco-shim', () => {
      const editor = { defineTheme: vi.fn(), setTheme: vi.fn(), create: vi.fn() }
      const languages = { getLanguages: () => [], register: vi.fn(), setTokensProvider: vi.fn() }
      return { default: { editor, languages }, editor, languages, Range: class {} }
    })

    const events: any[] = []
    ;(globalThis as any).__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__ = true
    ;(globalThis as any).__STREAM_MONACO_PERF__ = {
      recordThemeRegistration: (event: any) => events.push(event),
    }

    try {
      const { registerMonacoThemes } = await import('../src/utils/registerMonacoThemes')
      await registerMonacoThemes(['vitesse-dark'], ['javascript'])

      expect(shikiToMonaco).toHaveBeenCalledTimes(1)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        themes: 1,
        languages: 1,
        patchedMonaco: true,
      })
      expect(events[0].durationMs).toEqual(expect.any(Number))
      expect(events[0].ensureHighlighterMs).toEqual(expect.any(Number))
      expect(events[0].patchMonacoMs).toEqual(expect.any(Number))
    }
    finally {
      delete (globalThis as any).__STREAM_MONACO_PERF__
      delete (globalThis as any).__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__
    }
  })

  it('records grammar tokenization timing when the perf hook is present', async () => {
    vi.resetModules()

    const grammar = {
      tokenizeLine2: vi.fn(() => ({
        tokens: new Uint32Array([0, 1, 4, 2]),
        ruleStack: {},
        stoppedEarly: true,
      })),
    }
    const createHighlighter = vi.fn(async () => ({
      getLanguage: vi.fn(() => grammar),
    }))
    vi.doMock('shiki', () => ({ createHighlighter }))
    vi.doMock('@shikijs/monaco', () => ({
      shikiToMonaco: vi.fn((highlighter) => {
        highlighter.getLanguage('javascript').tokenizeLine2('let slow = true', {}, 500)
      }),
    }))
    vi.doMock('../src/monaco-shim', () => {
      const editor = { defineTheme: vi.fn(), setTheme: vi.fn(), create: vi.fn() }
      const languages = { getLanguages: () => [], register: vi.fn(), setTokensProvider: vi.fn() }
      return { default: { editor, languages }, editor, languages, Range: class {} }
    })

    const events: any[] = []
    ;(globalThis as any).__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__ = true
    ;(globalThis as any).__STREAM_MONACO_PERF__ = {
      recordGrammarTokenize: (event: any) => events.push(event),
    }

    try {
      const { registerMonacoThemes } = await import('../src/utils/registerMonacoThemes')
      await registerMonacoThemes(['vitesse-dark'], ['javascript'])

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        language: 'javascript',
        lineLength: 'let slow = true'.length,
        lineSample: 'let slow = true',
        stoppedEarly: true,
        tokenCount: 2,
      })
      expect(events[0].durationMs).toEqual(expect.any(Number))
    }
    finally {
      delete (globalThis as any).__STREAM_MONACO_PERF__
      delete (globalThis as any).__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__
    }
  })
})
