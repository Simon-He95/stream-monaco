import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/monaco-shim', () => {
  class Range {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  }

  return {
    default: { editor: { EditorOption: { lineHeight: 'lineHeight' } }, Range },
    editor: { EditorOption: { lineHeight: 'lineHeight' } },
    Range,
  }
})

import { DiffEditorManager } from '../src/core/DiffEditorManager'

function createClassList() {
  const classes = new Set<string>()
  return {
    classList: {
      toggle(name: string, force?: boolean) {
        if (force)
          classes.add(name)
        else classes.delete(name)
      },
      remove(...names: string[]) {
        names.forEach(name => classes.delete(name))
      },
      contains(name: string) {
        return classes.has(name)
      },
    },
  }
}

function createToggleClassList(initial: string[] = []) {
  const classes = new Set(initial)
  return {
    classList: {
      add(...names: string[]) {
        names.forEach(name => classes.add(name))
      },
      remove(...names: string[]) {
        names.forEach(name => classes.delete(name))
      },
      toggle(name: string, force?: boolean) {
        if (force === undefined) {
          if (classes.has(name)) {
            classes.delete(name)
            return false
          }
          classes.add(name)
          return true
        }
        if (force)
          classes.add(name)
        else classes.delete(name)
        return force
      },
      contains(name: string) {
        return classes.has(name)
      },
    },
  }
}

function createPresentationHarness(
  preserveNativeDiffDecorationsOnStaleAppend: boolean,
) {
  const manager = new DiffEditorManager(
    { readOnly: true } as any,
    600,
    '600px',
    true,
    true,
    32,
    2,
    true,
    75,
  )

  const { classList } = createClassList()
  const originalDeltaDecorations = vi.fn((_: string[], next: unknown[]) =>
    next.map((_, index) => `original-${index}`))
  const modifiedDeltaDecorations = vi.fn((_: string[], next: unknown[]) =>
    next.map((_, index) => `modified-${index}`))

  ;(manager as any).lastContainer = { classList }
  ;(manager as any).isDiffInlineMode = () => false
  ;(manager as any).diffComputedVersions = { original: 1, modified: 1 }
  ;(manager as any).preserveNativeDiffDecorationsOnStaleAppend
    = preserveNativeDiffDecorationsOnStaleAppend
  ;(manager as any).originalModel = {
    getAlternativeVersionId: () => 2,
    getValue: () => 'const value = 1\nreturn value',
  }
  ;(manager as any).modifiedModel = {
    getAlternativeVersionId: () => 2,
    getValue: () => 'const value = 2\nreturn value\nconsole.log(value)',
  }
  ;(manager as any).diffEditorView = {
    getLineChanges: () => [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 1,
        charChanges: [],
      },
    ],
    getOriginalEditor: () => ({
      deltaDecorations: originalDeltaDecorations,
    }),
    getModifiedEditor: () => ({
      deltaDecorations: modifiedDeltaDecorations,
    }),
  }

  return {
    manager,
    classList,
    originalDeltaDecorations,
    modifiedDeltaDecorations,
  }
}

describe('DiffEditorManager diff presentation', () => {
  it('forces glyph margin when unchanged-region folding is enabled', () => {
    const manager = new DiffEditorManager(
      { readOnly: true, glyphMargin: false } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      true,
      75,
    )

    const options = (manager as any).resolveDiffPresentationEditorOptions({
      enabled: true,
    })
    const disabledOptions = (manager as any).resolveDiffPresentationEditorOptions({
      enabled: false,
    })

    expect(options.glyphMargin).toBe(true)
    expect(disabledOptions.glyphMargin).toBe(false)
  })

  it('hides the native fold glyph that overlaps the folded inline summary row', () => {
    const manager = new DiffEditorManager(
      { readOnly: true } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      true,
      75,
    )

    const modifiedCenter = {
      ...createToggleClassList(),
      getBoundingClientRect: () => ({
        top: 120,
        height: 32,
        width: 220,
      }),
    }
    const overlappingGlyph = {
      ...createToggleClassList(),
      getBoundingClientRect: () => ({
        top: 127,
        height: 18,
      }),
    }
    const distantGlyph = {
      ...createToggleClassList(),
      getBoundingClientRect: () => ({
        top: 180,
        height: 18,
      }),
    }

    ;(manager as any).lastContainer = {
      querySelectorAll(selector: string) {
        if (selector === '.diff-hidden-lines .center')
          return [modifiedCenter]
        if (selector === '.editor.modified .diff-hidden-lines .center')
          return [modifiedCenter]
        if (selector === '.diff-hidden-lines .top, .diff-hidden-lines .bottom')
          return []
        if (selector === '.fold-unchanged')
          return [overlappingGlyph, distantGlyph]
        return []
      },
    }
    ;(manager as any).applyDiffRootAppearanceClass = vi.fn()
    ;(manager as any).syncDiffUnchangedViewZoneHeights = vi.fn(() => false)
    ;(manager as any).patchDiffUnchangedCenter = vi.fn()
    ;(manager as any).clearDiffUnchangedBridgeSources = vi.fn()
    ;(manager as any).renderMergedDiffUnchangedBridge = vi.fn(() => null)
    ;(manager as any).pruneDiffUnchangedBridgeEntries = vi.fn()
    ;(manager as any).syncDiffUnchangedOverlayScrollBaseline = vi.fn()
    ;(manager as any).patchDiffUnchangedFoldGlyph = vi.fn()

    ;(manager as any).scanAndPatchDiffUnchangedRegions()

    expect(
      overlappingGlyph.classList.contains('stream-monaco-fold-unchanged-hidden'),
    ).toBe(true)
    expect(
      distantGlyph.classList.contains('stream-monaco-fold-unchanged-hidden'),
    ).toBe(false)
  })

  it('does not overwrite persisted unchanged state while folding is disabled', () => {
    const manager = new DiffEditorManager(
      { readOnly: true } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      true,
      75,
    )

    ;(manager as any).diffPersistedUnchangedModelState = { collapsed: true }
    ;(manager as any).diffHideUnchangedRegionsResolved = { enabled: false }
    ;(manager as any).diffEditorView = {
      saveViewState: () => ({
        modelState: { expanded: true },
      }),
    }

    ;(manager as any).capturePersistedDiffUnchangedState()

    expect((manager as any).diffPersistedUnchangedModelState).toEqual({
      collapsed: true,
    })
  })

  it('restores the previous unchanged state instead of collapsing all context', () => {
    const manager = new DiffEditorManager(
      { readOnly: true } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      true,
      75,
    )
    const restoreViewState = vi.fn()

    ;(manager as any).diffPreviousUnchangedModelState = {
      hiddenAreas: [{ startLineNumber: 7, endLineNumber: 25 }],
    }
    ;(manager as any).diffEditorView = {
      saveViewState: () => ({
        original: { scrollTop: 10 },
        modified: { scrollTop: 10 },
        modelState: { hiddenAreas: [] },
      }),
      restoreViewState,
    }
    ;(manager as any).applyPendingDiffScrollRestore = vi.fn()

    const restored = (manager as any).restorePreviousDiffUnchangedState()

    expect(restored).toBe(true)
    expect(restoreViewState).toHaveBeenCalledWith({
      original: { scrollTop: 10 },
      modified: { scrollTop: 10 },
      modelState: { hiddenAreas: [{ startLineNumber: 7, endLineNumber: 25 }] },
    })
    expect((manager as any).diffPersistedUnchangedModelState).toEqual({
      hiddenAreas: [{ startLineNumber: 7, endLineNumber: 25 }],
    })
  })

  it('recomputes unchanged-region folding without restoring the stale model state', () => {
    const manager = new DiffEditorManager(
      { readOnly: true } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      true,
      75,
    )
    const setDiffModels = vi.fn()

    ;(manager as any).originalModel = { getValue: () => 'a' }
    ;(manager as any).modifiedModel = { getValue: () => 'b' }
    ;(manager as any).diffEditorView = {
      updateOptions: vi.fn(),
    }
    ;(manager as any).diffHideUnchangedRegionsDeferred = false
    ;(manager as any).diffHideUnchangedRegionsResolved = { enabled: false }
    ;(manager as any).resolveDiffHideUnchangedRegionsOption = () => ({ enabled: true })
    ;(manager as any).resolveDiffPresentationEditorOptions = () => ({})
    ;(manager as any).withLockedDiffScrollPosition = (fn: () => void) => fn()
    ;(manager as any).diffHeightManager = { update: vi.fn() }
    ;(manager as any).applyDiffRootAppearanceClass = vi.fn()
    ;(manager as any).schedulePatchDiffUnchangedRegionsAfterInteraction = vi.fn()
    ;(manager as any).repositionDiffHunkNodes = vi.fn()
    ;(manager as any).setDiffModels = setDiffModels

    ;(manager as any).refreshDiffPresentation()

    expect(setDiffModels).toHaveBeenCalledWith(
      {
        original: (manager as any).originalModel,
        modified: (manager as any).modifiedModel,
      },
      {
        preserveViewState: true,
        preserveModelState: false,
      },
    )
  })

  it('preserves scroll state without restoring the saved model state when requested', async () => {
    const manager = new DiffEditorManager(
      { readOnly: true } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      true,
      75,
    )
    const restoreViewState = vi.fn()
    const setModel = vi.fn()
    const waitForDiff = vi.fn(async () => {})
    const preparedViewModel = {
      waitForDiff,
      dispose: vi.fn(),
    }
    const originalModel = {
      getValue: () => 'const a = 1',
      getLineCount: () => 1,
      getLanguageId: () => 'ts',
    }
    const modifiedModel = {
      getValue: () => 'const b = 2',
      getLineCount: () => 1,
      getLanguageId: () => 'ts',
    }

    ;(manager as any).originalModel = originalModel
    ;(manager as any).modifiedModel = modifiedModel
    ;(manager as any).originalModelOwned = false
    ;(manager as any).modifiedModelOwned = false
    ;(manager as any).captureDiffScrollPosition = () => null
    ;(manager as any).captureModifiedViewportAnchor = () => null
    ;(manager as any).queuePendingDiffScrollRestore = vi.fn()
    ;(manager as any).withLockedDiffScrollPosition = (fn: () => void) => fn()
    ;(manager as any).flushOriginalAppendBufferSync = vi.fn()
    ;(manager as any).flushModifiedAppendBufferSync = vi.fn()
    ;(manager as any).computedHeight = () => 0
    ;(manager as any).getEffectiveLineChanges = () => []
    ;(manager as any).hideDiffHunkActions = vi.fn()
    ;(manager as any).clearDiffUnchangedBridgeOverlay = vi.fn()
    ;(manager as any).syncDiffUnchangedViewZoneHeights = vi.fn()
    ;(manager as any).refreshDiffPresentation = vi.fn()
    ;(manager as any).scheduleSyncDiffPresentationDecorations = vi.fn()
    ;(manager as any).applyPendingDiffScrollRestore = vi.fn()
    ;(manager as any).scheduleRestoreModifiedViewportAnchor = vi.fn()
    ;(manager as any).disposePreviousDiffModel = vi.fn()
    ;(manager as any).diffEditorView = {
      createViewModel: vi.fn(() => preparedViewModel),
      setModel,
      saveViewState: vi.fn(() => ({
        original: { scrollTop: 10 },
        modified: { scrollTop: 10 },
        modelState: { hiddenAreas: [{ startLineNumber: 4, endLineNumber: 20 }] },
      })),
      restoreViewState,
      getModifiedEditor: () => ({
        getScrollHeight: () => 0,
        getOption: () => 18,
      }),
    }

    await (manager as any).setDiffModels(
      {
        original: originalModel,
        modified: modifiedModel,
      },
      {
        preserveViewState: true,
        preserveModelState: false,
      },
    )

    expect(waitForDiff).toHaveBeenCalled()
    expect(setModel).toHaveBeenCalled()
    expect(restoreViewState).not.toHaveBeenCalled()
  })

  it('keeps native diff blocks visible while stale during tail appends', () => {
    const {
      manager,
      classList,
      originalDeltaDecorations,
      modifiedDeltaDecorations,
    } = createPresentationHarness(true)

    ;(manager as any).syncDiffPresentationDecorations()

    expect(classList.contains('stream-monaco-diff-native-stale')).toBe(false)
    expect(originalDeltaDecorations).toHaveBeenCalledOnce()
    expect(modifiedDeltaDecorations).toHaveBeenCalledOnce()
    expect(originalDeltaDecorations.mock.calls[0][1]).not.toHaveLength(0)
    expect(modifiedDeltaDecorations.mock.calls[0][1]).not.toHaveLength(0)
  })

  it('keeps native diff blocks visible when only the DOM still has stale native markers', () => {
    const { manager, classList } = createPresentationHarness(true)

    ;(manager as any).diffEditorView.getLineChanges = () => null
    ;(manager as any).lastContainer.querySelector = vi.fn(() => ({}))

    ;(manager as any).syncDiffPresentationDecorations()

    expect(classList.contains('stream-monaco-diff-native-stale')).toBe(false)
  })

  it('still hides native diff blocks for non-append stale updates', () => {
    const { manager, classList } = createPresentationHarness(false)

    ;(manager as any).syncDiffPresentationDecorations()

    expect(classList.contains('stream-monaco-diff-native-stale')).toBe(true)
  })

  it('adds fallback inline delete zones while native inline diff is stale', () => {
    const createdNodes: Array<{
      className: string
      style: Record<string, string>
      children: any[]
      append: (...nodes: any[]) => void
      setAttribute: () => void
      textContent: string
    }> = []
    const originalDocument = (globalThis as any).document
    ;(globalThis as any).document = {
      createElement() {
        const node = {
          className: '',
          style: {} as Record<string, string>,
          children: [] as any[],
          append(...next: any[]) {
            this.children.push(...next)
          },
          setAttribute() {},
          textContent: '',
        }
        createdNodes.push(node)
        return node
      },
    }

    try {
      const { manager, classList } = createPresentationHarness(true)
      const addedZones: any[] = []
      const removedZoneIds: string[] = []
      const applyFontInfo = vi.fn()

      ;(manager as any).isDiffInlineMode = () => true
      ;(manager as any).clearFallbackInlineDeletedZones = DiffEditorManager.prototype[
        'clearFallbackInlineDeletedZones'
      ]
      ;(manager as any).originalModel = {
        getAlternativeVersionId: () => 2,
        getValue: () => 'const value = 1\nreturn value',
        getLineContent: (line: number) =>
          ['const value = 1', 'return value'][line - 1] ?? '',
      }
      ;(manager as any).modifiedModel = {
        getAlternativeVersionId: () => 2,
        getValue: () => 'const value = 2\nreturn value',
        getLineCount: () => 2,
      }
      ;(manager as any).diffEditorView = {
        getLineChanges: () => null,
        getOriginalEditor: () => ({
          deltaDecorations: vi.fn((_: string[], next: unknown[]) =>
            next.map((_, index) => `original-${index}`)),
        }),
        getModifiedEditor: () => ({
          deltaDecorations: vi.fn((_: string[], next: unknown[]) =>
            next.map((_, index) => `modified-${index}`)),
          getModel: () => (manager as any).modifiedModel,
          getOption: () => 20,
          applyFontInfo,
          changeViewZones(callback: (accessor: {
            addZone: (zone: any) => string
            removeZone: (id: string) => void
          }) => void) {
            callback({
              addZone(zone) {
                addedZones.push(zone)
                return `zone-${addedZones.length}`
              },
              removeZone(id) {
                removedZoneIds.push(id)
              },
            })
          },
        }),
      }

      ;(manager as any).syncDiffPresentationDecorations()

      expect(classList.contains('stream-monaco-diff-native-stale')).toBe(true)
      expect(addedZones).toHaveLength(1)
      expect(addedZones[0].afterLineNumber).toBe(0)
      expect(addedZones[0].heightInLines).toBe(1)
      expect(addedZones[0].domNode.className).toBe(
        'stream-monaco-fallback-inline-delete-zone',
      )
      expect(addedZones[0].domNode.children).toHaveLength(1)
      expect(addedZones[0].domNode.children[0].textContent).toBe(
        'const value = 1',
      )
      expect(applyFontInfo).toHaveBeenCalledWith(addedZones[0].domNode)
      expect(applyFontInfo).toHaveBeenCalledWith(addedZones[0].marginDomNode)
      expect(removedZoneIds).toHaveLength(0)
      expect(createdNodes.length).toBeGreaterThan(0)
    }
    finally {
      ;(globalThis as any).document = originalDocument
    }
  })

  it('clears fallback inline delete zones as soon as native inline delete zones appear', () => {
    const originalDocument = (globalThis as any).document
    const originalHTMLElement = (globalThis as any).HTMLElement
    class FakeElement {
      constructor(public className: string) {}

      matches(selector: string) {
        return selector.split(',').some((entry) => {
          const parts = entry.trim().split('.').filter(Boolean)
          return parts.every(part => this.className.split(/\s+/).includes(part))
        })
      }

      querySelector() {
        return null
      }
    }
    ;(globalThis as any).HTMLElement = FakeElement
    ;(globalThis as any).document = {
      createElement() {
        return {
          className: '',
          style: {} as Record<string, string>,
          children: [] as any[],
          append() {},
          setAttribute() {},
          textContent: '',
        }
      },
    }

    try {
      const { manager, classList } = createPresentationHarness(true)
      const addedZones: any[] = []

      ;(manager as any).isDiffInlineMode = () => true
      ;(manager as any).inlineDiffStreamingPresentationActive = true
      ;(manager as any).hasFreshNativeDiffResult = () => false
      ;(manager as any).clearFallbackInlineDeletedZones = DiffEditorManager.prototype[
        'clearFallbackInlineDeletedZones'
      ]
      ;(manager as any).lastContainer = {
        classList,
        querySelectorAll(selector: string) {
          if (selector.includes('.editor.modified .view-zones [monaco-view-zone]'))
            return [new FakeElement('view-lines line-delete monaco-mouse-cursor-text')]
          if (selector.includes('.editor.modified .margin-view-zones [monaco-view-zone]'))
            return [new FakeElement('inline-deleted-margin-view-zone')]
          return []
        },
        querySelector: vi.fn(() => null),
      }
      ;(manager as any).originalModel = {
        getAlternativeVersionId: () => 2,
        getValue: () => 'const value = 1\nreturn value',
        getLineContent: (line: number) =>
          ['const value = 1', 'return value'][line - 1] ?? '',
      }
      ;(manager as any).modifiedModel = {
        getAlternativeVersionId: () => 2,
        getValue: () => 'const value = 2\nreturn value',
        getLineCount: () => 2,
      }
      ;(manager as any).diffEditorView = {
        getLineChanges: () => null,
        getOriginalEditor: () => ({
          deltaDecorations: vi.fn((_: string[], next: unknown[]) =>
            next.map((_, index) => `original-${index}`)),
        }),
        getModifiedEditor: () => ({
          deltaDecorations: vi.fn((_: string[], next: unknown[]) =>
            next.map((_, index) => `modified-${index}`)),
          getModel: () => (manager as any).modifiedModel,
          getOption: () => 20,
          changeViewZones(callback: (accessor: {
            addZone: (zone: any) => string
            removeZone: (id: string) => void
          }) => void) {
            callback({
              addZone(zone) {
                addedZones.push(zone)
                return `zone-${addedZones.length}`
              },
              removeZone() {},
            })
          },
        }),
      }

      ;(manager as any).syncDiffPresentationDecorations()

      expect(classList.contains('stream-monaco-diff-inline-native-ready')).toBe(true)
      expect(addedZones).toHaveLength(0)
    }
    finally {
      ;(globalThis as any).document = originalDocument
      ;(globalThis as any).HTMLElement = originalHTMLElement
    }
  })

  it('reuses native inline delete wrappers instead of adding another fallback zone', () => {
    class FakeElement {
      className = ''
      style: Record<string, string> = {}
      children: any[] = []
      attributes = new Map<string, string>()

      constructor(
        private readonly selectorMap: Record<string, unknown> = {},
      ) {}

      querySelector(selector: string) {
        return this.selectorMap[selector] ?? null
      }

      append(node: any) {
        this.children.push(node)
        node.parentElement = this
      }

      removeChild(node: any) {
        this.children = this.children.filter(child => child !== node)
      }

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value)
      }

      getAttribute(name: string) {
        return this.attributes.get(name) ?? null
      }
    }

    const originalDocument = (globalThis as any).document
    const originalHTMLElement = (globalThis as any).HTMLElement
    ;(globalThis as any).HTMLElement = FakeElement
    ;(globalThis as any).document = {
      createElement() {
        return new FakeElement()
      },
    }

    try {
      const { manager } = createPresentationHarness(true)
      const applyFontInfo = vi.fn()
      const nativeDeleteMarker = new FakeElement()
      nativeDeleteMarker.className = 'view-lines line-delete monaco-mouse-cursor-text'
      const nativeMarginMarker = new FakeElement()
      nativeMarginMarker.className = 'inline-deleted-margin-view-zone'
      const viewWrapper = new FakeElement({
        '.view-lines.line-delete': nativeDeleteMarker,
      })
      viewWrapper.style.top = '54px'
      viewWrapper.setAttribute('monaco-view-zone', 'native-1')
      const marginWrapper = new FakeElement({
        '.inline-deleted-margin-view-zone': nativeMarginMarker,
      })
      marginWrapper.style.top = '54px'
      marginWrapper.setAttribute('monaco-view-zone', 'native-1')

      ;(manager as any).lastContainer = {
        querySelectorAll(selector: string) {
          if (selector.includes('.editor.modified .view-zones [monaco-view-zone]'))
            return [viewWrapper]
          if (selector.includes('.editor.modified .margin-view-zones [monaco-view-zone]'))
            return [marginWrapper]
          return []
        },
      }
      ;(manager as any).diffEditorView = {
        getModifiedEditor: () => ({
          getModel: () => ({
            getLineCount: () => 4,
          }),
          getOption: () => 18,
          applyFontInfo,
          changeViewZones: vi.fn(),
        }),
      }
      ;(manager as any).originalModel = {
        getLineContent: () => '"version": "0.0.49",',
      }
      ;(manager as any).isDiffInlineMode = () => true

      ;(manager as any).syncFallbackInlineDeletedZones([
        {
          originalStartLineNumber: 1,
          originalEndLineNumber: 1,
          modifiedStartLineNumber: 4,
          modifiedEndLineNumber: 4,
          charChanges: [],
        },
      ])

      expect(viewWrapper.children).toHaveLength(1)
      expect(viewWrapper.children[0].className).toBe(
        'stream-monaco-fallback-inline-delete-zone',
      )
      expect(marginWrapper.children).toHaveLength(1)
      expect(marginWrapper.children[0].className).toBe(
        'stream-monaco-fallback-inline-delete-margin',
      )
    }
    finally {
      ;(globalThis as any).document = originalDocument
      ;(globalThis as any).HTMLElement = originalHTMLElement
    }
  })
})
