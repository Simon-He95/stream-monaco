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
    default: { editor: {}, Range },
    editor: {},
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
})
