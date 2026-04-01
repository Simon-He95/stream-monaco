import { describe, expect, it, vi } from 'vitest'
import { EditorManager } from '../src/core/EditorManager'
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
    getPositionAt(offset: number) {
      return {
        lineNumber: 1,
        column: Math.max(1, offset + 1),
      }
    },
    dispose() {},
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
    0,
  )
  const scheduler = createManualScheduler()
  ;(manager as any).rafScheduler = scheduler
  const model = createStubModel('')
  const editorView = createStubCodeEditor(model)
  ;(manager as any).editorView = editorView
  ;(manager as any).lastKnownCode = ''
  return { manager, scheduler, model }
}

describe('buffered append races', () => {
  it('editor manager drops stale append buffers before an authoritative overwrite', () => {
    const { manager, scheduler, model } = createEditorManagerHarness()
    const overwrite = 'x'.repeat(16)

    manager.updateCode('a', 'plaintext')
    scheduler.run('update')
    expect(scheduler.has('append')).toBe(true)

    manager.updateCode(overwrite, 'plaintext')
    scheduler.run('update')
    scheduler.run('append')

    expect(model.getValue()).toBe(overwrite)
  })

  it('mock wrapper drops a buffered append before a later authoritative overwrite', () => {
    const immediates: Array<{ handle: number, fn: () => void }> = []
    let handleSeed = 1
    const overwrite = 'x'.repeat(16)
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
      wrapper.updateCode(overwrite)

      runNextImmediate()
      runNextImmediate()
      while (immediates.length > 0)
        runNextImmediate()

      expect(wrapper.model.getValue()).toBe(overwrite)
    }
    finally {
      globalThis.setImmediate = originalSetImmediate
      globalThis.clearImmediate = originalClearImmediate
    }
  })
})
