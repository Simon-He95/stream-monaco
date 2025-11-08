import { describe, expect, it, vi } from 'vitest'
import { EditorManager } from '../src/core/EditorManager'
import { DiffEditorManager } from '../src/core/DiffEditorManager'
import { createMockWrapper } from './mockWrapper'

vi.mock('../src/monaco-shim', () => {
  const editor = {
    EditorOption: { lineHeight: 16, readOnly: 0 },
    ScrollType: { Smooth: 1 },
    setModelLanguage: vi.fn(),
  }
  class Range {
    constructor(
      public lineNumber: number,
      public column: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  }
  return {
    default: { editor, Range, languages: { getLanguages: () => [] } },
    editor,
    Range,
    languages: { getLanguages: () => [] },
  }
})

function createManualScheduler() {
  const callbacks = new Map<string, FrameRequestCallback>()
  return {
    schedule: vi.fn((kind: string, cb: FrameRequestCallback) => {
      callbacks.set(kind, cb)
    }),
    cancel: vi.fn((kind: string) => {
      callbacks.delete(kind)
    }),
    run(kind: string) {
      const cb = callbacks.get(kind)
      if (!cb)
        return
      callbacks.delete(kind)
      cb(0 as unknown as DOMHighResTimeStamp)
    },
    has(kind: string) {
      return callbacks.has(kind)
    },
  }
}

function createStubModel(initial = '') {
  let value = initial
  return {
    getValue() {
      return value
    },
    setValue(v: string) {
      value = v
    },
    getLineCount() {
      return Math.max(1, value.split('\n').length)
    },
    getLineMaxColumn(line: number) {
      const lines = value.split('\n')
      const idx = Math.max(0, Math.min(line - 1, lines.length - 1))
      return (lines[idx]?.length ?? 0) + 1
    },
    getLanguageId() {
      return 'plaintext'
    },
    applyEdits(edits: Array<{ text: string }>) {
      for (const edit of edits)
        value = value + edit.text
    },
    dispose() {},
    valueOf() {
      return value
    },
  }
}

function createStubCodeEditor(model: ReturnType<typeof createStubModel>) {
  return {
    getModel() {
      return model
    },
    getOption() {
      return false
    },
    executeEdits: vi.fn((_source: string, edits: Array<{ text: string }>) => {
      for (const edit of edits)
        model.setValue(model.getValue() + edit.text)
    }),
    getScrollHeight: () => 0,
    getScrollTop: () => 0,
    getLayoutInfo: () => ({ height: 0 }),
  }
}

function createEditorManagerHarness() {
  const manager = new EditorManager(
    { readOnly: false } as any,
    600,
    '600px',
    true,
    true,
    32,
    2,
    75,
  )
  const scheduler = createManualScheduler()
  ;(manager as any).rafScheduler = scheduler
  const model = createStubModel('')
  const editorView = createStubCodeEditor(model)
  ;(manager as any).editorView = editorView
  ;(manager as any).lastKnownCode = ''
  return { manager, scheduler, model }
}

function createDiffEditorManagerHarness() {
  const manager = new DiffEditorManager(
    { readOnly: false } as any,
    600,
    '600px',
    true,
    true,
    32,
    2,
    false,
    75,
  )
  const scheduler = createManualScheduler()
  ;(manager as any).rafScheduler = scheduler
  const originalModel = createStubModel('')
  const modifiedModel = createStubModel('')
  const originalEditor = {
    getModel: () => originalModel,
    getOption: () => 16,
    getScrollHeight: () => 0,
    getScrollTop: () => 0,
    getLayoutInfo: () => ({ height: 0 }),
    revealLine: vi.fn(),
    revealLineInCenter: vi.fn(),
    revealLineInCenterIfOutsideViewport: vi.fn(),
  }
  const modifiedEditor = {
    getModel: () => modifiedModel,
    getOption: () => 16,
    getScrollHeight: () => 0,
    getScrollTop: () => 0,
    getLayoutInfo: () => ({ height: 0 }),
    revealLine: vi.fn(),
    revealLineInCenter: vi.fn(),
    revealLineInCenterIfOutsideViewport: vi.fn(),
  }
  const diffEditorView = {
    getOriginalEditor: () => originalEditor,
    getModifiedEditor: () => modifiedEditor,
    dispose: () => {},
  }
  ;(manager as any).diffEditorView = diffEditorView
  ;(manager as any).originalModel = originalModel
  ;(manager as any).modifiedModel = modifiedModel
  return { manager, scheduler, modifiedModel }
}

describe('buffered append races', () => {
  it('editor manager discards stale append buffers before processing next update', () => {
    const { manager, scheduler, model } = createEditorManagerHarness()
    manager.updateCode('a', 'plaintext')
    scheduler.run('update')
    expect(scheduler.has('append')).toBe(true)

    manager.updateCode('ab', 'plaintext')
    scheduler.run('update')
    // append task should still exist but only contain the latest suffix
    scheduler.run('append')

    expect(model.getValue()).toBe('ab')
  })

  it('diff manager drops buffered modified chunks before applying pending diff', () => {
    const { manager, scheduler, modifiedModel } = createDiffEditorManagerHarness()
    manager.appendModified('a')
    expect(scheduler.has('appendDiff')).toBe(true)

    ;(manager as any).pendingDiffUpdate = { original: '', modified: 'ab' }
    ;(manager as any).flushPendingDiffUpdate()

    expect(modifiedModel.getValue()).toBe('ab')
    expect((manager as any).appendBufferDiff.length).toBe(0)
    expect(scheduler.has('appendDiff')).toBe(false)
  })

  it('mock wrapper reproduction drops buffered append before next update flush', () => {
    const immediates: Array<{ handle: number, fn: () => void }> = []
    let handleSeed = 1
    const originalSetImmediate = globalThis.setImmediate
    const originalClearImmediate = globalThis.clearImmediate

    globalThis.setImmediate = ((fn: (...args: any[]) => void) => {
      const handle = handleSeed++
      immediates.push({ handle, fn: () => fn() })
      return handle as unknown as ReturnType<typeof setImmediate>
    }) as typeof setImmediate

    globalThis.clearImmediate = ((handle: ReturnType<typeof setImmediate>) => {
      const idx = immediates.findIndex(entry => entry.handle === (handle as unknown as number))
      if (idx !== -1)
        immediates.splice(idx, 1)
    }) as typeof clearImmediate

    const runNextImmediate = () => {
      const entry = immediates.shift()
      if (entry)
        entry.fn()
    }

    try {
      const wrapper = createMockWrapper({ updateThrottleMs: 0 })
      wrapper.updateCode('a')
      runNextImmediate() // flush pending update -> schedule append
      expect(immediates.length).toBe(1)

      wrapper.updateCode('ab')
      runNextImmediate() // flush next update, dropping the buffered chunk
      while (immediates.length > 0)
        runNextImmediate()

      expect(wrapper.model.getValue()).toBe('ab')
    }
    finally {
      globalThis.setImmediate = originalSetImmediate
      globalThis.clearImmediate = originalClearImmediate
    }
  })
})
