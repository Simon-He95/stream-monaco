import { describe, expect, it, vi } from 'vitest'

describe('registerMonacoThemes', () => {
  it('re-registers when themes array is mutated in place', async () => {
    vi.resetModules()

    const createHighlighter = vi.fn(async () => ({}))
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

    expect(createHighlighter).toHaveBeenCalledTimes(2)
  })
})

