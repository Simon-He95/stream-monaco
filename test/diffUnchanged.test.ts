import { describe, expect, it } from 'vitest'

import {
  buildDiffHunkMetadataLabel,
  formatDiffUnchangedCountLabel,
  measureDiffUnchangedSurroundingLines,
  resolveDiffMetadataLabel,
  resolveDiffUnchangedMergeRole,
  resolveDiffUnchangedRevealLayout,
  resolveDiffUnchangedSummaryLabel,
} from '../src/core/diffUnchanged'

function createRect(top: number, bottom: number, left = 0, width = 20) {
  return {
    top,
    bottom,
    left,
    width,
    height: bottom - top,
    right: left + width,
  }
}

function createLineNode(lineNumber: number, top: number) {
  return {
    textContent: String(lineNumber),
    getBoundingClientRect() {
      return createRect(top, top + 10)
    },
  }
}

describe('diffUnchanged helpers', () => {
  it('formats unchanged count labels', () => {
    expect(formatDiffUnchangedCountLabel('12 hidden lines')).toBe('12 unmodified lines')
    expect(formatDiffUnchangedCountLabel('1 hidden line')).toBe('1 unmodified line')
  })

  it('measures surrounding visible lines around a hidden region', () => {
    const editorRoot = {
      querySelectorAll() {
        return [
          createLineNode(2, 10),
          createLineNode(3, 20),
          createLineNode(9, 80),
          createLineNode(10, 90),
        ]
      },
    }
    const primaryNode = {
      closest(selector: string) {
        return selector.includes('.editor.modified') ? editorRoot : null
      },
      getBoundingClientRect() {
        return createRect(40, 60)
      },
    }

    expect(measureDiffUnchangedSurroundingLines(primaryNode as any)).toEqual({
      previousVisibleLine: 3,
      nextVisibleLine: 9,
    })
  })

  it('builds and resolves metadata labels from line changes', () => {
    const primaryNode = {
      closest() {
        return {
          querySelectorAll() {
            return [createLineNode(6, 90)]
          },
        }
      },
      getBoundingClientRect() {
        return createRect(40, 60)
      },
    }
    const lineChange = {
      originalStartLineNumber: 4,
      originalEndLineNumber: 5,
      modifiedStartLineNumber: 6,
      modifiedEndLineNumber: 8,
    }

    expect(
      buildDiffHunkMetadataLabel(lineChange as any, {
        contextLineCount: 2,
        originalTotalLines: 20,
        modifiedTotalLines: 24,
      }),
    ).toEqual({
      originalStart: 2,
      modifiedStart: 4,
      label: '@@ -2,6 +4,7 @@',
    })

    expect(
      resolveDiffMetadataLabel({
        lineChanges: [lineChange as any],
        pairIndex: 0,
        primaryNode: primaryNode as any,
        contextLineCount: 2,
        originalTotalLines: 20,
        modifiedTotalLines: 24,
      }),
    ).toBe('@@ -2,6 +4,7 @@')

    expect(
      resolveDiffUnchangedSummaryLabel({
        countText: '3 unmodified lines',
        unchangedRegionStyle: 'metadata',
        lineChanges: [lineChange as any],
        pairIndex: 0,
        primaryNode: primaryNode as any,
        contextLineCount: 2,
        originalTotalLines: 20,
        modifiedTotalLines: 24,
      }),
    ).toBe('@@ -2,6 +4,7 @@')

    expect(
      resolveDiffUnchangedSummaryLabel({
        countText: '3 unmodified lines',
        unchangedRegionStyle: 'line-info',
        lineChanges: [lineChange as any],
        pairIndex: 0,
        primaryNode: primaryNode as any,
        contextLineCount: 2,
        originalTotalLines: 20,
        modifiedTotalLines: 24,
      }),
    ).toBe('3 unmodified lines')
  })

  it('resolves reveal handle layout at file boundaries', () => {
    const primaryNode = {
      closest() {
        return {
          querySelectorAll() {
            return [createLineNode(1, 90)]
          },
        }
      },
      getBoundingClientRect() {
        return createRect(40, 60)
      },
    }

    expect(
      resolveDiffUnchangedRevealLayout({
        primaryNode: primaryNode as any,
        countText: '3 hidden lines',
        pairIndex: 0,
        pairCount: 2,
        modelLineCount: 10,
      }),
    ).toEqual({
      showTopHandle: false,
      showBottomHandle: true,
    })
  })

  it('resolves unchanged merge role from editor host centers', () => {
    class HTMLElementMock {}
    const previousHTMLElement = globalThis.HTMLElement
    globalThis.HTMLElement = HTMLElementMock as any

    const node = Object.assign(new HTMLElementMock(), {
      getBoundingClientRect() {
        return createRect(0, 20, 40, 20)
      },
    })
    const diffRoot = Object.assign(new HTMLElementMock(), {
      getBoundingClientRect() {
        return createRect(0, 20, 0, 200)
      },
    })
    const originalHost = Object.assign(new HTMLElementMock(), {
      getBoundingClientRect() {
        return createRect(0, 20, 20, 40)
      },
    })
    const modifiedHost = Object.assign(new HTMLElementMock(), {
      getBoundingClientRect() {
        return createRect(0, 20, 120, 40)
      },
    })

    try {
      expect(
        resolveDiffUnchangedMergeRole({
          node: node as any,
          diffRoot: diffRoot as any,
          originalHost: originalHost as any,
          modifiedHost: modifiedHost as any,
        }),
      ).toBe('secondary')
    }
    finally {
      globalThis.HTMLElement = previousHTMLElement
    }
  })
})
