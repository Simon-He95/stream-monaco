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
    default: {
      Range,
      editor: {
        EditorOption: {
          lineHeight: 'lineHeight',
        },
      },
    },
    Range,
    editor: {
      EditorOption: {
        lineHeight: 'lineHeight',
      },
    },
  }
})

import {
  applyDefaultDiffHunkAction,
  findLineChangeByHoverLine,
  hasModifiedLines,
  hasOriginalLines,
  inferInlineDiffHunkHoverSide,
  positionDiffHunkNode,
} from '../src/core/diffHunk'

function createModel(lines: string[]) {
  const value = () => lines.join('\n')
  return {
    getLineCount() {
      return lines.length
    },
    getLineMaxColumn(line: number) {
      return (lines[line - 1] ?? '').length + 1
    },
    getValueInRange(range: any) {
      const start = range.startLineNumber - 1
      const end = range.endLineNumber - 1
      const selected = lines.slice(start, Math.max(start, end))
      if (range.endColumn !== 1 && end < lines.length)
        selected.push(lines[end] ?? '')
      return `${selected.join('\n')}${selected.length > 0 ? '\n' : ''}`
    },
    applyEdits: vi.fn(),
  }
}

describe('diffHunk helpers', () => {
  it('detects whether a hunk has original or modified lines', () => {
    const insertion = {
      originalStartLineNumber: 0,
      originalEndLineNumber: 0,
      modifiedStartLineNumber: 3,
      modifiedEndLineNumber: 4,
    } as any

    expect(hasOriginalLines(insertion)).toBe(false)
    expect(hasModifiedLines(insertion)).toBe(true)
  })

  it('finds the nearest hovered line change within tolerance', () => {
    const changes = [
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 3,
      },
      {
        originalStartLineNumber: 10,
        originalEndLineNumber: 10,
        modifiedStartLineNumber: 12,
        modifiedEndLineNumber: 12,
      },
    ] as any

    expect(findLineChangeByHoverLine(changes, 'modified', 3)).toBe(changes[0])
    expect(findLineChangeByHoverLine(changes, 'modified', 14)).toBe(changes[1])
    expect(findLineChangeByHoverLine(changes, 'modified', 20)).toBeNull()
  })

  it('infers inline hover side from DOM hint or hover line fallback', () => {
    const change = {
      originalStartLineNumber: 4,
      originalEndLineNumber: 5,
      modifiedStartLineNumber: 6,
      modifiedEndLineNumber: 7,
    } as any

    const deletedTarget = {
      closest(selector: string) {
        return selector.includes('line-delete') ? {} : null
      },
    } as HTMLElement
    const insertedTarget = {
      closest(selector: string) {
        return selector.includes('line-insert') ? {} : null
      },
    } as HTMLElement

    expect(inferInlineDiffHunkHoverSide(change, 5, deletedTarget)).toBe('upper')
    expect(inferInlineDiffHunkHoverSide(change, 7, insertedTarget)).toBe('lower')
    expect(inferInlineDiffHunkHoverSide(change, 5, null)).toBe('upper')
    expect(inferInlineDiffHunkHoverSide(change, 6, null)).toBe('lower')
  })

  it('applies the default lower-stage action by copying modified lines into original', () => {
    const originalModel = createModel(['a', 'b'])
    const modifiedModel = createModel(['a', 'b', 'c'])
    const lineChange = {
      originalStartLineNumber: 0,
      originalEndLineNumber: 0,
      modifiedStartLineNumber: 3,
      modifiedEndLineNumber: 3,
    } as any

    applyDefaultDiffHunkAction({
      action: 'stage',
      side: 'lower',
      lineChange,
      originalModel: originalModel as any,
      modifiedModel: modifiedModel as any,
    })

    expect(originalModel.applyEdits).toHaveBeenCalledTimes(1)
    expect(originalModel.applyEdits.mock.calls[0][0][0].text).toBe('c\n')
  })

  it('positions a hunk node within the editor host', () => {
    const node = {
      offsetWidth: 120,
      offsetHeight: 24,
      style: {
        transform: '',
        display: '',
      },
    } as unknown as HTMLDivElement
    const editor = {
      getContainerDomNode() {
        return {
          offsetLeft: 10,
          clientWidth: 400,
          offsetTop: 20,
          clientHeight: 200,
        }
      },
      getTopForLineNumber(line: number) {
        return line * 20
      },
      getScrollTop() {
        return 20
      },
      getOption() {
        return 20
      },
    } as any

    positionDiffHunkNode(node, editor, 5)

    expect(node.style.display).toBe('flex')
    expect(node.style.transform).toContain('translate(')
  })
})
