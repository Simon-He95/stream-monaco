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
    let lastCreatedModel: any = null
    let lastCreatedEditor: any = null

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
      let getValueCallCount = 0
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
          getValueCallCount += 1
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
        __getGetValueCallCount() {
          return getValueCallCount
        },
      }
    }

    const editor = {
      EditorOption: {
        lineHeight: 'lineHeight',
        readOnly: 'readOnly',
      },
      ScrollType: {
        Smooth: 'smooth',
      },
      create: vi.fn((_: any, options: any) => {
        const model = createModel(options.value ?? '', options.language ?? 'plaintext')
        lastCreatedModel = model
        const scrollListeners = new Set<(e: any) => void>()
        let scrollTop = 0
        const domNode = {
          addEventListener() {},
          removeEventListener() {},
        }

        const editorApi = {
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
            return scrollTop
          },
          setScrollTop: vi.fn((next: number) => {
            scrollTop = next
          }),
          getScrollHeight() {
            return model.getLineCount() * 20
          },
          getContentHeight() {
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
          revealLine: vi.fn(),
          revealLineInCenter: vi.fn(),
          revealLineInCenterIfOutsideViewport: vi.fn(),
          dispose() {},
          getDomNode() {
            return domNode as any
          },
          __setScrollTop(next: number) {
            scrollTop = next
          },
        }
        lastCreatedEditor = editorApi
        return editorApi
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
      ScrollType: editor.ScrollType,
      __getLastModel() {
        return lastCreatedModel
      },
      __getLastEditor() {
        return lastCreatedEditor
      },
    }
  })

  const base = await import('../src/index.base')
  const monacoModule: any = await import('../src/monaco-shim')
  return {
    ...base,
    __getLastModel: monacoModule.__getLastModel,
    __getLastEditor: monacoModule.__getLastEditor,
  }
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

  it('avoids rereading the whole model during programmatic streaming appends', async () => {
    const { useMonaco, __getLastModel } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['javascript'],
      readOnly: true,
      updateThrottleMs: 0,
    })

    const container = { style: {}, innerHTML: '' } as any
    await monaco.createEditor(container, '', 'javascript')
    await vi.runAllTimersAsync()

    const model = __getLastModel()
    const beforeFirstUpdate = model.__getGetValueCallCount()
    monaco.updateCode('a', 'javascript')
    await vi.runAllTimersAsync()
    expect(model.__getGetValueCallCount() - beforeFirstUpdate).toBe(0)

    const beforeSecondUpdate = model.__getGetValueCallCount()
    monaco.updateCode('ab', 'javascript')
    await vi.runAllTimersAsync()
    expect(model.__getGetValueCallCount() - beforeSecondUpdate).toBe(0)
    expect(monaco.getCode()).toBe('ab')
  })

  it('keeps frame-by-frame streaming appends byte-for-byte aligned', async () => {
    const { useMonaco } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['json'],
      readOnly: true,
      updateThrottleMs: 0,
    })
    const code = `{
  ".c": "C",
  ".cpp": "C++",
  ".cc": "C++"
}`

    const container = { style: {}, innerHTML: '' } as any
    await monaco.createEditor(container, '', 'json')
    await vi.runAllTimersAsync()

    for (let i = 1; i <= code.length; i++) {
      monaco.updateCode(code.slice(0, i), 'json')
      await vi.runAllTimersAsync()
    }

    expect(monaco.getCode()).toBe(code)
  })

  it('does not reveal while streamed content is still shorter than the editor height', async () => {
    const { useMonaco, __getLastEditor } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['json'],
      readOnly: true,
      updateThrottleMs: 0,
    })
    const code = `{
  ".c": "C",
  ".cpp": "C++",
  ".cc": "C++"
}`

    const container = { style: {}, innerHTML: '' } as any
    await monaco.createEditor(container, '', 'json')
    await vi.runAllTimersAsync()

    const editor = __getLastEditor()
    for (const line of code.split('\n')) {
      const next = monaco.getCode()
        ? `${monaco.getCode()}\n${line}`
        : line
      monaco.updateCode(next, 'json')
      await vi.runAllTimersAsync()
    }

    expect(editor.revealLine).not.toHaveBeenCalled()
    expect(editor.revealLineInCenter).not.toHaveBeenCalled()
    expect(editor.revealLineInCenterIfOutsideViewport).not.toHaveBeenCalled()
  })

  it('uses Monaco content height without forcing a minimum host height', async () => {
    const { useMonaco } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['json'],
      readOnly: true,
      updateThrottleMs: 0,
    })

    const container = { style: {}, innerHTML: '' } as any
    await monaco.createEditor(container, '', 'json')
    await vi.runAllTimersAsync()

    expect(container.style.minHeight).toBeUndefined()
    expect(container.style.height).toBe('20px')

    monaco.updateCode('{\n  "a": 1\n}', 'json')
    await vi.runAllTimersAsync()

    expect(container.style.height).toBe('60px')
  })

  it('keeps scroll pinned to top before streamed content reaches max height', async () => {
    const { useMonaco, __getLastEditor } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['json'],
      readOnly: true,
      updateThrottleMs: 0,
    })

    const container = { style: {}, innerHTML: '' } as any
    await monaco.createEditor(container, '', 'json')
    await vi.runAllTimersAsync()

    const editor = __getLastEditor()
    editor.__setScrollTop(8)
    monaco.updateCode('{\n  "a": 1\n}', 'json')
    await vi.runAllTimersAsync()

    expect(container.style.height).toBe('60px')
    expect(container.style.overflow).toBe('hidden')
    expect(editor.setScrollTop).toHaveBeenCalledWith(0)
  })

  it('does not fight an external host height within the height hysteresis', async () => {
    const { useMonaco } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['json'],
      readOnly: true,
      updateThrottleMs: 0,
    })

    const container = {
      style: {},
      innerHTML: '',
      getBoundingClientRect: () => ({ height: 41 }),
    } as any
    await monaco.createEditor(container, '', 'json')
    await vi.runAllTimersAsync()

    monaco.updateCode('{\n}', 'json')
    container.style.height = '41px'
    await vi.runAllTimersAsync()

    expect(container.style.height).toBe('41px')
  })

  it('still syncs externally edited content before the next streamed update', async () => {
    const { useMonaco, __getLastModel } = await loadUseMonaco()
    const monaco = useMonaco({
      themes: ['vitesse-dark', 'vitesse-light'],
      languages: ['javascript'],
      readOnly: false,
      updateThrottleMs: 0,
    })

    const container = { style: {}, innerHTML: '' } as any
    await monaco.createEditor(container, '', 'javascript')
    await vi.runAllTimersAsync()

    const model = __getLastModel()
    model.setValue('hello')
    await vi.runAllTimersAsync()

    monaco.updateCode('hello world', 'javascript')
    await vi.runAllTimersAsync()
    expect(monaco.getCode()).toBe('hello world')
  })
})
