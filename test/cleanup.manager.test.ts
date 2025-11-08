import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/monaco-shim', () => {
  class Range {
    constructor(
      public lineNumber: number,
      public column: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  }
  const editor = {
    EditorOption: { lineHeight: 16, readOnly: 0 },
    ScrollType: { Smooth: 1 },
    setModelLanguage: vi.fn(),
  }
  return {
    default: { editor, Range, languages: { getLanguages: () => [] } },
    editor,
    Range,
    languages: { getLanguages: () => [] },
  }
})

import { EditorManager } from '../src/core/EditorManager'
import { DiffEditorManager } from '../src/core/DiffEditorManager'

// These suites focus solely on verifying that cleanup()/safeClean() cancel every
// RAF kind and timeout identified in analysis/cleanup-gaps.md. They stub the
// rafScheduler and timers rather than exercising real Monaco instances or RAF
// execution order, so they intentionally do not cover append flushing, DOM work,
// or reentrancy timing quirks.

const EDITOR_RAF_KINDS = [
  'maybe-scroll',
  'reveal',
  'maybe-resume',
  'content-size-change',
  'sync-last-known',
  'update',
  'append',
] as const

const DIFF_RAF_KINDS = [
  'maybe-scroll-diff',
  'revealDiff',
  'maybe-resume-diff',
  'content-size-change-diff',
  'sync-last-known-modified',
  'diff',
  'appendDiff',
] as const

function createEditorManager() {
  return new EditorManager(
    { readOnly: true } as any,
    600,
    '600px',
    true,
    true,
    32,
    2,
    75,
  )
}

function createDiffEditorManager() {
  return new DiffEditorManager(
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
}

function stubRafScheduler(instance: any) {
  const cancel = vi.fn()
  instance.rafScheduler = { schedule: vi.fn(), cancel }
  return cancel
}

function setTimerHandles(instance: any, debounceKey: string, idleKey: string) {
  const debounceHandle = { [debounceKey]: true } as unknown as ReturnType<typeof setTimeout>
  const idleHandle = { [idleKey]: true } as unknown as ReturnType<typeof setTimeout>
  instance[debounceKey] = debounceHandle
  instance[idleKey] = idleHandle
  return { debounceHandle, idleHandle }
}

describe('EditorManager cleanup semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cleanup cancels every scheduled RAF kind and pending timers', () => {
    const manager = createEditorManager()
    const cancel = stubRafScheduler(manager)
    const { debounceHandle, idleHandle } = setTimerHandles(manager, 'revealDebounceId', 'revealIdleTimerId')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    manager.cleanup()

    for (const kind of EDITOR_RAF_KINDS)
      expect(cancel).toHaveBeenCalledWith(kind)
    expect(clearSpy).toHaveBeenCalledWith(debounceHandle)
    expect(clearSpy).toHaveBeenCalledWith(idleHandle)
    expect(manager['revealDebounceId']).toBeNull()
    expect(manager['revealIdleTimerId']).toBeNull()
  })

  it('safeClean mirrors cleanup by cancelling RAFs and timers', () => {
    const manager = createEditorManager()
    const cancel = stubRafScheduler(manager)
    const { debounceHandle, idleHandle } = setTimerHandles(manager, 'revealDebounceId', 'revealIdleTimerId')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    manager.safeClean()

    for (const kind of EDITOR_RAF_KINDS)
      expect(cancel).toHaveBeenCalledWith(kind)
    expect(clearSpy).toHaveBeenCalledWith(debounceHandle)
    expect(clearSpy).toHaveBeenCalledWith(idleHandle)
    expect(manager['revealDebounceId']).toBeNull()
    expect(manager['revealIdleTimerId']).toBeNull()
  })
})

describe('DiffEditorManager cleanup semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cleanup clears diff RAF queues and timers', () => {
    const manager = createDiffEditorManager()
    const cancel = stubRafScheduler(manager)
    const { debounceHandle, idleHandle } = setTimerHandles(manager, 'revealDebounceIdDiff', 'revealIdleTimerIdDiff')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    manager.cleanup()

    for (const kind of DIFF_RAF_KINDS)
      expect(cancel).toHaveBeenCalledWith(kind)
    expect(clearSpy).toHaveBeenCalledWith(debounceHandle)
    expect(clearSpy).toHaveBeenCalledWith(idleHandle)
    expect(manager['revealDebounceIdDiff']).toBeNull()
    expect(manager['revealIdleTimerIdDiff']).toBeNull()
  })

  it('safeClean must also cancel diff RAF kinds and idle batching timers', () => {
    const manager = createDiffEditorManager()
    const cancel = stubRafScheduler(manager)
    const { debounceHandle, idleHandle } = setTimerHandles(manager, 'revealDebounceIdDiff', 'revealIdleTimerIdDiff')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    manager.safeClean()

    for (const kind of DIFF_RAF_KINDS)
      expect(cancel).toHaveBeenCalledWith(kind)
    expect(clearSpy).toHaveBeenCalledWith(debounceHandle)
    expect(clearSpy).toHaveBeenCalledWith(idleHandle)
    expect(manager['revealDebounceIdDiff']).toBeNull()
    expect(manager['revealIdleTimerIdDiff']).toBeNull()
  })
})
