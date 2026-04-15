import { describe, expect, it, vi } from 'vitest'
import { DiffEditorManager } from '../src/core/DiffEditorManager'
import { EditorManager } from '../src/core/EditorManager'

vi.mock('../src/monaco-shim', () => {
  const editor = {
    EditorOption: { lineHeight: 16, readOnly: 0 },
    ScrollType: { Smooth: 1 },
    setModelLanguage: vi.fn(),
  }
  class Range {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
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

function createStubModel(initial = '') {
  let value = initial
  const setValue = vi.fn((next: string) => {
    value = next
  })
  const applyEdits = vi.fn()

  return {
    getValue() {
      return value
    },
    setValue,
    applyEdits,
    getLineCount() {
      return Math.max(1, value.split('\n').length)
    },
    getLanguageId() {
      return 'plaintext'
    },
    getLineMaxColumn(line: number) {
      const lines = value.split('\n')
      const index = Math.max(0, Math.min(line - 1, lines.length - 1))
      return (lines[index]?.length ?? 0) + 1
    },
    getPositionAt(offset: number) {
      return {
        lineNumber: 1,
        column: Math.max(1, offset + 1),
      }
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
    executeEdits: vi.fn(),
    getScrollHeight() {
      return 0
    },
    getScrollTop() {
      return 0
    },
    getLayoutInfo() {
      return { height: 0 }
    },
  }
}

describe('minimal edit option overrides', () => {
  it('EditorManager respects minimalEditMaxChars from options', () => {
    const model = createStubModel('abc')
    const manager = new EditorManager(
      { readOnly: false, minimalEditMaxChars: 1 } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      75,
      0,
    )

    ;(manager as any).editorView = createStubCodeEditor(model)

    ;(manager as any).applyMinimalEdit('abc', 'abXYc')

    expect(model.setValue).toHaveBeenCalledWith('abXYc')
    expect((manager as any).editorView.executeEdits).not.toHaveBeenCalled()
  })

  it('EditorManager respects minimalEditMaxChangeRatio from options', () => {
    const model = createStubModel('abcd')
    const manager = new EditorManager(
      {
        readOnly: false,
        minimalEditMaxChars: 1000,
        minimalEditMaxChangeRatio: 0.1,
      } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      75,
      0,
    )

    ;(manager as any).editorView = createStubCodeEditor(model)

    ;(manager as any).applyMinimalEdit('abcd', 'a1234567')

    expect(model.setValue).toHaveBeenCalledWith('a1234567')
    expect((manager as any).editorView.executeEdits).not.toHaveBeenCalled()
  })

  it('DiffEditorManager respects minimalEditMaxChars from options', () => {
    const model = createStubModel('abc')
    const manager = new DiffEditorManager(
      { readOnly: true, minimalEditMaxChars: 1 } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      true,
      75,
      0,
    )

    ;(manager as any).modifiedModel = model

    ;(manager as any).applyMinimalEditToModel(model, 'abc', 'abXYc')

    expect(model.setValue).toHaveBeenCalledWith('abXYc')
    expect(model.applyEdits).not.toHaveBeenCalled()
  })

  it('DiffEditorManager respects minimalEditMaxChangeRatio from options', () => {
    const model = createStubModel('abcd')
    const manager = new DiffEditorManager(
      {
        readOnly: true,
        minimalEditMaxChars: 1000,
        minimalEditMaxChangeRatio: 0.1,
      } as any,
      600,
      '600px',
      true,
      true,
      32,
      2,
      true,
      75,
      0,
    )

    ;(manager as any).modifiedModel = model

    ;(manager as any).applyMinimalEditToModel(model, 'abcd', 'a1234567')

    expect(model.setValue).toHaveBeenCalledWith('a1234567')
    expect(model.applyEdits).not.toHaveBeenCalled()
  })
})
