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

import { DiffEditorManager } from '../src/core/DiffEditorManager'
import { EditorManager } from '../src/core/EditorManager'

const EDITOR_RAF_KINDS = [
  'maybe-scroll',
  'reveal',
  'maybe-resume',
  'content-size-change',
  'sync-last-known',
  'immediate-reveal',
  'update',
  'append',
] as const

const DIFF_RAF_KINDS = [
  'sync-diff-presentation',
  'capture-diff-unchanged-state',
  'restore-diff-unchanged-state',
  'patch-diff-unchanged-regions',
  'maybe-scroll-diff',
  'revealDiff',
  'immediate-reveal-diff',
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

describe('EditorManager cleanup semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cleanup cancels every scheduled RAF kind and pending timers', () => {
    const manager = createEditorManager()
    const cancel = stubRafScheduler(manager)
    const revealDebounceHandle = 101
    const revealIdleHandle = 102
    const suppressionHandle = 103
    const throttleHandle = 104
    manager['revealDebounceId'] = revealDebounceHandle
    manager['revealIdleTimerId'] = revealIdleHandle
    manager['scrollWatcherSuppressionTimer'] = suppressionHandle
    manager['updateThrottleTimer'] = throttleHandle
    manager['appendBuffer'].push('x')
    manager['appendBufferScheduled'] = true
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    manager.cleanup()

    for (const kind of EDITOR_RAF_KINDS)
      expect(cancel).toHaveBeenCalledWith(kind)
    expect(clearSpy).toHaveBeenCalledWith(revealDebounceHandle)
    expect(clearSpy).toHaveBeenCalledWith(revealIdleHandle)
    expect(clearSpy).toHaveBeenCalledWith(suppressionHandle)
    expect(clearSpy).toHaveBeenCalledWith(throttleHandle)
    expect(manager['revealDebounceId']).toBeNull()
    expect(manager['revealIdleTimerId']).toBeNull()
    expect(manager['scrollWatcherSuppressionTimer']).toBeNull()
    expect(manager['updateThrottleTimer']).toBeNull()
    expect(manager['appendBufferScheduled']).toBe(false)
    expect(manager['appendBuffer']).toHaveLength(0)
  })

  it('safeClean mirrors cleanup for RAFs, timers, and append state', () => {
    const manager = createEditorManager()
    const cancel = stubRafScheduler(manager)
    const revealDebounceHandle = 201
    const revealIdleHandle = 202
    const suppressionHandle = 203
    const throttleHandle = 204
    manager['revealDebounceId'] = revealDebounceHandle
    manager['revealIdleTimerId'] = revealIdleHandle
    manager['scrollWatcherSuppressionTimer'] = suppressionHandle
    manager['updateThrottleTimer'] = throttleHandle
    manager['appendBuffer'].push('x')
    manager['appendBufferScheduled'] = true
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    manager.safeClean()

    for (const kind of EDITOR_RAF_KINDS)
      expect(cancel).toHaveBeenCalledWith(kind)
    expect(clearSpy).toHaveBeenCalledWith(revealDebounceHandle)
    expect(clearSpy).toHaveBeenCalledWith(revealIdleHandle)
    expect(clearSpy).toHaveBeenCalledWith(suppressionHandle)
    expect(clearSpy).toHaveBeenCalledWith(throttleHandle)
    expect(manager['revealDebounceId']).toBeNull()
    expect(manager['revealIdleTimerId']).toBeNull()
    expect(manager['scrollWatcherSuppressionTimer']).toBeNull()
    expect(manager['updateThrottleTimer']).toBeNull()
    expect(manager['appendBufferScheduled']).toBe(false)
    expect(manager['appendBuffer']).toHaveLength(0)
  })
})

describe('DiffEditorManager cleanup semantics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cleanup clears diff RAF queues, timers, and append buffers', () => {
    const manager = createDiffEditorManager()
    const cancel = stubRafScheduler(manager)
    const revealDebounceHandle = 301
    const revealIdleHandle = 302
    const suppressionHandle = 303
    const appendThrottleHandle = 304
    const hideHandle = 305
    manager['revealDebounceIdDiff'] = revealDebounceHandle
    manager['revealIdleTimerIdDiff'] = revealIdleHandle
    manager['diffScrollWatcherSuppressionTimer'] = suppressionHandle
    manager['appendFlushThrottleTimerDiff'] = appendThrottleHandle
    manager['diffHunkHideTimer'] = hideHandle
    manager['appendBufferOriginalDiff'].push('left')
    manager['appendBufferModifiedDiff'].push('right')
    manager['appendBufferDiffScheduled'] = true
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    manager.cleanup()

    for (const kind of DIFF_RAF_KINDS)
      expect(cancel).toHaveBeenCalledWith(kind)
    expect(clearSpy).toHaveBeenCalledWith(revealDebounceHandle)
    expect(clearSpy).toHaveBeenCalledWith(revealIdleHandle)
    expect(clearSpy).toHaveBeenCalledWith(suppressionHandle)
    expect(clearSpy).toHaveBeenCalledWith(appendThrottleHandle)
    expect(clearSpy).toHaveBeenCalledWith(hideHandle)
    expect(manager['revealDebounceIdDiff']).toBeNull()
    expect(manager['revealIdleTimerIdDiff']).toBeNull()
    expect(manager['diffScrollWatcherSuppressionTimer']).toBeNull()
    expect(manager['appendFlushThrottleTimerDiff']).toBeNull()
    expect(manager['diffHunkHideTimer']).toBeNull()
    expect(manager['appendBufferDiffScheduled']).toBe(false)
    expect(manager['appendBufferOriginalDiff']).toHaveLength(0)
    expect(manager['appendBufferModifiedDiff']).toHaveLength(0)
  })

  it('safeClean also cancels diff RAFs, timers, and append buffers', () => {
    const manager = createDiffEditorManager()
    const cancel = stubRafScheduler(manager)
    const revealDebounceHandle = 401
    const revealIdleHandle = 402
    const suppressionHandle = 403
    const appendThrottleHandle = 404
    const hideHandle = 405
    manager['revealDebounceIdDiff'] = revealDebounceHandle
    manager['revealIdleTimerIdDiff'] = revealIdleHandle
    manager['diffScrollWatcherSuppressionTimer'] = suppressionHandle
    manager['appendFlushThrottleTimerDiff'] = appendThrottleHandle
    manager['diffHunkHideTimer'] = hideHandle
    manager['appendBufferOriginalDiff'].push('left')
    manager['appendBufferModifiedDiff'].push('right')
    manager['appendBufferDiffScheduled'] = true
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})

    manager.safeClean()

    for (const kind of DIFF_RAF_KINDS)
      expect(cancel).toHaveBeenCalledWith(kind)
    expect(clearSpy).toHaveBeenCalledWith(revealDebounceHandle)
    expect(clearSpy).toHaveBeenCalledWith(revealIdleHandle)
    expect(clearSpy).toHaveBeenCalledWith(suppressionHandle)
    expect(clearSpy).toHaveBeenCalledWith(appendThrottleHandle)
    expect(clearSpy).toHaveBeenCalledWith(hideHandle)
    expect(manager['revealDebounceIdDiff']).toBeNull()
    expect(manager['revealIdleTimerIdDiff']).toBeNull()
    expect(manager['diffScrollWatcherSuppressionTimer']).toBeNull()
    expect(manager['appendFlushThrottleTimerDiff']).toBeNull()
    expect(manager['diffHunkHideTimer']).toBeNull()
    expect(manager['appendBufferDiffScheduled']).toBe(false)
    expect(manager['appendBufferOriginalDiff']).toHaveLength(0)
    expect(manager['appendBufferModifiedDiff']).toHaveLength(0)
  })
})
