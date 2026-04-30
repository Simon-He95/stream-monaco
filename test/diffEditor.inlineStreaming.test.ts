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
      let alternativeVersionId = 1
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
        alternativeVersionId += 1
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
        getAlternativeVersionId() {
          return alternativeVersionId
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
      return {
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
          return { height: 200 }
        },
        getScrollTop() {
          return 0
        },
        getScrollHeight() {
          return model.getLineCount() * 20
        },
        setScrollTop() {},
        onDidContentSizeChange(listener: () => void) {
          return model.onDidContentSizeChange(listener)
        },
        onDidChangeModelContent(listener: () => void) {
          return model.onDidChangeContent(listener)
        },
        onDidScrollChange() {
          return { dispose() {} }
        },
        revealLine() {},
        revealLineInCenter() {},
        revealLineInCenterIfOutsideViewport() {},
        getDomNode() {
          return {
            addEventListener() {},
            removeEventListener() {},
          } as any
        },
        deltaDecorations() {
          return []
        },
        updateOptions() {},
        layout() {},
        dispose() {},
      }
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
          __emitUpdateDiff() {
            updateDiffListeners.forEach(listener => listener())
          },
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
          getLineChanges() {
            return []
          },
          updateOptions() {},
          getContainerDomNode() {
            return null as any
          },
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

async function createManager(options: Record<string, unknown>) {
  const { DiffEditorManager } = await loadDiffEditorManager()
  const manager = new DiffEditorManager(
    {
      readOnly: true,
      hideUnchangedRegions: false,
      diffHunkActionsOnHover: false,
      ...options,
    } as any,
    400,
    '400px',
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
    style: {} as Record<string, string>,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false },
    },
    innerHTML: '',
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    getBoundingClientRect() {
      return { width: 1200, height: 200 }
    },
    clientWidth: 1200,
  } as any

  await manager.createDiffEditor(
    container,
    'line 1\nline 2\n',
    'line 1\nline 2\n',
    'typescript',
    'vs-dark',
  )

  return manager as any
}

function waitForAsyncWork() {
  return new Promise(resolve => setTimeout(resolve, 10))
}

describe('DiffEditorManager inline streaming updates', () => {
  beforeEach(() => {
    installRafMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defers inline diff tail appends so both sides flush together', async () => {
    const manager = await createManager({ renderSideBySide: false })
    const appendOriginalSpy = vi.spyOn(manager, 'appendOriginal')
    const appendModifiedSpy = vi.spyOn(manager, 'appendModified')

    manager.updateDiff(
      'line 1\nline 2\nold value\n',
      'line 1\nline 2\nnew value\n',
      'typescript',
    )

    expect(appendOriginalSpy).not.toHaveBeenCalled()
    expect(appendModifiedSpy).not.toHaveBeenCalled()

    await waitForAsyncWork()

    const { original, modified } = manager.getDiffModels()
    expect(original.getValue()).toBe('line 1\nline 2\nold value\n')
    expect(modified.getValue()).toBe('line 1\nline 2\nnew value\n')
    manager.cleanup()
  })

  it('keeps side-by-side diff tail append optimization', async () => {
    const manager = await createManager({ renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false })
    const appendOriginalSpy = vi.spyOn(manager, 'appendOriginal')
    const appendModifiedSpy = vi.spyOn(manager, 'appendModified')

    manager.updateDiff(
      'line 1\nline 2\nold value\n',
      'line 1\nline 2\nnew value\n',
      'typescript',
    )

    expect(appendOriginalSpy).toHaveBeenCalledOnce()
    expect(appendModifiedSpy).toHaveBeenCalledOnce()
    await waitForAsyncWork()
    manager.cleanup()
  })

  it('keeps side-by-side diff streaming appends byte-for-byte aligned', async () => {
    const manager = await createManager({ renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false })
    const initial = 'line 1\nline 2\n'
    const originalTail = `{
  ".c": "C",
  ".cpp": "C++"
}`
    const modifiedTail = `{
  ".c": "C",
  ".cpp": "C++",
  ".cc": "C++"
}`

    for (let i = 1; i <= modifiedTail.length; i++) {
      const expectedOriginal = initial + originalTail.slice(0, Math.min(i, originalTail.length))
      const expectedModified = initial + modifiedTail.slice(0, i)
      manager.updateDiff(
        expectedOriginal,
        expectedModified,
        'json',
      )
      await waitForAsyncWork()
      const { original, modified } = manager.getDiffModels()
      expect(expectedOriginal.startsWith(original.getValue())).toBe(true)
      expect(expectedModified.startsWith(modified.getValue())).toBe(true)
    }
    await new Promise(resolve => setTimeout(resolve, 80))

    const { original, modified } = manager.getDiffModels()
    expect(original.getValue()).toBe(initial + originalTail)
    expect(modified.getValue()).toBe(initial + modifiedTail)
    manager.cleanup()
  })

  it('flushes pending replacement updates before refreshing diff presentation', async () => {
    const manager = await createManager({ renderSideBySide: false })
    ;(manager as any).lastContainer.style.removeProperty = vi.fn()

    manager.updateDiff(
      'line 1\nold value\n',
      'line 1\nnew value\n',
      'typescript',
    )

    ;(manager as any).refreshDiffPresentation()

    const { original, modified } = manager.getDiffModels()
    expect(original.getValue()).toBe('line 1\nold value\n')
    expect(modified.getValue()).toBe('line 1\nnew value\n')
    manager.cleanup()
  })

  it('flushes buffered tail appends before refreshing diff presentation', async () => {
    const manager = await createManager({ renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false })
    ;(manager as any).lastContainer.style.removeProperty = vi.fn()

    manager.updateDiff(
      'line 1\nline 2\nold value\n',
      'line 1\nline 2\nnew value\n',
      'typescript',
    )

    ;(manager as any).refreshDiffPresentation()

    const { original, modified } = manager.getDiffModels()
    expect(original.getValue()).toBe('line 1\nline 2\nold value\n')
    expect(modified.getValue()).toBe('line 1\nline 2\nnew value\n')
    manager.cleanup()
  })

  it('eagerly grows the diff container before content overflows the inline diff viewport', async () => {
    const manager = await createManager({ renderSideBySide: false })
    const scheduleLayoutSpy = vi.spyOn(
      manager,
      'scheduleSyncDiffEditorLayoutToContainer' as any,
    )

    ;(manager as any).lastContainer = {
      style: { height: '91px' },
      classList: {
        add() {},
        remove() {},
        contains() { return false },
        toggle() {},
      },
      getBoundingClientRect() {
        return { width: 1200, height: 91 }
      },
      clientHeight: 91,
      querySelectorAll() {
        return []
      },
    }
    vi.spyOn(manager, 'computedHeight' as any).mockReturnValue(109)

    ;(manager as any).eagerlyGrowDiffContainerHeight()

    expect((manager as any).lastContainer.style.height).toBe('109px')
    expect(scheduleLayoutSpy).toHaveBeenCalledOnce()
    manager.cleanup()
  })

  it('does not force a large min-height for inline diff containers', async () => {
    const manager = await createManager({ renderSideBySide: false })

    expect((manager as any).lastContainer.style.minHeight || '').toBe('')

    manager.cleanup()
  })

  it('does not clear fallback inline delete zones directly from onDidUpdateDiff', async () => {
    const manager = await createManager({ renderSideBySide: false })
    const clearSpy = vi.spyOn(manager, 'clearFallbackInlineDeletedZones' as any)

    ;(manager as any).diffEditorView.__emitUpdateDiff()

    expect(clearSpy).not.toHaveBeenCalled()
    manager.cleanup()
  })

  it('keeps inline fallback decorations until native delete nodes are present', async () => {
    const manager = await createManager({ renderSideBySide: false })
    const keepFallbackSpy = vi.spyOn(manager, 'syncFallbackInlineDeletedZones' as any)
    const clearFallbackSpy = vi.spyOn(
      manager,
      'clearFallbackDiffDecorations' as any,
    )
    vi.spyOn(manager, 'hasFreshNativeDiffResult' as any).mockReturnValue(true)
    vi.spyOn(manager, 'getEffectiveLineChanges' as any).mockReturnValue([
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
        charChanges: [],
      },
    ])
    ;(manager as any).diffEditorView.getOriginalEditor().getLayoutInfo = () => ({
      width: 0,
      height: 200,
    })

    ;(manager as any).syncDiffPresentationDecorations()

    expect(keepFallbackSpy).toHaveBeenCalledOnce()
    expect(clearFallbackSpy).not.toHaveBeenCalled()
    manager.cleanup()
  })

  it('does not recreate identical inline fallback delete zones', async () => {
    const manager = await createManager({ renderSideBySide: false })
    const originalDocument = (globalThis as any).document
    ;(globalThis as any).document = {
      createElement() {
        return {
          className: '',
          style: {} as Record<string, string>,
          children: [] as any[],
          append(...nodes: any[]) {
            this.children.push(...nodes)
          },
          setAttribute() {},
          textContent: '',
        }
      },
    }
    try {
      const addedZones: string[] = []
      const removedZones: string[] = []
      const modifiedEditor = (manager as any).diffEditorView.getModifiedEditor()

      modifiedEditor.changeViewZones = (callback: (accessor: {
        addZone: (zone: any) => string
        removeZone: (id: string) => void
      }) => void) => {
        callback({
          addZone() {
            const id = `zone-${addedZones.length + 1}`
            addedZones.push(id)
            return id
          },
          removeZone(id: string) {
            removedZones.push(id)
          },
        })
      }
      modifiedEditor.layout = vi.fn()
      modifiedEditor.render = vi.fn()

      vi.spyOn(manager, 'hasFreshNativeDiffResult' as any).mockReturnValue(false)
      vi.spyOn(manager, 'getEffectiveLineChanges' as any).mockReturnValue([
        {
          originalStartLineNumber: 2,
          originalEndLineNumber: 2,
          modifiedStartLineNumber: 2,
          modifiedEndLineNumber: 2,
          charChanges: [],
        },
      ])
      ;(manager as any).diffEditorView.getOriginalEditor().getLayoutInfo = () => ({
        width: 0,
        height: 200,
      })

      ;(manager as any).syncDiffPresentationDecorations()
      ;(manager as any).syncDiffPresentationDecorations()

      expect(addedZones).toHaveLength(1)
      expect(removedZones).toHaveLength(0)
      manager.cleanup()
    }
    finally {
      ;(globalThis as any).document = originalDocument
    }
  })
})
