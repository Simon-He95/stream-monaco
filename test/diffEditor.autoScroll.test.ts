import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function installRafMocks() {
  vi.stubGlobal('requestAnimationFrame', (cb: any) => {
    return setTimeout(() => cb(Date.now()), 0) as unknown as number
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
  })
}

async function loadDiffEditorManager() {
  vi.resetModules()

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
        dispose() {},
      }
    }

    function createCodeEditor(initialModel: any) {
      let model = initialModel
      let scrollTop = 0
      const scrollListeners = new Set<(e: any) => void>()
      const domNode = {
        addEventListener() {},
        removeEventListener() {},
      }

      const api: any = {
        revealCalls: [] as Array<{ line: number }>,
        getModel() {
          return model
        },
        setModel(next: any) {
          model = next
        },
        getOption(option: string) {
          if (option === editor.EditorOption.lineHeight)
            return 20
          if (option === editor.EditorOption.readOnly)
            return true
          return undefined
        },
        getLayoutInfo() {
          return { height: 40 }
        },
        getScrollTop() {
          return scrollTop
        },
        getScrollHeight() {
          return model.getLineCount() * 20
        },
        setScrollTop(next: number) {
          scrollTop = next
          scrollListeners.forEach(listener => listener({ scrollTop }))
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
        revealLine(line: number) {
          api.revealCalls.push({ line })
          scrollTop = Math.max(0, api.getScrollHeight() - api.getLayoutInfo().height)
        },
        revealLineInCenter(line: number) {
          api.revealLine(line)
        },
        revealLineInCenterIfOutsideViewport(line: number) {
          api.revealLine(line)
        },
        getDomNode() {
          return domNode as any
        },
        dispose() {},
      }

      return api
    }

    const editor = {
      EditorOption: {
        lineHeight: 'lineHeight',
        readOnly: 'readOnly',
      },
      ScrollType: {
        Immediate: 0,
        Smooth: 1,
      },
      createModel: vi.fn((value: string, language: string) =>
        createModel(value, language)),
      createDiffEditor: vi.fn(() => {
        const originalEditor = createCodeEditor(createModel('', 'plaintext'))
        const modifiedEditor = createCodeEditor(createModel('', 'plaintext'))
        const updateDiffListeners = new Set<() => void>()

        return {
          setModel(pair: { original: any, modified: any }) {
            originalEditor.setModel(pair.original)
            modifiedEditor.setModel(pair.modified)
            updateDiffListeners.forEach(listener => listener())
          },
          getOriginalEditor() {
            return originalEditor
          },
          getModifiedEditor() {
            return modifiedEditor
          },
          onDidUpdateDiff(listener: () => void) {
            updateDiffListeners.add(listener)
            return {
              dispose() {
                updateDiffListeners.delete(listener)
              },
            }
          },
          updateOptions() {},
          dispose() {},
        }
      }),
      setTheme: vi.fn(),
      setModelLanguage: vi.fn((model: any, language: string) => {
        model.setLanguageId(language)
      }),
    }

    return {
      default: { editor, Range, ScrollType: editor.ScrollType },
      editor,
      Range,
      ScrollType: editor.ScrollType,
    }
  })

  return await import('../src/core/DiffEditorManager')
}

async function createManager() {
  const { DiffEditorManager } = await loadDiffEditorManager()
  const manager = new DiffEditorManager(
    {
      readOnly: true,
      hideUnchangedRegions: false,
      diffHunkActionsOnHover: false,
    } as any,
    40,
    '40px',
    true,
    true,
    0,
    0,
    true,
  )

  ;(manager as any).disposeDiffPresentationTracking = () => {}
  ;(manager as any).setupDiffUnchangedRegionEnhancements = () => {}
  ;(manager as any).setupDiffHunkInteractions = () => {}
  ;(manager as any).applyDiffRootAppearanceClass = () => {}
  ;(manager as any).scheduleSyncDiffPresentationDecorations = () => {}

  const container = {
    style: {},
    innerHTML: '',
  } as any

  await manager.createDiffEditor(
    container,
    'a\nb\nc',
    'a\nb\nc',
    'javascript',
    'test-theme',
  )
  await vi.runAllTimersAsync()

  return {
    manager: manager as any,
    modifiedEditor: (manager as any).diffEditorView.getModifiedEditor() as any,
  }
}

describe('DiffEditorManager auto-scroll pause', () => {
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

  it('keeps diff auto-scroll paused after the user scrolls up', async () => {
    const { manager, modifiedEditor } = await createManager()

    expect(modifiedEditor.revealCalls).toHaveLength(1)

    modifiedEditor.setScrollTop(0)
    expect(manager.shouldAutoScrollDiff).toBe(false)

    manager.appendModified('\nd')
    await vi.runAllTimersAsync()
    expect(manager.shouldAutoScrollDiff).toBe(false)

    const revealCountAfterPause = modifiedEditor.revealCalls.length
    manager.appendModified('\ne')
    await vi.runAllTimersAsync()

    expect(manager.shouldAutoScrollDiff).toBe(false)
    expect(modifiedEditor.revealCalls).toHaveLength(revealCountAfterPause)
  })

  it('does not let delayed diff reveals resume auto-scroll after pause', async () => {
    const { manager } = await createManager()

    manager.shouldAutoScrollDiff = false
    manager.revealTicketDiff = 1
    manager.performRevealDiffTicketed(4, 1)
    await vi.runAllTimersAsync()
    expect(manager.shouldAutoScrollDiff).toBe(false)

    manager.shouldAutoScrollDiff = false
    manager.revealTicketDiff = 2
    manager.performImmediateRevealDiff(4, 2)
    expect(manager.shouldAutoScrollDiff).toBe(false)
  })
})
