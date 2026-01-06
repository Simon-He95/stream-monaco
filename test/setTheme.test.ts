import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the local monaco shim so tests don't try to resolve the real
// 'monaco-editor' package entry via vite.
vi.mock('../src/monaco-shim', () => {
  const setTheme = vi.fn()
  const setModelLanguage = vi.fn()
  const editor = {
    setTheme,
    setModelLanguage,
    IStandaloneCodeEditor: class {},
    EditorOption: { lineHeight: 16 },
  }
  const languages = {
    getLanguages: () => [],
    register: () => {},
  }
  const Range = class {}
  return { default: { editor, languages, Range }, editor, languages, Range }
})

describe('setTheme behavior', () => {
  beforeEach(() => {
    // src/index.ts keeps theme state at module scope; isolate each test.
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should not call monaco.editor.setTheme when theme is already applied', async () => {
    const monaco = await import('../src/monaco-shim')
    const mod = await import('../src/index')
    const { setTheme } = mod.useMonaco({ themes: ['vitesse-dark', 'vitesse-light'] })
    // apply once
    await setTheme('vitesse-dark')
    // applying same theme again without force should be no-op
    await setTheme('vitesse-dark')
    expect(monaco.editor.setTheme).toHaveBeenCalled()
    // should only have been called once by the first application
    expect((monaco.editor.setTheme as any).mock.calls.length).toBe(1)
  })

  it('should call monaco.editor.setTheme when force=true even if same theme', async () => {
    const monaco = await import('../src/monaco-shim')
    const mod = await import('../src/index')
    const { setTheme } = mod.useMonaco({ themes: ['vitesse-dark', 'vitesse-light'] })
    await setTheme('vitesse-dark')
    // force reapplication
    await setTheme('vitesse-dark', true)
    expect((monaco.editor.setTheme as any).mock.calls.length).toBe(2)
  })

  it('should not no-op when another instance changed the global theme', async () => {
    const monaco = await import('../src/monaco-shim')
    const mod = await import('../src/index')

    const a = mod.useMonaco({ themes: ['vitesse-dark', 'vitesse-light'] })
    const b = mod.useMonaco({ themes: ['vitesse-dark', 'vitesse-light'] })

    await a.setTheme('vitesse-dark')
    await b.setTheme('vitesse-light')
    await a.setTheme('vitesse-dark')

    expect((monaco.editor.setTheme as any).mock.calls.length).toBe(3)
  })

  it('auto-loads missing shiki theme when highlighter is cached', async () => {
    vi.resetModules()

    // Mock shiki/monaco registration layer: always returns the same highlighter
    // instance (simulating singleton caching), and requires explicit loadTheme
    // before setTheme will succeed.
    const loadedThemes = new Set<string>(['vitesse-dark', 'vitesse-light'])
    const highlighter = {
      loadTheme: vi.fn(async (t: string) => {
        loadedThemes.add(t)
      }),
      setTheme: vi.fn(async (t: string) => {
        if (!loadedThemes.has(t)) {
          const err: any = new Error(`Theme ${t} not found, you may need to load it first`)
          err.name = 'ShikiError'
          throw err
        }
      }),
      codeToHtml: vi.fn(() => ''),
    }

    vi.doMock('../src/utils/registerMonacoThemes', () => {
      return {
        clearHighlighterCache: () => {},
        getOrCreateHighlighter: async () => highlighter,
        registerMonacoThemes: async () => highlighter,
        setThemeRegisterPromise: (p: any) => p,
      }
    })

    // re-mock monaco shim for this resetModules scope
    vi.doMock('../src/monaco-shim', () => {
      const setTheme = vi.fn()
      const setModelLanguage = vi.fn()
      const editor = {
        setTheme,
        setModelLanguage,
        IStandaloneCodeEditor: class {},
        EditorOption: { lineHeight: 16 },
      }
      const languages = {
        getLanguages: () => [],
        register: () => {},
      }
      const Range = class {}
      return { default: { editor, languages, Range }, editor, languages, Range }
    })

    const monaco = await import('../src/monaco-shim')
    const mod = await import('../src/index')
    const { setTheme } = mod.useMonaco({ themes: ['vitesse-dark', 'vitesse-light'] })

    await setTheme('andromeeda')

    expect(highlighter.loadTheme).toHaveBeenCalledWith('andromeeda')
    expect(monaco.editor.setTheme).toHaveBeenCalledWith('andromeeda')
  })
})
