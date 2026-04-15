import type {
  DiffHunkActionContext,
  DiffHunkActionKind,
  DiffHunkSide,
} from '../type'
import * as monaco from '../monaco-shim'

export type DiffEditorSide = 'original' | 'modified'

export function createDiffHunkActionNode(
  side: DiffHunkSide,
  onAction: (side: DiffHunkSide, action: DiffHunkActionKind) => void,
): HTMLDivElement {
  const node = document.createElement('div')
  node.className = 'stream-monaco-diff-hunk-actions'
  node.dataset.side = side

  const createButton = (action: DiffHunkActionKind, label: string) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.dataset.action = action
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onAction(side, action)
    })
    return button
  }

  node.append(
    createButton('revert', 'Revert'),
    createButton('stage', 'Stage'),
  )

  return node
}

export function hasOriginalLines(change: monaco.editor.ILineChange) {
  return (
    change.originalStartLineNumber > 0
    && change.originalEndLineNumber >= change.originalStartLineNumber
  )
}

export function hasModifiedLines(change: monaco.editor.ILineChange) {
  return (
    change.modifiedStartLineNumber > 0
    && change.modifiedEndLineNumber >= change.modifiedStartLineNumber
  )
}

export function inferInlineDiffHunkHoverSide(
  change: monaco.editor.ILineChange,
  hoverLine: number,
  targetElement: HTMLElement | null,
): DiffHunkSide {
  if (
    targetElement?.closest(
      '.line-delete, .char-delete, .inline-deleted-text, .inline-deleted-margin-view-zone',
    )
  ) {
    return 'upper'
  }
  if (
    targetElement?.closest(
      '.line-insert, .char-insert, .gutter-insert, .view-line',
    )
  ) {
    return 'lower'
  }
  if (!hasModifiedLines(change))
    return 'upper'
  if (!hasOriginalLines(change))
    return 'lower'
  const modifiedAnchor = Math.max(
    1,
    change.modifiedStartLineNumber || change.modifiedEndLineNumber || 1,
  )
  return hoverLine < modifiedAnchor ? 'upper' : 'lower'
}

function distanceToLineChange(
  side: DiffEditorSide,
  change: monaco.editor.ILineChange,
  line: number,
) {
  const hasRange = side === 'original'
    ? hasOriginalLines(change)
    : hasModifiedLines(change)
  const start = side === 'original'
    ? change.originalStartLineNumber
    : change.modifiedStartLineNumber
  const end = side === 'original'
    ? change.originalEndLineNumber
    : change.modifiedEndLineNumber

  if (hasRange) {
    if (line < start)
      return start - line
    if (line > end)
      return line - end
    return 0
  }

  const fallbackAnchor = Math.max(1, start || end || 1)
  return Math.abs(line - fallbackAnchor)
}

export function findLineChangeByHoverLine(
  lineChanges: monaco.editor.ILineChange[],
  side: DiffEditorSide,
  line: number,
) {
  if (lineChanges.length === 0)
    return null

  let best: monaco.editor.ILineChange | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const change of lineChanges) {
    const distance = distanceToLineChange(side, change, line)
    if (distance < bestDistance) {
      bestDistance = distance
      best = change
      if (distance === 0)
        break
    }
  }

  if (bestDistance > 2)
    return null
  return best
}

export function getFullLineRange(
  model: monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
) {
  if (endLine < startLine)
    return null
  const lineCount = model.getLineCount()
  if (lineCount < 1)
    return null

  const start = Math.max(1, Math.min(startLine, lineCount))
  const end = Math.max(start, Math.min(endLine, lineCount))
  if (end < lineCount)
    return new monaco.Range(start, 1, end + 1, 1)
  return new monaco.Range(start, 1, end, model.getLineMaxColumn(end))
}

export function getLinesText(
  model: monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
) {
  const range = getFullLineRange(model, startLine, endLine)
  if (!range)
    return ''
  return model.getValueInRange(range)
}

export function getInsertRangeBeforeLine(
  model: monaco.editor.ITextModel,
  lineNumber: number,
) {
  const lineCount = model.getLineCount()
  if (lineNumber <= 1)
    return new monaco.Range(1, 1, 1, 1)
  if (lineNumber <= lineCount)
    return new monaco.Range(lineNumber, 1, lineNumber, 1)
  const lastLine = lineCount
  const lastColumn = model.getLineMaxColumn(lastLine)
  return new monaco.Range(lastLine, lastColumn, lastLine, lastColumn)
}

export function getInsertRangeAfterLine(
  model: monaco.editor.ITextModel,
  lineNumber: number,
) {
  const lineCount = model.getLineCount()
  if (lineNumber < 1)
    return new monaco.Range(1, 1, 1, 1)
  if (lineNumber < lineCount)
    return new monaco.Range(lineNumber + 1, 1, lineNumber + 1, 1)
  const lastLine = lineCount
  const lastColumn = model.getLineMaxColumn(lastLine)
  return new monaco.Range(lastLine, lastColumn, lastLine, lastColumn)
}

export function applyDefaultDiffHunkAction(context: DiffHunkActionContext) {
  const { action, side, lineChange, originalModel, modifiedModel } = context
  const hasOriginal = hasOriginalLines(lineChange)
  const hasModified = hasModifiedLines(lineChange)

  if (action === 'revert' && side === 'upper') {
    if (!hasOriginal)
      return
    const text = getLinesText(
      originalModel,
      lineChange.originalStartLineNumber,
      lineChange.originalEndLineNumber,
    )
    if (!text)
      return
    const range = hasModified
      ? getInsertRangeBeforeLine(
          modifiedModel,
          lineChange.modifiedStartLineNumber,
        )
      : getInsertRangeAfterLine(
          modifiedModel,
          Math.max(
            0,
            lineChange.modifiedStartLineNumber
            || lineChange.modifiedEndLineNumber,
          ),
        )
    modifiedModel.applyEdits([{ range, text, forceMoveMarkers: true }])
    return
  }

  if (action === 'revert' && side === 'lower') {
    if (!hasModified)
      return
    const range = getFullLineRange(
      modifiedModel,
      lineChange.modifiedStartLineNumber,
      lineChange.modifiedEndLineNumber,
    )
    if (!range)
      return
    modifiedModel.applyEdits([{ range, text: '', forceMoveMarkers: true }])
    return
  }

  if (action === 'stage' && side === 'upper') {
    if (!hasOriginal)
      return
    const range = getFullLineRange(
      originalModel,
      lineChange.originalStartLineNumber,
      lineChange.originalEndLineNumber,
    )
    if (!range)
      return
    originalModel.applyEdits([{ range, text: '', forceMoveMarkers: true }])
    return
  }

  if (action === 'stage' && side === 'lower') {
    if (!hasModified)
      return
    const text = getLinesText(
      modifiedModel,
      lineChange.modifiedStartLineNumber,
      lineChange.modifiedEndLineNumber,
    )
    if (!text)
      return
    const anchor = hasOriginal
      ? lineChange.originalEndLineNumber
      : Math.max(0, lineChange.originalStartLineNumber)
    const range = getInsertRangeAfterLine(originalModel, anchor)
    originalModel.applyEdits([{ range, text, forceMoveMarkers: true }])
  }
}

export function setDiffHunkNodeEnabled(
  node: HTMLDivElement | null,
  enabled: boolean,
) {
  if (!node)
    return
  const buttons = node.querySelectorAll('button')
  buttons.forEach((button) => {
    ;(button as HTMLButtonElement).disabled = !enabled
  })
}

export function positionDiffHunkNode(
  node: HTMLDivElement,
  editor: monaco.editor.IStandaloneCodeEditor,
  anchorLine: number,
  extraOffsetY = 0,
) {
  const host = editor.getContainerDomNode()
  const line = Math.max(1, anchorLine)
  const rawTop = editor.getTopForLineNumber(line) - (editor.getScrollTop?.() ?? 0)
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
  const nodeWidth = node.offsetWidth || 130
  const nodeHeight = node.offsetHeight || 30
  const left = host.offsetLeft + Math.max(6, host.clientWidth - nodeWidth - 10)
  const hostTop = host.offsetTop
  const minTop = hostTop + 4
  const maxTop = hostTop + Math.max(4, host.clientHeight - nodeHeight - 4)
  const top = Math.min(
    maxTop,
    Math.max(
      minTop,
      hostTop + rawTop + Math.round(lineHeight * 0.2) + extraOffsetY,
    ),
  )
  node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  node.style.display = 'flex'
}
