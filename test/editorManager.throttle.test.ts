import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function installRafMocks() {
  vi.stubGlobal('requestAnimationFrame', (cb: any) => {
    return setTimeout(() => cb(Date.now()), 0) as unknown as number
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
  })
}

async function loadUseMonaco() {
  vi.resetModules()

  vi.doMock('../src/utils/registerMonacoThemes', () => {
    return {
      clearHighlighterCache: () => {},
      getOrCreateHighlighter: async () => null,
      registerMonacoThemes: async () => null,
    }
  })

  vi.doMock('../src/monaco-shim', () => {
    class Range {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    }

    function createModel(initialValue: string, initialLanguage: string) {
      let value = initialValue
      let languageId = initialLanguage
      const contentSizeListeners = new Set<() => void>()
      const contentChangeListeners = new Set<() => void>()

      function lines() {
        return value.split('\n')
      }

      function getOffsetAt(lineNumber: number, column: number) {
        const parts = lines()
        let offset = 0
        for (let i = 0; i < lineNumber - 1; i++)
          offset += (parts[i] ?? '').length + 1
        return offset + column - 1
      }

      function emitChange() {
        contentChangeListeners.forEach(listener => listener())
        contentSizeListeners.forEach(listener => listener())
      }

      return {
        getValue() {
          return value
        },
        setValue(next: string) {
          value = next
          emitChange()
        },
        getLineCount() {
          return lines().length
        },
        getLineMaxColumn(lineNumber: number) {
          return (lines()[lineNumber - 1] ?? '').length + 1
        },
        getPositionAt(offset: number) {
          const consumed = value.slice(0, offset).split('\n')
          return {
            lineNumber: consumed.length,
            column: consumed[consumed.length - 1].length + 1,
          }
        },
        getLanguageId() {
          return languageId
        },
        setLanguageId(next: string) {
          languageId = next
        },
        applyEdits(edits: Array<{ range: Range, text: string }>) {
          for (const edit of edits) {
            const start = getOffsetAt(
              edit.range.startLineNumber,
              edit.range.startColumn,
            )
            const end = getOffsetAt(
              edit.range.endLineNumber,
              edit.range.endColumn,
            )
            value = value.slice(0, start) + edit.text + value.slice(end)
          }
          emitChange()
        },
        onDidContentSizeChange(listener: () => void) {
          contentSizeListeners.add(listener)
          return {
            dispose() {
              contentSizeListeners.delete(listener)
            },
          }
        },
        onDidChangeContent(listener: () => void) {
          contentChangeListeners.add(listener)
          return {
            dispose() {
              contentChangeListeners.delete(listener)
            },
          }
        },
      }
    }

    const editor = {
      EditorOption: {
        lineHeight: 'lineHeight',
        readOnly: 'readOnly',
      },
      create: vi.fn((_: any, options: any) => {
        const model = createModel(options.value ?? '', options.language ?? 'plaintext')
        const scrollListeners = new Set<(e: any) => void>()
        const domNode = {
          addEventListener() {},
          removeEventListener() {},
        }

        return {
          getModel() {
            return model
          },
          getValue() {
            return model.getValue()
          },
          getOption(option: string) {
            if (option === editor.EditorOption.lineHeight)
              return 20
            if (option === editor.EditorOption.readOnly)
              return options.readOnly ?? true
            return undefined
          },
          getLayoutInfo() {
            return { height: 240 }
          },
          getScrollTop() {
            return 0
          },
          getScrollHeight() {
            return model.getLineCount() * 20
          },
          onDidContentSizeChange(listener: () => void) {
            return model.onDidContentSizeChange(listener)
          },
          onDidChangeModelContent(listener: () => void) {
            return model.onDidChangeContent(listener)
          },
          onDidScrollChange(listener: (e: any) => void) {
            scrollListeners.add(listener)
            return {
              dispose() {
                scrollListeners.delete(listener)
              },
            }
          },
          executeEdits(_: string, edits: Array<{ range: Range, text: string }>) {
            model.applyEdits(edits)
          },
          revealLine() {},
          revealLineInCenter() {},
          revealLineInCenterIfOutsideViewport() {},
          dispose() {},
          getDomNode() {
            return domNode as any
          },
        }
      }),
      setTheme: vi.fn(),
      setModelLanguage: vi.fn((model: any, language: string) => {
        model.setLanguageId(language)
      }),
    }

    const languages = {
      getLanguages: () => [],
      register: vi.fn(),
    }

    return {
      default: { editor, languages, Range },
      editor,
      languages,
      Range,
    }
  })

  return await import('../src/index.base')
}

describe('EditorManager update throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'))
    installRafMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('respects updateThrottleMs after createEditor uses EditorManager', async () => {
    const { useMonaco } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['javascript'],
      readOnly: true,
      updateThrottleMs: 50,
    })

    const container = { style: {}, innerHTML: '' } as any
    await monaco.createEditor(container, '', 'javascript')
    await vi.runAllTimersAsync()

    monaco.updateCode('a', 'javascript')
    await vi.runAllTimersAsync()
    expect(monaco.getCode()).toBe('a')

    monaco.updateCode('ab', 'javascript')
    await vi.advanceTimersByTimeAsync(20)
    expect(monaco.getCode()).toBe('a')

    await vi.advanceTimersByTimeAsync(40)
    expect(monaco.getCode()).toBe('ab')
  })

  it('propagates runtime throttle changes into the active EditorManager', async () => {
    const { useMonaco } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['javascript'],
      readOnly: true,
      updateThrottleMs: 100,
    })

    const container = { style: {}, innerHTML: '' } as any
    await monaco.createEditor(container, '', 'javascript')
    await vi.runAllTimersAsync()

    monaco.updateCode('a', 'javascript')
    await vi.runAllTimersAsync()
    expect(monaco.getCode()).toBe('a')

    monaco.updateCode('ab', 'javascript')
    await vi.advanceTimersByTimeAsync(20)
    expect(monaco.getCode()).toBe('a')

    monaco.setUpdateThrottleMs(0)
    expect(monaco.getUpdateThrottleMs()).toBe(0)

    await vi.runAllTimersAsync()
    expect(monaco.getCode()).toBe('ab')
  })
})
