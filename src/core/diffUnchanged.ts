import type * as monaco from '../monaco-shim'
import type { DiffUnchangedRegionStyle } from '../type'

export interface DiffUnchangedSurroundingLines {
  previousVisibleLine: number | null
  nextVisibleLine: number | null
}

interface BuildDiffHunkMetadataLabelOptions {
  contextLineCount: number
  originalTotalLines: number
  modifiedTotalLines: number
}

interface DiffHunkMetadataLabel {
  modifiedStart: number
  originalStart: number
  label: string
}

interface ResolveDiffMetadataLabelOptions
  extends BuildDiffHunkMetadataLabelOptions {
  lineChanges: monaco.editor.ILineChange[]
  pairIndex: number
  primaryNode: HTMLElement
}

interface ResolveDiffUnchangedRevealLayoutOptions {
  countText: string
  modelLineCount: number | null
  pairCount: number
  pairIndex: number
  primaryNode: HTMLElement
}

interface ResolveDiffUnchangedSummaryLabelOptions
  extends ResolveDiffMetadataLabelOptions {
  countText: string
  unchangedRegionStyle: DiffUnchangedRegionStyle
}

interface ResolveDiffUnchangedMergeRoleOptions {
  diffRoot: Element | null
  modifiedHost: HTMLElement | null | undefined
  node: HTMLElement
  originalHost: HTMLElement | null | undefined
}

export function formatDiffUnchangedCountLabel(text: string) {
  const match = text.match(/\d+/)
  const count = match ? Number.parseInt(match[0], 10) : Number.NaN
  if (Number.isFinite(count))
    return `${count} unmodified ${count === 1 ? 'line' : 'lines'}`
  return text.replace(/hidden/gi, 'unmodified')
}

export function countDiffLines(startLineNumber: number, endLineNumber: number) {
  return endLineNumber >= startLineNumber
    ? endLineNumber - startLineNumber + 1
    : 0
}

export function measureDiffUnchangedSurroundingLines(
  primaryNode: HTMLElement,
): DiffUnchangedSurroundingLines {
  const editorRoot
    = primaryNode.closest<HTMLElement>('.editor.modified')
      ?? primaryNode.closest<HTMLElement>('.monaco-editor')
  if (!editorRoot) {
    return {
      previousVisibleLine: null,
      nextVisibleLine: null,
    }
  }

  const widgetRect = primaryNode.getBoundingClientRect()
  let previousVisibleLine: number | null = null
  let nextVisibleLine: number | null = null
  const lineNumberNodes = editorRoot.querySelectorAll<HTMLElement>('.line-numbers')

  lineNumberNodes.forEach((node) => {
    const lineNumber = Number.parseInt(node.textContent?.trim() || '', 10)
    if (!Number.isFinite(lineNumber))
      return
    const top = node.getBoundingClientRect().top
    if (top < widgetRect.top - 1) {
      previousVisibleLine = previousVisibleLine == null
        ? lineNumber
        : Math.max(previousVisibleLine, lineNumber)
    }
    else if (top > widgetRect.bottom + 1) {
      nextVisibleLine = nextVisibleLine == null
        ? lineNumber
        : Math.min(nextVisibleLine, lineNumber)
    }
  })

  return {
    previousVisibleLine,
    nextVisibleLine,
  }
}

function formatDiffMetadataRange(startLineNumber: number, lineCount: number) {
  return `${startLineNumber},${Math.max(0, lineCount)}`
}

export function buildDiffHunkMetadataLabel(
  change: monaco.editor.ILineChange,
  options: BuildDiffHunkMetadataLabelOptions,
): DiffHunkMetadataLabel {
  const { contextLineCount, modifiedTotalLines, originalTotalLines } = options
  const originalChangedCount = countDiffLines(
    change.originalStartLineNumber,
    change.originalEndLineNumber,
  )
  const modifiedChangedCount = countDiffLines(
    change.modifiedStartLineNumber,
    change.modifiedEndLineNumber,
  )

  const originalAnchor = Math.min(
    Math.max(change.originalStartLineNumber, 1),
    Math.max(1, originalTotalLines + 1),
  )
  const modifiedAnchor = Math.min(
    Math.max(change.modifiedStartLineNumber, 1),
    Math.max(1, modifiedTotalLines + 1),
  )

  const originalStart = Math.max(1, originalAnchor - contextLineCount)
  const modifiedStart = Math.max(1, modifiedAnchor - contextLineCount)

  const originalEnd = originalChangedCount > 0
    ? Math.min(originalTotalLines, change.originalEndLineNumber + contextLineCount)
    : Math.min(originalTotalLines, originalAnchor + contextLineCount - 1)
  const modifiedEnd = modifiedChangedCount > 0
    ? Math.min(modifiedTotalLines, change.modifiedEndLineNumber + contextLineCount)
    : Math.min(modifiedTotalLines, modifiedAnchor + contextLineCount - 1)

  const originalDisplayCount = originalEnd >= originalStart
    ? originalEnd - originalStart + 1
    : 0
  const modifiedDisplayCount = modifiedEnd >= modifiedStart
    ? modifiedEnd - modifiedStart + 1
    : 0

  return {
    modifiedStart,
    originalStart,
    label: `@@ -${formatDiffMetadataRange(
      originalStart,
      originalDisplayCount,
    )} +${formatDiffMetadataRange(modifiedStart, modifiedDisplayCount)} @@`,
  }
}

export function resolveDiffMetadataLabel(
  options: ResolveDiffMetadataLabelOptions,
) {
  const {
    contextLineCount,
    lineChanges,
    modifiedTotalLines,
    originalTotalLines,
    pairIndex,
    primaryNode,
  } = options
  if (lineChanges.length === 0)
    return null

  const metadataEntries = lineChanges.map(change =>
    buildDiffHunkMetadataLabel(change, {
      contextLineCount,
      modifiedTotalLines,
      originalTotalLines,
    }),
  )
  const { nextVisibleLine } = measureDiffUnchangedSurroundingLines(primaryNode)

  if (nextVisibleLine != null) {
    const candidateStarts = [nextVisibleLine, nextVisibleLine - 1].filter(
      value => value >= 1,
    )
    for (const candidateStart of candidateStarts) {
      const matching = metadataEntries.find(
        entry => entry.modifiedStart === candidateStart,
      )
      if (matching)
        return matching.label
    }
  }

  return metadataEntries[Math.min(pairIndex, metadataEntries.length - 1)]?.label ?? null
}

export function resolveDiffUnchangedSummaryLabel(
  options: ResolveDiffUnchangedSummaryLabelOptions,
) {
  const { countText, unchangedRegionStyle, ...metadataOptions } = options
  if (unchangedRegionStyle !== 'metadata')
    return countText
  return resolveDiffMetadataLabel(metadataOptions) ?? countText
}

export function resolveDiffUnchangedRevealLayout(
  options: ResolveDiffUnchangedRevealLayoutOptions,
) {
  const { countText, modelLineCount, pairCount, pairIndex, primaryNode } = options
  let showTopHandle = pairCount === 1 || pairIndex > 0
  let showBottomHandle = pairCount === 1 || pairIndex < pairCount - 1

  const countMatch = countText.match(/\d+/)
  const hiddenCount = countMatch
    ? Number.parseInt(countMatch[0], 10)
    : Number.NaN
  if (!Number.isFinite(hiddenCount))
    return { showTopHandle, showBottomHandle }

  const { previousVisibleLine, nextVisibleLine }
    = measureDiffUnchangedSurroundingLines(primaryNode)

  if (previousVisibleLine == null && nextVisibleLine != null) {
    showTopHandle = false
    showBottomHandle = true
    return { showTopHandle, showBottomHandle }
  }

  if (nextVisibleLine == null && previousVisibleLine != null) {
    showTopHandle = true
    showBottomHandle = false
    return { showTopHandle, showBottomHandle }
  }

  if (nextVisibleLine != null && nextVisibleLine - hiddenCount === 1) {
    showTopHandle = false
    showBottomHandle = true
  }

  if (
    previousVisibleLine != null
    && modelLineCount != null
    && previousVisibleLine + hiddenCount === modelLineCount
  ) {
    showTopHandle = true
    showBottomHandle = false
  }

  return { showTopHandle, showBottomHandle }
}

export function resolveDiffUnchangedMergeRole(
  options: ResolveDiffUnchangedMergeRoleOptions,
): 'none' | 'primary' | 'secondary' {
  const { diffRoot, modifiedHost, node, originalHost } = options
  if (typeof HTMLElement === 'undefined')
    return 'none'
  if (!(diffRoot instanceof HTMLElement))
    return 'none'

  const nodeRect = node.getBoundingClientRect()
  const nodeCenter = nodeRect.left + nodeRect.width / 2

  if (originalHost instanceof HTMLElement && modifiedHost instanceof HTMLElement) {
    const originalRect = originalHost.getBoundingClientRect()
    const modifiedRect = modifiedHost.getBoundingClientRect()
    const originalCenter = originalRect.left + originalRect.width / 2
    const modifiedCenter = modifiedRect.left + modifiedRect.width / 2
    return Math.abs(nodeCenter - originalCenter)
      <= Math.abs(nodeCenter - modifiedCenter)
      ? 'secondary'
      : 'primary'
  }

  const diffRect = diffRoot.getBoundingClientRect()
  return nodeCenter < diffRect.left + diffRect.width / 2
    ? 'secondary'
    : 'primary'
}
