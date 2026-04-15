import { padding } from '../constant'
import * as monaco from '../monaco-shim'

interface ComputeDiffRawHeightOptions {
  diffEditorView: monaco.editor.IStandaloneDiffEditor | null
  maxHeightValue: number
}

interface ComputeDiffHeightOptions {
  rawHeight: number
  isInlineMode: boolean
  inlineDiffStreamingPresentationActive: boolean
  inlineDiffStreamingHeightFloor: number
}

interface DiffViewportMeasurement {
  computedHeight: number
  lineHeight: number
  scrollHeight: number
  scrollTop: number
  viewportHeight: number
}

interface NearBottomOptions {
  autoScrollThresholdLines: number
  autoScrollThresholdPx: number
}

export function computeDiffRawHeight({
  diffEditorView,
  maxHeightValue,
}: ComputeDiffRawHeightOptions): number {
  if (!diffEditorView)
    return Math.min(18 + padding, maxHeightValue)

  const modifiedEditor = diffEditorView.getModifiedEditor()
  const originalEditor = diffEditorView.getOriginalEditor()
  const lineHeight = modifiedEditor.getOption(
    monaco.editor.EditorOption.lineHeight,
  )
  const originalLineCount = originalEditor.getModel()?.getLineCount() ?? 1
  const modifiedLineCount = modifiedEditor.getModel()?.getLineCount() ?? 1
  const lineCount = Math.max(originalLineCount, modifiedLineCount)
  const fromLines = lineCount * lineHeight + padding
  const scrollHeight = Math.max(
    originalEditor.getScrollHeight?.() ?? 0,
    modifiedEditor.getScrollHeight?.() ?? 0,
  )
  return Math.min(Math.max(fromLines, scrollHeight), maxHeightValue)
}

export function computeDiffHeight({
  inlineDiffStreamingHeightFloor,
  inlineDiffStreamingPresentationActive,
  isInlineMode,
  rawHeight,
}: ComputeDiffHeightOptions) {
  if (
    !isInlineMode
    || (
      !inlineDiffStreamingPresentationActive
      && inlineDiffStreamingHeightFloor <= 0
    )
  ) {
    return {
      height: rawHeight,
      nextInlineDiffStreamingHeightFloor: inlineDiffStreamingHeightFloor,
    }
  }

  const nextInlineDiffStreamingHeightFloor = Math.max(
    rawHeight,
    inlineDiffStreamingHeightFloor,
  )
  return {
    height: nextInlineDiffStreamingHeightFloor,
    nextInlineDiffStreamingHeightFloor,
  }
}

export function readContainerLayoutSize(container: HTMLElement) {
  const rect = container.getBoundingClientRect?.()
  return {
    width: container.clientWidth || rect?.width || 0,
    height: container.clientHeight || rect?.height || 0,
  }
}

export function hasVerticalScrollbar(measurement: {
  computedHeight: number
  lineHeight: number
  scrollHeight: number
}) {
  const epsilon = Math.max(2, Math.round(measurement.lineHeight / 8))
  return measurement.scrollHeight
    > measurement.computedHeight + Math.max(padding / 2, epsilon)
}

export function isUserNearBottom(
  measurement: DiffViewportMeasurement,
  options: NearBottomOptions,
) {
  const lineThreshold
    = options.autoScrollThresholdLines * measurement.lineHeight
  const threshold = Math.max(lineThreshold || 0, options.autoScrollThresholdPx)
  const distance = measurement.scrollHeight
    - (measurement.scrollTop + measurement.viewportHeight)
  return distance <= threshold
}

export function revealEditorLine(
  editor: monaco.editor.ICodeEditor,
  line: number,
  strategy: 'bottom' | 'centerIfOutside' | 'center',
  scrollType?: unknown,
) {
  if (strategy === 'bottom') {
    if (typeof scrollType !== 'undefined')
      editor.revealLine(line, scrollType as any)
    else
      editor.revealLine(line)
    return
  }

  if (strategy === 'center') {
    if (typeof scrollType !== 'undefined')
      editor.revealLineInCenter(line, scrollType as any)
    else
      editor.revealLineInCenter(line)
    return
  }

  if (typeof scrollType !== 'undefined')
    editor.revealLineInCenterIfOutsideViewport(line, scrollType as any)
  else
    editor.revealLineInCenterIfOutsideViewport(line)
}

export function waitForElementHeightApplied(
  element: HTMLElement | null,
  target: number,
  timeoutMs = 500,
) {
  return new Promise<void>((resolve) => {
    const start = typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now()

    const check = () => {
      const applied = element
        ? Number.parseFloat((element.style.height || '').replace('px', '')) || 0
        : -1
      if (applied >= target - 1) {
        resolve()
        return
      }
      const now = typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now()
      if (now - start > timeoutMs) {
        resolve()
        return
      }
      requestAnimationFrame(check)
    }

    check()
  })
}
