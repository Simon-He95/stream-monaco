import type { DiffHunkActionContext, DiffHunkActionKind, DiffHunkSide, MonacoLanguage, MonacoOptions } from '../type'
import { processedLanguage } from '../code.detect'
import { defaultRevealBatchOnIdleMs, defaultRevealDebounceMs, defaultScrollbar, minimalEditMaxChangeRatio, minimalEditMaxChars, padding } from '../constant'
import { computeMinimalEdit } from '../minimalEdit'
import * as monaco from '../monaco-shim'
import { createHeightManager } from '../utils/height'
import { log } from '../utils/logger'
import { createRafScheduler } from '../utils/raf'
import { createScrollWatcherForEditor } from '../utils/scroll'

type DiffEditorSide = 'original' | 'modified'

export class DiffEditorManager {
  private static readonly diffUiStyleId = 'stream-monaco-diff-ui-style'
  private diffEditorView: monaco.editor.IStandaloneDiffEditor | null = null
  private originalModel: monaco.editor.ITextModel | null = null
  private modifiedModel: monaco.editor.ITextModel | null = null
  private lastContainer: HTMLElement | null = null

  private lastKnownOriginalCode: string | null = null
  private lastKnownModifiedCode: string | null = null
  private lastKnownModifiedLineCount: number | null = null
  private pendingDiffUpdate: { original: string, modified: string, lang?: string } | null = null

  private shouldAutoScrollDiff = true
  private diffScrollWatcher: monaco.IDisposable | null = null
  private lastScrollTopDiff = 0
  private _hasScrollBar = false

  private cachedScrollHeightDiff: number | null = null
  private cachedLineHeightDiff: number | null = null
  private cachedComputedHeightDiff: number | null = null
  private lastKnownModifiedDirty = false

  // Read a batch of viewport/layout metrics for modified editor once to avoid repeated DOM reads
  private measureViewportDiff() {
    if (!this.diffEditorView)
      return null
    const me = this.diffEditorView.getModifiedEditor()
    const li = me.getLayoutInfo?.() ?? null
    const lineHeight = this.cachedLineHeightDiff ?? me.getOption(monaco.editor.EditorOption.lineHeight)
    const scrollTop = me.getScrollTop?.() ?? this.lastScrollTopDiff ?? 0
    const scrollHeight = me.getScrollHeight?.() ?? this.cachedScrollHeightDiff ?? (li?.height ?? 0)
    const computedHeight = this.cachedComputedHeightDiff ?? this.computedHeight()
    this.cachedLineHeightDiff = lineHeight
    this.cachedScrollHeightDiff = scrollHeight
    this.cachedComputedHeightDiff = computedHeight
    this.lastScrollTopDiff = scrollTop
    return { me, li, lineHeight, scrollTop, scrollHeight, computedHeight }
  }

  // track last revealed line to dedupe repeated reveals (prevent jitter)
  private lastRevealLineDiff: number | null = null
  // track last performed reveal ticket to dedupe/stale-check reveals
  private revealTicketDiff = 0
  // debounce id for reveal to coalesce rapid calls (ms)
  private revealDebounceIdDiff: number | null = null
  private readonly revealDebounceMs = defaultRevealDebounceMs
  // idle timer for final batch reveal
  private revealIdleTimerIdDiff: number | null = null
  private revealStrategyOption?: 'bottom' | 'centerIfOutside' | 'center'
  private revealBatchOnIdleMsOption?: number
  private readonly scrollWatcherSuppressionMs = 500
  private diffScrollWatcherSuppressionTimer: number | null = null

  private appendBufferOriginalDiff: string[] = []
  private appendBufferModifiedDiff: string[] = []
  private appendBufferDiffScheduled = false
  private diffUpdateThrottleMs = 50
  private lastAppendFlushTimeDiff = 0
  private appendFlushThrottleTimerDiff: number | null = null

  private rafScheduler = createRafScheduler()
  private diffHeightManager: ReturnType<typeof createHeightManager> | null = null
  private diffHunkDisposables: monaco.IDisposable[] = []
  private diffHunkOverlay: HTMLDivElement | null = null
  private diffHunkUpperNode: HTMLDivElement | null = null
  private diffHunkLowerNode: HTMLDivElement | null = null
  private diffHunkActiveChange: monaco.editor.ILineChange | null = null
  private diffHunkLineChanges: monaco.editor.ILineChange[] = []
  private diffHunkFallbackLineChanges: monaco.editor.ILineChange[] = []
  private diffHunkFallbackVersions: { original: number, modified: number } | null = null
  private diffHunkHideTimer: number | null = null
  private diffUnchangedRegionDisposables: monaco.IDisposable[] = []
  private diffUnchangedRegionObserver: MutationObserver | null = null
  private diffUnchangedBridgeOverlay: HTMLDivElement | null = null
  private diffUnchangedBridgeDisposables: monaco.IDisposable[] = []
  private diffPersistedUnchangedModelState: monaco.editor.IDiffEditorViewState['modelState'] | null = null

  constructor(
    private options: MonacoOptions,
    private maxHeightValue: number,
    private maxHeightCSS: string,
    private autoScrollOnUpdate: boolean,
    private autoScrollInitial: boolean,
    private autoScrollThresholdPx: number,
    private autoScrollThresholdLines: number,
    private diffAutoScroll: boolean,
    private revealDebounceMsOption?: number,
    private diffUpdateThrottleMsOption?: number,
  ) { }

  private resolveDiffHideUnchangedRegionsOption(): NonNullable<monaco.editor.IDiffEditorConstructionOptions['hideUnchangedRegions']> {
    const normalize = (value: unknown): NonNullable<monaco.editor.IDiffEditorConstructionOptions['hideUnchangedRegions']> => {
      if (typeof value === 'boolean')
        return { enabled: value }
      if (value && typeof value === 'object') {
        const raw = value as monaco.editor.IDiffEditorConstructionOptions['hideUnchangedRegions']
        return {
          enabled: (raw as any).enabled ?? true,
          ...(raw as object),
        }
      }
      return { enabled: false }
    }

    const direct = (this.options as monaco.editor.IDiffEditorConstructionOptions).hideUnchangedRegions
    if (typeof direct !== 'undefined')
      return normalize(direct)

    const viaOption = this.options.diffHideUnchangedRegions
    if (typeof viaOption !== 'undefined')
      return normalize(viaOption)

    return {
      enabled: true,
      contextLineCount: 3,
      minimumLineCount: 3,
      revealLineCount: 3,
    }
  }

  private disposeDiffHunkInteractions() {
    if (this.diffHunkHideTimer != null) {
      clearTimeout(this.diffHunkHideTimer)
      this.diffHunkHideTimer = null
    }
    this.diffHunkActiveChange = null
    this.diffHunkLineChanges = []
    this.diffHunkFallbackLineChanges = []
    this.diffHunkFallbackVersions = null

    if (this.diffHunkDisposables.length > 0) {
      for (const d of this.diffHunkDisposables) {
        try {
          d.dispose()
        }
        catch { }
      }
      this.diffHunkDisposables.length = 0
    }

    if (this.diffHunkOverlay) {
      this.diffHunkOverlay.remove()
      this.diffHunkOverlay = null
    }
    this.diffHunkUpperNode = null
    this.diffHunkLowerNode = null
  }

  private computeLineChangesFallback(
    originalModel: monaco.editor.ITextModel,
    modifiedModel: monaco.editor.ITextModel,
  ): monaco.editor.ILineChange[] {
    const original = originalModel.getValue().split(/\r?\n/)
    const modified = modifiedModel.getValue().split(/\r?\n/)
    const n = original.length
    const m = modified.length
    if (n === 0 && m === 0)
      return []

    // Bound worst-case CPU/memory for fallback mode.
    const maxCells = 1_500_000
    if ((n + 1) * (m + 1) > maxCells) {
      return originalModel.getValue() === modifiedModel.getValue()
        ? []
        : [{
            originalStartLineNumber: 1,
            originalEndLineNumber: n,
            modifiedStartLineNumber: 1,
            modifiedEndLineNumber: m,
            charChanges: [],
          }]
    }

    const cols = m + 1
    const dp = new Uint32Array((n + 1) * (m + 1))
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const idx = i * cols + j
        if (original[i - 1] === modified[j - 1]) {
          dp[idx] = dp[(i - 1) * cols + (j - 1)] + 1
        }
        else {
          const top = dp[(i - 1) * cols + j]
          const left = dp[i * cols + (j - 1)]
          dp[idx] = top >= left ? top : left
        }
      }
    }

    const matches: Array<{ o: number, m: number }> = []
    let i = n
    let j = m
    while (i > 0 && j > 0) {
      if (original[i - 1] === modified[j - 1]) {
        matches.push({ o: i, m: j })
        i--
        j--
      }
      else {
        const top = dp[(i - 1) * cols + j]
        const left = dp[i * cols + (j - 1)]
        if (top >= left)
          i--
        else j--
      }
    }
    matches.reverse()
    matches.push({ o: n + 1, m: m + 1 })

    const lineChanges: monaco.editor.ILineChange[] = []
    let prevO = 1
    let prevM = 1
    for (const match of matches) {
      const oStart = prevO
      const oEnd = match.o - 1
      const mStart = prevM
      const mEnd = match.m - 1
      const hasOriginal = oStart <= oEnd
      const hasModified = mStart <= mEnd
      if (hasOriginal || hasModified) {
        lineChanges.push({
          originalStartLineNumber: hasOriginal ? oStart : oStart,
          originalEndLineNumber: hasOriginal ? oEnd : (oStart - 1),
          modifiedStartLineNumber: hasModified ? mStart : mStart,
          modifiedEndLineNumber: hasModified ? mEnd : (mStart - 1),
          charChanges: [],
        })
      }
      prevO = match.o + 1
      prevM = match.m + 1
    }
    return lineChanges
  }

  private getEffectiveLineChanges() {
    if (!this.diffEditorView)
      return []

    const nativeLineChanges = this.diffEditorView.getLineChanges()
    if (nativeLineChanges) {
      this.diffHunkFallbackLineChanges = []
      this.diffHunkFallbackVersions = null
      return nativeLineChanges
    }

    if (!this.originalModel || !this.modifiedModel)
      return []

    const versions = {
      original: this.originalModel.getAlternativeVersionId(),
      modified: this.modifiedModel.getAlternativeVersionId(),
    }
    if (
      this.diffHunkFallbackVersions
      && this.diffHunkFallbackVersions.original === versions.original
      && this.diffHunkFallbackVersions.modified === versions.modified
    ) {
      return this.diffHunkFallbackLineChanges
    }

    this.diffHunkFallbackLineChanges = this.computeLineChangesFallback(
      this.originalModel,
      this.modifiedModel,
    )
    this.diffHunkFallbackVersions = versions
    return this.diffHunkFallbackLineChanges
  }

  private ensureDiffUiStyle() {
    if (typeof document === 'undefined')
      return
    if (document.getElementById(DiffEditorManager.diffUiStyleId))
      return
    const style = document.createElement('style')
    style.id = DiffEditorManager.diffUiStyleId
    style.textContent = `
.stream-monaco-diff-root {
  --stream-monaco-unchanged-fg: var(--vscode-diffEditor-unchangedRegionForeground, var(--vscode-editor-foreground, currentColor));
  --stream-monaco-unchanged-bg: var(--vscode-diffEditor-unchangedRegionBackground, transparent);
  --stream-monaco-editor-bg: var(--vscode-editor-background, #fff);
  --stream-monaco-widget-shadow: var(--vscode-widget-shadow, rgb(0 0 0 / 30%));
  --stream-monaco-focus: var(--vscode-focusBorder, var(--stream-monaco-unchanged-fg));
  --stream-monaco-surface: color-mix(in srgb, var(--stream-monaco-unchanged-bg) 82%, var(--stream-monaco-editor-bg) 18%);
  --stream-monaco-surface-hover: color-mix(in srgb, var(--stream-monaco-unchanged-bg) 72%, var(--stream-monaco-editor-bg) 28%);
  --stream-monaco-surface-soft: color-mix(in srgb, var(--stream-monaco-unchanged-bg) 55%, transparent);
  --stream-monaco-border: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 20%, transparent);
  --stream-monaco-border-strong: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 34%, transparent);
  --stream-monaco-muted: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 72%, transparent);
  --stream-monaco-accent-soft: color-mix(in srgb, var(--stream-monaco-focus) 18%, transparent);
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines-widget {
  pointer-events: auto;
  box-sizing: border-box;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines {
  height: auto;
  width: 100%;
  transform: translateY(-10px);
  padding: 4px 4px 6px;
  box-sizing: border-box;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .top,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .bottom {
  display: none !important;
  pointer-events: none !important;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center {
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 6px);
  min-height: 32px;
  margin: 0 auto;
  padding: 4px 10px 4px 8px;
  border-radius: 14px;
  border: 1px solid var(--stream-monaco-border);
  background: linear-gradient(180deg, var(--stream-monaco-surface) 0%, color-mix(in srgb, var(--stream-monaco-surface) 92%, var(--stream-monaco-editor-bg) 8%) 100%);
  box-shadow: 0 14px 26px -22px var(--stream-monaco-widget-shadow);
  box-sizing: border-box;
  overflow: hidden;
  transition: background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-clickable {
  cursor: pointer;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-bridge-source {
  opacity: 0;
  pointer-events: none;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  transform: none !important;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-bridge-source > * {
  visibility: hidden;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-merged-secondary {
  padding-left: 10px;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center:hover,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-focus-within {
  background: linear-gradient(180deg, var(--stream-monaco-surface-hover) 0%, color-mix(in srgb, var(--stream-monaco-surface-hover) 92%, var(--stream-monaco-editor-bg) 8%) 100%);
  border-color: var(--stream-monaco-border-strong);
  box-shadow: 0 18px 30px -24px var(--stream-monaco-widget-shadow);
  transform: translateY(-1px);
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-merged-secondary .stream-monaco-unchanged-primary {
  display: none !important;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-primary,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-primary {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  width: auto !important;
  min-width: max-content;
  overflow: visible;
  justify-content: flex-start !important;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-primary {
  width: 100% !important;
  justify-content: center !important;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-expand,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-expand {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  text-decoration: none;
  color: inherit;
  background: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--stream-monaco-unchanged-fg) 10%, transparent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
  white-space: nowrap;
  transition: background-color 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-expand {
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-expand::after,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-expand::after {
  content: attr(data-stream-monaco-label);
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-expand:hover,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-expand:focus-visible,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-expand:hover {
  background: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 18%, transparent);
  border-color: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 22%, transparent);
  transform: translateY(-1px);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-expand:hover {
  background: transparent;
  border-color: transparent;
  transform: none;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-meta,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--stream-monaco-muted);
  white-space: nowrap;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-merged-secondary .stream-monaco-unchanged-meta {
  justify-content: center;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-count,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-count {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--stream-monaco-surface-soft);
  color: var(--stream-monaco-unchanged-fg);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-separator {
  flex: 0 0 auto;
  opacity: 0.35;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-breadcrumb,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .breadcrumb-item {
  min-width: 0;
  max-width: 100%;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-breadcrumb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 6px;
  padding: 2px 6px;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-breadcrumb:hover {
  background: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 10%, transparent);
  color: var(--stream-monaco-unchanged-fg);
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-merged-secondary .stream-monaco-unchanged-separator,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-merged-secondary .stream-monaco-unchanged-breadcrumb {
  display: none;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 12;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge {
  position: absolute;
  display: grid;
  grid-template-columns: minmax(max-content, 1fr) auto minmax(max-content, 1fr);
  align-items: center;
  column-gap: 12px;
  min-height: 32px;
  padding: 4px 12px 4px 10px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--stream-monaco-unchanged-fg) 24%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--stream-monaco-editor-bg) 88%, var(--stream-monaco-unchanged-fg) 12%) 0%, color-mix(in srgb, var(--stream-monaco-editor-bg) 94%, var(--stream-monaco-unchanged-fg) 6%) 100%);
  box-shadow: 0 14px 26px -22px var(--stream-monaco-widget-shadow);
  box-sizing: border-box;
  overflow: hidden;
  pointer-events: auto;
  transition: background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge:hover,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-focus-visible {
  background: linear-gradient(180deg, color-mix(in srgb, var(--stream-monaco-editor-bg) 84%, var(--stream-monaco-unchanged-fg) 16%) 0%, color-mix(in srgb, var(--stream-monaco-editor-bg) 92%, var(--stream-monaco-unchanged-fg) 8%) 100%);
  border-color: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 32%, transparent);
  box-shadow: 0 18px 30px -24px var(--stream-monaco-widget-shadow);
  transform: translateY(-1px);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge:focus {
  outline: none;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-meta {
  justify-self: center;
  justify-content: center;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-spacer {
  display: block;
  visibility: hidden;
  width: 100%;
  height: 1px;
  flex: 0 0 auto;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines-compact {
  align-items: center;
  gap: 6px;
  height: 16px;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines-compact .text {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--stream-monaco-surface-soft);
  color: var(--stream-monaco-unchanged-fg);
}
.stream-monaco-diff-root .monaco-editor .fold-unchanged {
  display: flex !important;
  align-items: center;
  justify-content: center;
  width: 18px !important;
  height: 18px !important;
  margin-left: 4px;
  border-radius: 999px;
  color: var(--stream-monaco-unchanged-fg);
  background: var(--stream-monaco-surface);
  border: 1px solid var(--stream-monaco-border);
  box-shadow: 0 10px 18px -18px var(--stream-monaco-widget-shadow);
  opacity: 0.88 !important;
  transition: background-color 0.14s ease, border-color 0.14s ease, transform 0.14s ease, opacity 0.14s ease, box-shadow 0.14s ease;
}
.stream-monaco-diff-root .monaco-editor .fold-unchanged:hover,
.stream-monaco-diff-root .monaco-editor .fold-unchanged.stream-monaco-focus-visible {
  opacity: 1 !important;
  transform: translateY(-1px);
  background: var(--stream-monaco-surface-hover);
  border-color: var(--stream-monaco-border-strong);
  box-shadow: 0 14px 24px -18px var(--stream-monaco-widget-shadow);
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center:focus,
.stream-monaco-diff-root .monaco-editor .fold-unchanged:focus {
  outline: none;
}
.stream-monaco-diff-hunk-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 20;
}
.stream-monaco-diff-hunk-actions {
  position: absolute;
  left: 0;
  top: 0;
  display: none;
  gap: 6px;
  pointer-events: auto;
  padding: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, #f8f8f8 92%, #000 8%);
  border: 1px solid color-mix(in srgb, #ddd 88%, #000 12%);
  box-shadow: 0 2px 12px rgb(0 0 0 / 10%);
}
.stream-monaco-diff-hunk-actions button {
  appearance: none;
  border: 0;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  line-height: 1.35;
  background: white;
  color: #222;
  cursor: pointer;
}
.stream-monaco-diff-hunk-actions button:hover {
  background: #f1f1f1;
}
.stream-monaco-diff-hunk-actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
`
    document.head.append(style)
  }

  private createDomDisposable(
    bucket: monaco.IDisposable[],
    el: HTMLElement,
    eventName: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    el.addEventListener(eventName, listener)
    bucket.push({
      dispose: () => el.removeEventListener(eventName, listener),
    })
  }

  private createDiffHunkActionNode(side: DiffHunkSide): HTMLDivElement {
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
        this.applyDiffHunkAction(side, action)
      })
      return button
    }

    node.append(createButton('revert', 'Revert'), createButton('stage', 'Stage'))

    this.createDomDisposable(this.diffHunkDisposables, node, 'mouseenter', () => this.cancelScheduledHideDiffHunkActions())
    this.createDomDisposable(this.diffHunkDisposables, node, 'mouseleave', () => this.scheduleHideDiffHunkActions())
    return node
  }

  private cloneSerializableValue<T>(value: T): T {
    if (typeof structuredClone === 'function')
      return structuredClone(value)
    return JSON.parse(JSON.stringify(value)) as T
  }

  private capturePersistedDiffUnchangedState() {
    if (!this.diffEditorView)
      return
    const state = this.diffEditorView.saveViewState()
    if (!state?.modelState) {
      this.diffPersistedUnchangedModelState = null
      return
    }
    this.diffPersistedUnchangedModelState = this.cloneSerializableValue(state.modelState)
  }

  private scheduleCapturePersistedDiffUnchangedState(frames = 1) {
    this.rafScheduler.schedule('capture-diff-unchanged-state', () => {
      let remaining = Math.max(0, frames)
      const step = () => {
        if (remaining > 0) {
          remaining--
          requestAnimationFrame(step)
          return
        }
        this.capturePersistedDiffUnchangedState()
      }
      step()
    })
  }

  private restorePersistedDiffUnchangedState() {
    if (!this.diffEditorView || !this.diffPersistedUnchangedModelState)
      return
    const current = this.diffEditorView.saveViewState()
    if (!current)
      return
    this.diffEditorView.restoreViewState({
      original: current.original,
      modified: current.modified,
      modelState: this.cloneSerializableValue(this.diffPersistedUnchangedModelState),
    })
  }

  private scheduleRestorePersistedDiffUnchangedState() {
    if (!this.diffPersistedUnchangedModelState)
      return
    this.rafScheduler.schedule('restore-diff-unchanged-state', () => {
      requestAnimationFrame(() => {
        this.restorePersistedDiffUnchangedState()
      })
    })
  }

  private bindPersistOnMouseRelease(bucket: monaco.IDisposable[], node: HTMLElement) {
    this.createDomDisposable(bucket, node, 'mousedown', (event) => {
      const mouseEvent = event as MouseEvent
      if (mouseEvent.button !== 0)
        return
      const view = node.ownerDocument.defaultView
      if (!view)
        return
      const handleMouseUp = () => {
        view.removeEventListener('mouseup', handleMouseUp)
        this.scheduleCapturePersistedDiffUnchangedState(1)
      }
      view.addEventListener('mouseup', handleMouseUp, { once: true })
    })
  }

  private disposeDiffUnchangedRegionEnhancements() {
    if (this.diffUnchangedRegionObserver) {
      this.diffUnchangedRegionObserver.disconnect()
      this.diffUnchangedRegionObserver = null
    }

    this.clearDiffUnchangedBridgeOverlay()

    if (this.diffUnchangedRegionDisposables.length > 0) {
      for (const d of this.diffUnchangedRegionDisposables) {
        try {
          d.dispose()
        }
        catch { }
      }
      this.diffUnchangedRegionDisposables.length = 0
    }

    this.rafScheduler.cancel('patch-diff-unchanged-regions')
    this.rafScheduler.cancel('capture-diff-unchanged-state')
    this.rafScheduler.cancel('restore-diff-unchanged-state')
  }

  private bindFocusVisibleClass(bucket: monaco.IDisposable[], node: HTMLElement) {
    this.createDomDisposable(bucket, node, 'focus', () => node.classList.add('stream-monaco-focus-visible'))
    this.createDomDisposable(bucket, node, 'blur', () => node.classList.remove('stream-monaco-focus-visible'))
  }

  private bindFocusWithinClass(bucket: monaco.IDisposable[], node: HTMLElement, className: string) {
    this.createDomDisposable(bucket, node, 'focusin', () => node.classList.add(className))
    this.createDomDisposable(bucket, node, 'focusout', () => {
      requestAnimationFrame(() => {
        if (node.matches(':focus-within'))
          return
        node.classList.remove(className)
      })
    })
  }

  private clearDiffUnchangedBridgeOverlay(removeContainer = true) {
    if (this.lastContainer) {
      const bridgedCenters = this.lastContainer.querySelectorAll<HTMLElement>('.stream-monaco-unchanged-bridge-source')
      bridgedCenters.forEach(node => node.classList.remove('stream-monaco-unchanged-bridge-source'))
    }

    if (this.diffUnchangedBridgeOverlay)
      this.diffUnchangedBridgeOverlay.replaceChildren()

    if (this.diffUnchangedBridgeDisposables.length > 0) {
      for (const d of this.diffUnchangedBridgeDisposables) {
        try {
          d.dispose()
        }
        catch { }
      }
      this.diffUnchangedBridgeDisposables.length = 0
    }

    if (removeContainer && this.diffUnchangedBridgeOverlay?.parentElement)
      this.diffUnchangedBridgeOverlay.remove()
    if (removeContainer)
      this.diffUnchangedBridgeOverlay = null
  }

  private ensureDiffUnchangedBridgeOverlay() {
    if (!this.lastContainer)
      return null
    if (!this.diffUnchangedBridgeOverlay) {
      const overlay = document.createElement('div')
      overlay.className = 'stream-monaco-diff-unchanged-overlay'
      this.lastContainer.append(overlay)
      this.diffUnchangedBridgeOverlay = overlay
    }
    return this.diffUnchangedBridgeOverlay
  }

  private dispatchSyntheticMouseDown(node: HTMLElement) {
    const view = node.ownerDocument.defaultView
    if (!view)
      return
    const rect = node.getBoundingClientRect()
    node.dispatchEvent(new view.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + (rect.width / 2),
      clientY: rect.top + (rect.height / 2),
    }))
  }

  private resolveDiffUnchangedMergeRole(node: HTMLElement): 'none' | 'primary' | 'secondary' {
    const diffRoot = node.closest('.monaco-diff-editor.side-by-side')
    if (!(diffRoot instanceof HTMLElement))
      return 'none'

    const nodeRect = node.getBoundingClientRect()
    const nodeCenter = nodeRect.left + (nodeRect.width / 2)
    const originalHost = this.diffEditorView?.getOriginalEditor().getContainerDomNode?.()
    const modifiedHost = this.diffEditorView?.getModifiedEditor().getContainerDomNode?.()

    if (originalHost instanceof HTMLElement && modifiedHost instanceof HTMLElement) {
      const originalRect = originalHost.getBoundingClientRect()
      const modifiedRect = modifiedHost.getBoundingClientRect()
      const originalCenter = originalRect.left + (originalRect.width / 2)
      const modifiedCenter = modifiedRect.left + (modifiedRect.width / 2)
      return Math.abs(nodeCenter - originalCenter) <= Math.abs(nodeCenter - modifiedCenter)
        ? 'secondary'
        : 'primary'
    }

    const diffRect = diffRoot.getBoundingClientRect()
    return nodeCenter < (diffRect.left + (diffRect.width / 2))
      ? 'secondary'
      : 'primary'
  }

  private patchDiffUnchangedCenter(node: HTMLElement) {
    node.classList.add('stream-monaco-clickable')
    node.title = 'Click to expand all hidden unchanged lines'
    const mergeRole = this.resolveDiffUnchangedMergeRole(node)
    const shouldUseMergedSecondary = mergeRole === 'secondary'
    node.classList.toggle('stream-monaco-unchanged-merged-secondary', shouldUseMergedSecondary)
    node.classList.toggle('stream-monaco-unchanged-merged-primary', mergeRole === 'primary')

    const primary = node.children.item(0)
    const meta = node.children.item(1)
    if (primary instanceof HTMLElement)
      primary.classList.add('stream-monaco-unchanged-primary')
    if (meta instanceof HTMLElement) {
      meta.classList.add('stream-monaco-unchanged-meta')
      const metaChildren = Array.from(meta.children)
      metaChildren.forEach((child, index) => {
        if (!(child instanceof HTMLElement))
          return
        child.classList.remove(
          'stream-monaco-unchanged-count',
          'stream-monaco-unchanged-separator',
          'stream-monaco-unchanged-breadcrumb',
        )
        if (index === 0)
          child.classList.add('stream-monaco-unchanged-count')
        else if (child.classList.contains('breadcrumb-item'))
          child.classList.add('stream-monaco-unchanged-breadcrumb')
        else child.classList.add('stream-monaco-unchanged-separator')
      })
    }

    const action = node.querySelector('a')
    if (action instanceof HTMLElement) {
      action.classList.add('stream-monaco-unchanged-expand')
      action.dataset.streamMonacoLabel = 'Expand all'
      action.title = 'Expand all hidden lines'
      action.setAttribute('aria-label', 'Expand all hidden lines')
      action.toggleAttribute('aria-hidden', shouldUseMergedSecondary)
      action.tabIndex = shouldUseMergedSecondary ? -1 : 0
      if (action.dataset.streamMonacoExpandPatched !== 'true') {
        action.dataset.streamMonacoExpandPatched = 'true'
        this.createDomDisposable(this.diffUnchangedRegionDisposables, action, 'click', () => {
          this.scheduleCapturePersistedDiffUnchangedState(1)
        })
      }
    }

    if (node.dataset.streamMonacoCenterPatched !== 'true') {
      node.dataset.streamMonacoCenterPatched = 'true'
      this.bindFocusWithinClass(this.diffUnchangedRegionDisposables, node, 'stream-monaco-focus-within')

      const activate = () => {
        const action = node.querySelector('a')
        if (action instanceof HTMLElement)
          action.click()
      }

      this.createDomDisposable(this.diffUnchangedRegionDisposables, node, 'click', (event) => {
        const mouseEvent = event as MouseEvent
        if (mouseEvent.button !== 0)
          return
        const target = event.target instanceof HTMLElement ? event.target : null
        if (target?.closest('a, .breadcrumb-item'))
          return
        event.preventDefault()
        activate()
        this.scheduleCapturePersistedDiffUnchangedState(1)
      })
    }
  }

  private renderMergedDiffUnchangedBridge(secondaryNode: HTMLElement, primaryNode: HTMLElement) {
    if (!this.lastContainer)
      return
    const overlay = this.ensureDiffUnchangedBridgeOverlay()
    if (!overlay)
      return

    const containerRect = this.lastContainer.getBoundingClientRect()
    const secondaryRect = secondaryNode.getBoundingClientRect()
    const primaryRect = primaryNode.getBoundingClientRect()
    const primaryStyle = globalThis.getComputedStyle(primaryNode)
    const primaryAction = primaryNode.querySelector<HTMLElement>('.stream-monaco-unchanged-expand')
    const primaryActionRect = primaryAction?.getBoundingClientRect()
    const countSource = primaryNode.querySelector<HTMLElement>('.stream-monaco-unchanged-count')
      ?? secondaryNode.querySelector<HTMLElement>('.stream-monaco-unchanged-count')
    const countText = countSource?.textContent?.trim() || 'Hidden lines'
    const editorSurface = primaryNode.closest<HTMLElement>('.monaco-editor') ?? primaryNode
    const editorSurfaceStyle = globalThis.getComputedStyle(editorSurface)

    secondaryNode.classList.add('stream-monaco-unchanged-bridge-source')
    primaryNode.classList.add('stream-monaco-unchanged-bridge-source')

    const bridge = document.createElement('div')
    bridge.className = 'stream-monaco-diff-unchanged-bridge'
    bridge.tabIndex = 0
    bridge.setAttribute('role', 'button')
    bridge.setAttribute('aria-label', `${countText}. Expand all hidden lines`)
    bridge.title = 'Expand all hidden lines'
    bridge.style.left = `${secondaryRect.left - containerRect.left}px`
    bridge.style.top = `${primaryRect.top - containerRect.top}px`
    bridge.style.width = `${primaryRect.right - secondaryRect.left}px`
    bridge.style.height = `${Math.max(secondaryRect.height, primaryRect.height)}px`
    bridge.style.color = primaryStyle.color
    bridge.style.fontFamily = primaryStyle.fontFamily
    bridge.style.fontSize = primaryStyle.fontSize
    bridge.style.lineHeight = primaryStyle.lineHeight
    bridge.style.setProperty('--stream-monaco-unchanged-fg', primaryStyle.color)
    bridge.style.setProperty('--stream-monaco-editor-bg', editorSurfaceStyle.backgroundColor)

    const visualPrimary = document.createElement('span')
    visualPrimary.className = 'stream-monaco-unchanged-primary'
    const visualAction = document.createElement('span')
    visualAction.className = 'stream-monaco-unchanged-expand'
    visualAction.dataset.streamMonacoLabel = 'Expand all'
    visualAction.setAttribute('aria-hidden', 'true')
    visualAction.innerHTML = '<span class="codicon codicon-unfold"></span>'
    visualPrimary.append(visualAction)

    const visualMeta = document.createElement('div')
    visualMeta.className = 'stream-monaco-unchanged-meta'
    const visualCount = document.createElement('span')
    visualCount.className = 'stream-monaco-unchanged-count'
    visualCount.textContent = countText
    visualMeta.append(visualCount)

    const spacer = document.createElement('span')
    spacer.className = 'stream-monaco-unchanged-spacer'
    spacer.style.width = `${primaryActionRect?.width ?? 102}px`

    bridge.append(visualPrimary, visualMeta, spacer)
    overlay.append(bridge)

    this.bindFocusVisibleClass(this.diffUnchangedBridgeDisposables, bridge)
    const activate = () => {
      const action = primaryNode.querySelector<HTMLElement>('a, button')
        ?? secondaryNode.querySelector<HTMLElement>('a, button')
      if (action instanceof HTMLElement) {
        action.click()
        this.scheduleCapturePersistedDiffUnchangedState(1)
      }
    }

    this.createDomDisposable(this.diffUnchangedBridgeDisposables, bridge, 'click', (event) => {
      const mouseEvent = event as MouseEvent
      if (mouseEvent.button !== 0)
        return
      event.preventDefault()
      activate()
    })
    this.createDomDisposable(this.diffUnchangedBridgeDisposables, bridge, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent
      if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ')
        return
      keyboardEvent.preventDefault()
      activate()
    })
  }

  private patchDiffUnchangedFoldGlyph(node: HTMLElement) {
    if (node.dataset.streamMonacoFoldGlyphPatched === 'true')
      return

    node.dataset.streamMonacoFoldGlyphPatched = 'true'
    node.tabIndex = 0
    node.setAttribute('role', 'button')
    node.setAttribute('aria-label', 'Collapse unchanged lines')
    node.title = node.title || 'Collapse unchanged lines'
    this.bindFocusVisibleClass(this.diffUnchangedRegionDisposables, node)
    this.bindPersistOnMouseRelease(this.diffUnchangedRegionDisposables, node)
    this.createDomDisposable(this.diffUnchangedRegionDisposables, node, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent
      if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ')
        return
      keyboardEvent.preventDefault()
      this.dispatchSyntheticMouseDown(node)
      this.scheduleCapturePersistedDiffUnchangedState(1)
    })
  }

  private scanAndPatchDiffUnchangedRegions() {
    if (!this.lastContainer)
      return

    const centers = this.lastContainer.querySelectorAll<HTMLElement>('.diff-hidden-lines .center')
    centers.forEach(node => this.patchDiffUnchangedCenter(node))
    const partialRevealHandles = this.lastContainer.querySelectorAll<HTMLElement>('.diff-hidden-lines .top, .diff-hidden-lines .bottom')
    partialRevealHandles.forEach((node) => {
      node.removeAttribute('title')
      node.removeAttribute('aria-label')
      node.removeAttribute('role')
      node.removeAttribute('tabindex')
    })
    this.clearDiffUnchangedBridgeOverlay(false)

    const secondaryCenters = Array.from(centers)
      .filter(node => node.classList.contains('stream-monaco-unchanged-merged-secondary'))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    const primaryCenters = Array.from(centers)
      .filter(node => node.classList.contains('stream-monaco-unchanged-merged-primary'))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)

    const pairCount = Math.min(secondaryCenters.length, primaryCenters.length)
    for (let i = 0; i < pairCount; i++) {
      const secondaryNode = secondaryCenters[i]
      const primaryNode = primaryCenters[i]
      const topDelta = Math.abs(secondaryNode.getBoundingClientRect().top - primaryNode.getBoundingClientRect().top)
      if (topDelta > 6)
        continue
      this.renderMergedDiffUnchangedBridge(secondaryNode, primaryNode)
    }

    const foldGlyphs = this.lastContainer.querySelectorAll<HTMLElement>('.fold-unchanged')
    foldGlyphs.forEach(node => this.patchDiffUnchangedFoldGlyph(node))
  }

  private schedulePatchDiffUnchangedRegions() {
    this.rafScheduler.schedule('patch-diff-unchanged-regions', () => {
      this.scanAndPatchDiffUnchangedRegions()
    })
  }

  private setupDiffUnchangedRegionEnhancements() {
    this.disposeDiffUnchangedRegionEnhancements()
    if (!this.diffEditorView || !this.lastContainer)
      return
    if (typeof document === 'undefined')
      return

    this.ensureDiffUiStyle()
    const containerStyle = globalThis.getComputedStyle?.(this.lastContainer)
    if (!containerStyle || containerStyle.position === 'static')
      this.lastContainer.style.position = 'relative'
    this.lastContainer.classList.add('stream-monaco-diff-root')
    this.schedulePatchDiffUnchangedRegions()

    if (typeof MutationObserver !== 'undefined') {
      this.diffUnchangedRegionObserver = new MutationObserver((mutations) => {
        const shouldRepatch = mutations.some((mutation) => {
          const target = mutation.target instanceof HTMLElement ? mutation.target : null
          if (target?.closest('.stream-monaco-diff-unchanged-overlay'))
            return false
          const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
          if (changedNodes.length > 0 && changedNodes.every((node) => {
            return node instanceof HTMLElement && node.classList.contains('stream-monaco-diff-unchanged-overlay')
          })) {
            return false
          }
          return true
        })
        if (shouldRepatch)
          this.schedulePatchDiffUnchangedRegions()
      })
      this.diffUnchangedRegionObserver.observe(this.lastContainer, {
        childList: true,
        subtree: true,
      })
    }

    const originalEditor = this.diffEditorView.getOriginalEditor()
    const modifiedEditor = this.diffEditorView.getModifiedEditor()
    const repatch = () => this.schedulePatchDiffUnchangedRegions()
    this.diffUnchangedRegionDisposables.push(this.diffEditorView.onDidUpdateDiff(() => {
      repatch()
      this.scheduleRestorePersistedDiffUnchangedState()
    }))
    this.diffUnchangedRegionDisposables.push(originalEditor.onDidLayoutChange(repatch))
    this.diffUnchangedRegionDisposables.push(modifiedEditor.onDidLayoutChange(repatch))
    this.diffUnchangedRegionDisposables.push(originalEditor.onDidScrollChange(repatch))
    this.diffUnchangedRegionDisposables.push(modifiedEditor.onDidScrollChange(repatch))
  }

  private setupDiffHunkInteractions() {
    this.disposeDiffHunkInteractions()
    if (!this.diffEditorView || !this.lastContainer)
      return
    if (this.options.diffHunkActionsOnHover !== true)
      return
    if (typeof document === 'undefined')
      return

    this.ensureDiffUiStyle()

    const containerStyle = globalThis.getComputedStyle?.(this.lastContainer)
    if (!containerStyle || containerStyle.position === 'static')
      this.lastContainer.style.position = 'relative'

    const overlay = document.createElement('div')
    overlay.className = 'stream-monaco-diff-hunk-overlay'
    this.diffHunkOverlay = overlay
    this.lastContainer.append(overlay)

    this.diffHunkUpperNode = this.createDiffHunkActionNode('upper')
    this.diffHunkLowerNode = this.createDiffHunkActionNode('lower')
    overlay.append(this.diffHunkUpperNode, this.diffHunkLowerNode)

    const originalEditor = this.diffEditorView.getOriginalEditor()
    const modifiedEditor = this.diffEditorView.getModifiedEditor()

    const bindHover = (
      editor: monaco.editor.IStandaloneCodeEditor,
      side: DiffEditorSide,
    ) => {
      this.diffHunkDisposables.push(editor.onMouseMove((event) => {
        this.handleDiffHunkMouseMove(side, event)
      }))
      this.diffHunkDisposables.push(editor.onMouseLeave(() => this.scheduleHideDiffHunkActions()))
      this.diffHunkDisposables.push(editor.onDidScrollChange(() => this.repositionDiffHunkNodes()))
      this.diffHunkDisposables.push(editor.onDidLayoutChange(() => this.repositionDiffHunkNodes()))
    }
    bindHover(originalEditor, 'original')
    bindHover(modifiedEditor, 'modified')

    this.diffHunkDisposables.push(this.diffEditorView.onDidUpdateDiff(() => {
      this.diffHunkLineChanges = this.getEffectiveLineChanges()
      if (this.diffHunkActiveChange)
        this.hideDiffHunkActions()
    }))
    this.diffHunkLineChanges = this.getEffectiveLineChanges()
  }

  private cancelScheduledHideDiffHunkActions() {
    if (this.diffHunkHideTimer != null) {
      clearTimeout(this.diffHunkHideTimer)
      this.diffHunkHideTimer = null
    }
  }

  private scheduleHideDiffHunkActions(delayMs = this.options.diffHunkHoverHideDelayMs ?? 160) {
    this.cancelScheduledHideDiffHunkActions()
    this.diffHunkHideTimer = (setTimeout(() => {
      this.diffHunkHideTimer = null
      this.hideDiffHunkActions()
    }, delayMs) as unknown) as number
  }

  private hideDiffHunkActions() {
    this.diffHunkActiveChange = null
    if (this.diffHunkUpperNode)
      this.diffHunkUpperNode.style.display = 'none'
    if (this.diffHunkLowerNode)
      this.diffHunkLowerNode.style.display = 'none'
  }

  private hasOriginalLines(change: monaco.editor.ILineChange) {
    return change.originalStartLineNumber > 0
      && change.originalEndLineNumber >= change.originalStartLineNumber
  }

  private hasModifiedLines(change: monaco.editor.ILineChange) {
    return change.modifiedStartLineNumber > 0
      && change.modifiedEndLineNumber >= change.modifiedStartLineNumber
  }

  private distanceToLineChange(
    side: DiffEditorSide,
    change: monaco.editor.ILineChange,
    line: number,
  ) {
    const hasRange = side === 'original'
      ? this.hasOriginalLines(change)
      : this.hasModifiedLines(change)
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

  private findLineChangeByHoverLine(
    side: DiffEditorSide,
    line: number,
  ) {
    if (this.diffHunkLineChanges.length === 0)
      return null

    let best: monaco.editor.ILineChange | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const change of this.diffHunkLineChanges) {
      const distance = this.distanceToLineChange(side, change, line)
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

  private handleDiffHunkMouseMove(
    side: DiffEditorSide,
    event: monaco.editor.IEditorMouseEvent,
  ) {
    const line = event.target.position?.lineNumber
    if (!line) {
      this.scheduleHideDiffHunkActions(120)
      return
    }
    const change = this.findLineChangeByHoverLine(side, line)
    if (!change) {
      this.scheduleHideDiffHunkActions(120)
      return
    }
    this.cancelScheduledHideDiffHunkActions()
    this.diffHunkActiveChange = change
    this.repositionDiffHunkNodes()
  }

  private isOriginalEditorCollapsed() {
    if (!this.diffEditorView)
      return true
    const info = this.diffEditorView.getOriginalEditor().getLayoutInfo?.()
    return !info || info.width < 24
  }

  private getEditorBySide(side: DiffEditorSide) {
    if (!this.diffEditorView)
      return null
    return side === 'original'
      ? this.diffEditorView.getOriginalEditor()
      : this.diffEditorView.getModifiedEditor()
  }

  private getFullLineRange(
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

  private getLinesText(
    model: monaco.editor.ITextModel,
    startLine: number,
    endLine: number,
  ) {
    const range = this.getFullLineRange(model, startLine, endLine)
    if (!range)
      return ''
    return model.getValueInRange(range)
  }

  private getInsertRangeBeforeLine(
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

  private getInsertRangeAfterLine(
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

  private syncDiffKnownValues() {
    if (this.originalModel)
      this.lastKnownOriginalCode = this.originalModel.getValue()
    if (this.modifiedModel) {
      this.lastKnownModifiedCode = this.modifiedModel.getValue()
      this.lastKnownModifiedLineCount = this.modifiedModel.getLineCount()
    }
    this.lastKnownModifiedDirty = false
    this._hasScrollBar = false
    this.cachedComputedHeightDiff = this.computedHeight()
    this.cachedScrollHeightDiff = this.diffEditorView?.getModifiedEditor().getScrollHeight?.() ?? this.cachedScrollHeightDiff
    this.diffHeightManager?.update()
  }

  private applyDefaultDiffHunkAction(context: DiffHunkActionContext) {
    const { action, side, lineChange } = context
    if (!this.originalModel || !this.modifiedModel)
      return

    const hasOriginal = this.hasOriginalLines(lineChange)
    const hasModified = this.hasModifiedLines(lineChange)

    if (action === 'revert' && side === 'upper') {
      if (!hasOriginal)
        return
      const text = this.getLinesText(
        this.originalModel,
        lineChange.originalStartLineNumber,
        lineChange.originalEndLineNumber,
      )
      if (!text)
        return
      const anchor = hasModified
        ? lineChange.modifiedStartLineNumber
        : Math.max(1, lineChange.modifiedStartLineNumber || lineChange.modifiedEndLineNumber || this.modifiedModel.getLineCount())
      const range = this.getInsertRangeBeforeLine(this.modifiedModel, anchor)
      this.modifiedModel.applyEdits([{ range, text, forceMoveMarkers: true }])
      return
    }

    if (action === 'revert' && side === 'lower') {
      if (!hasModified)
        return
      const range = this.getFullLineRange(
        this.modifiedModel,
        lineChange.modifiedStartLineNumber,
        lineChange.modifiedEndLineNumber,
      )
      if (!range)
        return
      this.modifiedModel.applyEdits([{ range, text: '', forceMoveMarkers: true }])
      return
    }

    if (action === 'stage' && side === 'upper') {
      if (!hasOriginal)
        return
      const range = this.getFullLineRange(
        this.originalModel,
        lineChange.originalStartLineNumber,
        lineChange.originalEndLineNumber,
      )
      if (!range)
        return
      this.originalModel.applyEdits([{ range, text: '', forceMoveMarkers: true }])
      return
    }

    if (action === 'stage' && side === 'lower') {
      if (!hasModified)
        return
      const text = this.getLinesText(
        this.modifiedModel,
        lineChange.modifiedStartLineNumber,
        lineChange.modifiedEndLineNumber,
      )
      if (!text)
        return
      const anchor = hasOriginal
        ? lineChange.originalEndLineNumber
        : Math.max(0, lineChange.originalStartLineNumber - 1)
      const range = this.getInsertRangeAfterLine(this.originalModel, anchor)
      this.originalModel.applyEdits([{ range, text, forceMoveMarkers: true }])
    }
  }

  private applyDiffHunkAction(side: DiffHunkSide, action: DiffHunkActionKind) {
    if (!this.diffHunkActiveChange || !this.originalModel || !this.modifiedModel)
      return

    this.flushOriginalAppendBufferSync()
    this.flushModifiedAppendBufferSync()

    const context: DiffHunkActionContext = {
      action,
      side,
      lineChange: this.diffHunkActiveChange,
      originalModel: this.originalModel,
      modifiedModel: this.modifiedModel,
    }

    let allowDefault = true
    if (typeof this.options.onDiffHunkAction === 'function') {
      try {
        allowDefault = this.options.onDiffHunkAction(context) !== false
      }
      catch (error) {
        console.warn('onDiffHunkAction callback threw an error:', error)
      }
    }

    if (allowDefault)
      this.applyDefaultDiffHunkAction(context)
    this.syncDiffKnownValues()
    this.hideDiffHunkActions()
  }

  private setDiffHunkNodeEnabled(
    node: HTMLDivElement | null,
    enabled: boolean,
  ) {
    if (!node)
      return
    const buttons = node.querySelectorAll('button')
    buttons.forEach((button) => {
      ; (button as HTMLButtonElement).disabled = !enabled
    })
  }

  private positionDiffHunkNode(
    node: HTMLDivElement,
    side: DiffEditorSide,
    anchorLine: number,
    extraOffsetY = 0,
  ) {
    if (!this.diffHunkOverlay)
      return
    const editor = this.getEditorBySide(side)
    if (!editor)
      return
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
      Math.max(minTop, hostTop + rawTop + Math.round(lineHeight * 0.2) + extraOffsetY),
    )
    node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
    node.style.display = 'flex'
  }

  private repositionDiffHunkNodes() {
    if (!this.diffHunkActiveChange) {
      this.hideDiffHunkActions()
      return
    }
    if (!this.diffHunkUpperNode || !this.diffHunkLowerNode)
      return
    if (!this.diffEditorView)
      return

    const change = this.diffHunkActiveChange
    const hasOriginal = this.hasOriginalLines(change)
    const hasModified = this.hasModifiedLines(change)
    this.setDiffHunkNodeEnabled(this.diffHunkUpperNode, hasOriginal)
    this.setDiffHunkNodeEnabled(this.diffHunkLowerNode, hasModified)

    const originalCollapsed = this.isOriginalEditorCollapsed()
    if (hasOriginal) {
      const upperSide: DiffEditorSide = originalCollapsed ? 'modified' : 'original'
      const upperAnchor = originalCollapsed
        ? Math.max(1, change.modifiedStartLineNumber || change.modifiedEndLineNumber || 1)
        : change.originalStartLineNumber
      this.positionDiffHunkNode(this.diffHunkUpperNode, upperSide, upperAnchor)
    }
    else {
      this.diffHunkUpperNode.style.display = 'none'
    }

    if (hasModified) {
      const samePane = originalCollapsed
      const lowerAnchor = change.modifiedStartLineNumber
      this.positionDiffHunkNode(
        this.diffHunkLowerNode,
        'modified',
        lowerAnchor,
        samePane ? 32 : 0,
      )
    }
    else {
      this.diffHunkLowerNode.style.display = 'none'
    }
  }

  private scheduleFlushAppendBufferDiff() {
    if (this.appendBufferDiffScheduled)
      return
    this.appendBufferDiffScheduled = true

    const schedule = () => {
      this.rafScheduler.schedule('appendDiff', () => this.flushAppendBufferDiff())
    }

    // 0 => pure RAF batching (legacy behavior)
    const throttle = this.diffUpdateThrottleMs
    if (!throttle) {
      schedule()
      return
    }

    const now = Date.now()
    const since = now - this.lastAppendFlushTimeDiff
    if (since >= throttle) {
      schedule()
      return
    }

    if (this.appendFlushThrottleTimerDiff != null)
      return
    const wait = throttle - since
    this.appendFlushThrottleTimerDiff = (setTimeout(() => {
      this.appendFlushThrottleTimerDiff = null
      schedule()
    }, wait) as unknown) as number
  }

  private flushOriginalAppendBufferSync() {
    if (!this.originalModel)
      return
    if (this.appendBufferOriginalDiff.length === 0)
      return
    // Prevent a scheduled async flush from applying the same content later.
    this.rafScheduler.cancel('appendDiff')
    this.appendBufferDiffScheduled = false
    const text = this.appendBufferOriginalDiff.join('')
    this.appendBufferOriginalDiff.length = 0
    if (!text)
      return
    this.appendToModel(this.originalModel, text)
  }

  private computedHeight(): number {
    if (!this.diffEditorView)
      return Math.min(1 * 18 + padding, this.maxHeightValue)
    const modifiedEditor = this.diffEditorView.getModifiedEditor()
    const originalEditor = this.diffEditorView.getOriginalEditor()
    const lineHeight = modifiedEditor.getOption(monaco.editor.EditorOption.lineHeight)
    const oCount = originalEditor.getModel()?.getLineCount() ?? 1
    const mCount = modifiedEditor.getModel()?.getLineCount() ?? 1
    const lineCount = Math.max(oCount, mCount)
    const fromLines = lineCount * lineHeight + padding
    // prefer rendered scrollHeight when available (covers view zones, inline diffs, wrapping)
    const scrollH = Math.max(originalEditor.getScrollHeight?.() ?? 0, modifiedEditor.getScrollHeight?.() ?? 0)
    const desired = Math.max(fromLines, scrollH)
    return Math.min(desired, this.maxHeightValue)
  }

  private isOverflowAutoDiff() {
    return !!this.lastContainer && this.lastContainer.style.overflow === 'auto'
  }

  private shouldPerformImmediateRevealDiff() {
    return this.autoScrollOnUpdate && this.shouldAutoScrollDiff && this.hasVerticalScrollbarModified() && this.isOverflowAutoDiff()
  }

  private suppressScrollWatcherDiff(ms: number) {
    if (!this.diffScrollWatcher || typeof (this.diffScrollWatcher as any).setSuppressed !== 'function')
      return
    // clear existing timer
    if (this.diffScrollWatcherSuppressionTimer != null) {
      clearTimeout(this.diffScrollWatcherSuppressionTimer)
      this.diffScrollWatcherSuppressionTimer = null
    }
    ; (this.diffScrollWatcher as any).setSuppressed(true)
    this.diffScrollWatcherSuppressionTimer = (setTimeout(() => {
      try {
        ; (this.diffScrollWatcher as any).setSuppressed(false)
      }
      catch { }
      this.diffScrollWatcherSuppressionTimer = null
    }, ms) as unknown) as number
  }

  private hasVerticalScrollbarModified(): boolean {
    if (!this.diffEditorView)
      return false
    if (this._hasScrollBar)
      return true
    const m = this.measureViewportDiff()
    if (!m)
      return false
    const epsilon = Math.max(2, Math.round(m.lineHeight / 8))
    return this._hasScrollBar = (m.scrollHeight > m.computedHeight + Math.max(padding / 2, epsilon))
  }

  private userIsNearBottomDiff(): boolean {
    if (!this.diffEditorView)
      return true
    const m = this.measureViewportDiff()
    if (!m || !m.li)
      return true
    const lineThreshold = (this.autoScrollThresholdLines ?? 0) * m.lineHeight
    const threshold = Math.max(lineThreshold || 0, this.autoScrollThresholdPx || 0)
    const distance = m.scrollHeight - (m.scrollTop + m.li.height)
    return distance <= threshold
  }

  private maybeScrollDiffToBottom(targetLine?: number, prevLineOverride?: number) {
    // Defer measurement and reveal work to RAF to avoid forcing sync layout during hot paths
    this.rafScheduler.schedule('maybe-scroll-diff', () => {
      log('diff', 'maybeScrollDiffToBottom called', { targetLine, prevLineOverride, diffAutoScroll: this.diffAutoScroll, autoScrollOnUpdate: this.autoScrollOnUpdate, shouldAutoScrollDiff: this.shouldAutoScrollDiff })
      if (!this.diffEditorView)
        return
      const hasV = this.hasVerticalScrollbarModified()
      log('diff', 'hasVerticalScrollbarModified ->', hasV)
      if (!(this.diffAutoScroll && this.autoScrollOnUpdate && this.shouldAutoScrollDiff && hasV))
        return
      const me = this.diffEditorView.getModifiedEditor()
      const model = me.getModel()
      const currentLine = model?.getLineCount() ?? 1
      const line = targetLine ?? currentLine

      const prevLine = (typeof prevLineOverride === 'number')
        ? prevLineOverride
        : (this.lastKnownModifiedLineCount ?? -1)
      log('diff', 'scroll metrics', { prevLine, currentLine, line, lastRevealLineDiff: this.lastRevealLineDiff })
      if (prevLine !== -1 && prevLine === currentLine && line === currentLine)
        return

      if (this.lastRevealLineDiff !== null && this.lastRevealLineDiff === line)
        return

      const batchMs = this.revealBatchOnIdleMsOption ?? this.options.revealBatchOnIdleMs ?? defaultRevealBatchOnIdleMs
      log('diff', 'reveal timing', { batchMs, revealDebounceMs: this.revealDebounceMs, revealDebounceMsOption: this.revealDebounceMsOption })
      if (typeof batchMs === 'number' && batchMs > 0) {
        // If a vertical scrollbar is present, don't wait for the idle batch
        // timer — reveal immediately (ticketed) so continuous streaming
        // keeps the viewport following new content.
        if (hasV) {
          const ticket = ++this.revealTicketDiff
          log('diff', 'has scrollbar -> immediate ticketed reveal', { ticket, line })
          this.performRevealDiffTicketed(line, ticket)
          return
        }
        if (this.revealIdleTimerIdDiff != null) {
          clearTimeout(this.revealIdleTimerIdDiff)
        }
        const ticket = ++this.revealTicketDiff
        log('diff', 'scheduling idle reveal', { ticket, batchMs, line })
        this.revealIdleTimerIdDiff = (setTimeout(() => {
          this.revealIdleTimerIdDiff = null
          this.performRevealDiffTicketed(line, ticket)
        }, batchMs) as unknown) as number
        return
      }

      if (this.revealDebounceIdDiff != null) {
        clearTimeout(this.revealDebounceIdDiff)
        this.revealDebounceIdDiff = null
      }
      const ms = (typeof this.revealDebounceMs === 'number' && this.revealDebounceMs > 0)
        ? this.revealDebounceMs
        : (typeof this.revealDebounceMsOption === 'number' && this.revealDebounceMsOption > 0)
            ? this.revealDebounceMsOption
            : this.revealDebounceMs
      this.revealDebounceIdDiff = (setTimeout(() => {
        this.revealDebounceIdDiff = null
        const ticket = ++this.revealTicketDiff
        log('diff', 'debounced reveal firing', { ticket, line })
        this.performRevealDiffTicketed(line, ticket)
      }, ms) as unknown) as number

      this.lastKnownModifiedLineCount = currentLine
    })
  }

  private performRevealDiffTicketed(line: number, ticket: number) {
    this.rafScheduler.schedule('revealDiff', () => {
      // Temporarily suppress scroll watcher to avoid misinterpreting programmatic scroll
      if (this.diffScrollWatcher) {
        log('diff', 'performRevealDiffTicketed - suppressing watcher', { ticket, line, ms: this.scrollWatcherSuppressionMs })
        this.suppressScrollWatcherDiff(this.scrollWatcherSuppressionMs)
      }
      if (ticket !== this.revealTicketDiff)
        return
      log('diff', 'performRevealDiffTicketed - performing reveal', { ticket, line })
      const strategy = this.revealStrategyOption ?? this.options.revealStrategy ?? 'centerIfOutside'
      const ScrollType: any = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
      const smooth = (ScrollType && typeof ScrollType.Smooth !== 'undefined') ? ScrollType.Smooth : undefined
      try {
        const me = this.diffEditorView!.getModifiedEditor()
        if (strategy === 'bottom') {
          if (typeof smooth !== 'undefined')
            me.revealLine(line, smooth)
          else me.revealLine(line)
        }
        else if (strategy === 'center') {
          if (typeof smooth !== 'undefined')
            me.revealLineInCenter(line, smooth)
          else me.revealLineInCenter(line)
        }
        else {
          if (typeof smooth !== 'undefined')
            me.revealLineInCenterIfOutsideViewport(line, smooth)
          else me.revealLineInCenterIfOutsideViewport(line)
        }
      }
      catch {
        try {
          this.diffEditorView!.getModifiedEditor().revealLine(line)
        }
        catch { }
      }
      this.lastRevealLineDiff = line
      log('diff', 'performRevealDiffTicketed - revealed', { line, lastRevealLineDiff: this.lastRevealLineDiff })
      try {
        this.shouldAutoScrollDiff = true
        this.lastScrollTopDiff = this.diffEditorView?.getModifiedEditor().getScrollTop?.() ?? this.lastScrollTopDiff
      }
      catch { }
    })
  }

  private performImmediateRevealDiff(line: number, ticket: number) {
    if (!this.diffEditorView)
      return
    if (ticket !== this.revealTicketDiff)
      return
    const ScrollType: any = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
    const immediate = (ScrollType && typeof ScrollType.Immediate !== 'undefined') ? ScrollType.Immediate : undefined
    const me = this.diffEditorView.getModifiedEditor()
    if (typeof immediate !== 'undefined')
      me.revealLine(line, immediate)
    else me.revealLine(line)
    this.measureViewportDiff()
    log('diff', 'performImmediateRevealDiff', { line, ticket })
    try {
      this.shouldAutoScrollDiff = true
      this.lastScrollTopDiff = this.diffEditorView?.getModifiedEditor().getScrollTop?.() ?? this.lastScrollTopDiff
    }
    catch { }
  }

  private scheduleImmediateRevealAfterLayoutDiff(line: number) {
    const ticket = ++this.revealTicketDiff
    this.rafScheduler.schedule('immediate-reveal-diff', async () => {
      const target = this.diffEditorView && this.diffHeightManager
        ? Math.min(this.computedHeight(), this.maxHeightValue)
        : -1
      if (target !== -1 && this.diffHeightManager) {
        if (this.lastContainer)
          this.lastContainer.style.height = `${target}px`
        await this.waitForHeightAppliedDiff(target)
      }
      else {
        // nothing
      }
      this.performImmediateRevealDiff(line, ticket)
    })
  }

  private waitForHeightAppliedDiff(target: number, timeoutMs = 500) {
    return new Promise<void>((resolve) => {
      const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
      const check = () => {
        const applied = this.lastContainer ? (Number.parseFloat((this.lastContainer.style.height || '').replace('px', '')) || 0) : -1
        if (applied >= target - 1) {
          resolve()
          return
        }
        if (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - start > timeoutMs) {
          resolve()
          return
        }
        requestAnimationFrame(check)
      }
      check()
    })
  }

  async createDiffEditor(
    container: HTMLElement,
    originalCode: string,
    modifiedCode: string,
    language: string,
    currentTheme: string,
  ) {
    this.cleanup()
    this.lastContainer = container

    // Start with hidden overflow so we don't show a scrollbar before the
    // editor reaches its configured max height. We'll toggle to `auto`
    // when the computed height reaches `maxHeightValue`.
    container.style.overflow = 'hidden'
    container.style.maxHeight = this.maxHeightCSS

    const lang = processedLanguage(language) || language
    this.originalModel = monaco.editor.createModel(originalCode, lang)
    this.modifiedModel = monaco.editor.createModel(modifiedCode, lang)
    const hideUnchangedRegions = this.resolveDiffHideUnchangedRegionsOption()

    this.diffEditorView = monaco.editor.createDiffEditor(container, {
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderSideBySide: true,
      originalEditable: false,
      readOnly: this.options.readOnly ?? true,
      minimap: { enabled: false },
      theme: currentTheme,
      contextmenu: false,
      scrollbar: {
        ...defaultScrollbar,
        ...(this.options.scrollbar || {}),
      },
      ...this.options,
      hideUnchangedRegions,
    })
    monaco.editor.setTheme(currentTheme)

    this.diffEditorView.setModel({ original: this.originalModel, modified: this.modifiedModel })

    this.lastKnownOriginalCode = originalCode
    this.lastKnownModifiedCode = modifiedCode

    // Default to 50ms throttling for diff streaming updates, unless overridden.
    // This helps the diff worker complete intermediate computations so highlights
    // can appear progressively during streaming.
    this.diffUpdateThrottleMs = this.diffUpdateThrottleMsOption ?? (this.options as any).diffUpdateThrottleMs ?? 50

    this.shouldAutoScrollDiff = !!(this.autoScrollInitial && this.diffAutoScroll)
    if (this.diffScrollWatcher) {
      this.diffScrollWatcher.dispose()
      this.diffScrollWatcher = null
    }
    if (this.diffAutoScroll) {
      const me = this.diffEditorView.getModifiedEditor()
      this.diffScrollWatcher = createScrollWatcherForEditor(me, {
        onPause: () => { this.shouldAutoScrollDiff = false },
        onMaybeResume: () => {
          this.rafScheduler.schedule('maybe-resume-diff', () => {
            this.shouldAutoScrollDiff = this.userIsNearBottomDiff()
          })
        },
        getLast: () => this.lastScrollTopDiff,
        setLast: (v: number) => { this.lastScrollTopDiff = v },
      })
    }
    log('diff', 'createDiffEditor', { autoScrollInitial: this.autoScrollInitial, diffAutoScroll: this.diffAutoScroll })

    // Compute and apply the editor's height (with internal hysteresis to
    // avoid tiny changes). Provide a small minimum visible height so the
    // editor doesn't collapse to a single line while content is streaming.
    const MIN_VISIBLE_HEIGHT = Math.min(120, this.maxHeightValue)
    container.style.minHeight = `${MIN_VISIBLE_HEIGHT}px`

    if (this.diffHeightManager) {
      this.diffHeightManager.dispose()
      this.diffHeightManager = null
    }
    this.diffHeightManager = createHeightManager(container, () => this.computedHeight())
    this.diffHeightManager.update()

    // If the initial computed height already reaches (or is very near) the
    // configured max height, apply it immediately so the UI shows the
    // scrolled state without waiting for the debounced height manager.
    const initialComputed = this.computedHeight()
    if (initialComputed >= this.maxHeightValue - 1) {
      container.style.height = `${this.maxHeightValue}px`
      container.style.overflow = 'auto'
    }

    const me = this.diffEditorView.getModifiedEditor()
    this.cachedScrollHeightDiff = me.getScrollHeight?.() ?? null
    this.cachedLineHeightDiff = me.getOption?.(monaco.editor.EditorOption.lineHeight) ?? null
    this.cachedComputedHeightDiff = this.computedHeight()

    const oEditor = this.diffEditorView.getOriginalEditor()
    const mEditor = this.diffEditorView.getModifiedEditor()
    oEditor.onDidContentSizeChange?.(() => {
      this._hasScrollBar = false
      this.rafScheduler.schedule('content-size-change-diff', () => {
        this.cachedScrollHeightDiff = oEditor.getScrollHeight?.() ?? this.cachedScrollHeightDiff
        this.cachedLineHeightDiff = oEditor.getOption?.(monaco.editor.EditorOption.lineHeight) ?? this.cachedLineHeightDiff
        this.cachedComputedHeightDiff = this.computedHeight()
        if (this.diffHeightManager?.isSuppressed())
          return
        this.diffHeightManager?.update()
        // Toggle overflow based on whether we've effectively reached max height.
        const computed = this.computedHeight()
        if (this.lastContainer) {
          const prevOverflow = this.lastContainer.style.overflow
          const newOverflow = computed >= this.maxHeightValue - 1 ? 'auto' : 'hidden'
          if (prevOverflow !== newOverflow) {
            this.lastContainer.style.overflow = newOverflow
            if (newOverflow === 'auto' && this.shouldAutoScrollDiff) {
              this.maybeScrollDiffToBottom(this.modifiedModel?.getLineCount())
            }
          }
        }
      })
    })
    mEditor.onDidContentSizeChange?.(() => {
      this._hasScrollBar = false
      this.rafScheduler.schedule('content-size-change-diff', () => {
        this.cachedScrollHeightDiff = mEditor.getScrollHeight?.() ?? this.cachedScrollHeightDiff
        this.cachedLineHeightDiff = mEditor.getOption?.(monaco.editor.EditorOption.lineHeight) ?? this.cachedLineHeightDiff
        this.cachedComputedHeightDiff = this.computedHeight()
        if (this.diffHeightManager?.isSuppressed())
          return
        this.diffHeightManager?.update()
        // Toggle overflow based on whether we've effectively reached max height.
        const computed = this.computedHeight()
        if (this.lastContainer) {
          const prevOverflow = this.lastContainer.style.overflow
          const newOverflow = computed >= this.maxHeightValue - 1 ? 'auto' : 'hidden'
          if (prevOverflow !== newOverflow) {
            this.lastContainer.style.overflow = newOverflow
            if (newOverflow === 'auto' && this.shouldAutoScrollDiff) {
              this.maybeScrollDiffToBottom(this.modifiedModel?.getLineCount())
            }
          }
        }
      })
    })

    // defer getValue reads for modified model to once-per-frame
    mEditor.onDidChangeModelContent(() => {
      this.lastKnownModifiedDirty = true
      this.rafScheduler.schedule('sync-last-known-modified', () => this.syncLastKnownModified())
    })

    this.maybeScrollDiffToBottom(this.modifiedModel.getLineCount(), this.lastKnownModifiedLineCount ?? undefined)
    this.setupDiffUnchangedRegionEnhancements()
    this.setupDiffHunkInteractions()

    return this.diffEditorView
  }

  updateDiff(originalCode: string, modifiedCode: string, codeLanguage?: string) {
    if (!this.diffEditorView || !this.originalModel || !this.modifiedModel)
      return

    const plang = codeLanguage ? processedLanguage(codeLanguage) : undefined
    if (plang && (this.originalModel.getLanguageId() !== plang || this.modifiedModel.getLanguageId() !== plang)) {
      this.pendingDiffUpdate = { original: originalCode, modified: modifiedCode, lang: codeLanguage }
      this.rafScheduler.schedule('diff', () => this.flushPendingDiffUpdate())
      return
    }

    if (this.lastKnownOriginalCode == null)
      this.lastKnownOriginalCode = this.originalModel.getValue()
    if (this.lastKnownModifiedCode == null)
      this.lastKnownModifiedCode = this.modifiedModel.getValue()

    const prevO = this.lastKnownOriginalCode!
    const prevM = this.lastKnownModifiedCode!
    let didImmediate = false

    if (originalCode !== prevO && originalCode.startsWith(prevO)) {
      // Buffer streaming appends so diff computation can keep up and update
      // highlights progressively.
      this.appendOriginal(originalCode.slice(prevO.length))
      this.lastKnownOriginalCode = originalCode
      didImmediate = true
    }

    if (modifiedCode !== prevM && modifiedCode.startsWith(prevM)) {
      // Buffer micro-appends so per-character streaming doesn't spam applyEdits
      // (which can starve rendering and diff computation).
      this.appendModified(modifiedCode.slice(prevM.length))
      this.lastKnownModifiedCode = modifiedCode
      didImmediate = true
    }

    if (originalCode !== this.lastKnownOriginalCode || modifiedCode !== this.lastKnownModifiedCode) {
      this.pendingDiffUpdate = { original: originalCode, modified: modifiedCode }
      this.rafScheduler.schedule('diff', () => this.flushPendingDiffUpdate())
    }
    else if (didImmediate) {
      // already applied
    }
  }

  updateOriginal(newCode: string, codeLanguage?: string) {
    if (!this.diffEditorView || !this.originalModel)
      return
    if (codeLanguage) {
      const lang = processedLanguage(codeLanguage)
      if (lang && this.originalModel.getLanguageId() !== lang)
        monaco.editor.setModelLanguage(this.originalModel, lang)
    }
    const prev = this.lastKnownOriginalCode ?? this.originalModel.getValue()
    if (prev === newCode)
      return
    if (newCode.startsWith(prev) && prev.length < newCode.length) {
      this.appendOriginal(newCode.slice(prev.length), codeLanguage)
    }
    else {
      this.flushOriginalAppendBufferSync()
      this.applyMinimalEditToModel(this.originalModel, prev, newCode)
    }
    this.lastKnownOriginalCode = newCode
  }

  updateModified(newCode: string, codeLanguage?: string) {
    if (!this.diffEditorView || !this.modifiedModel)
      return
    if (codeLanguage) {
      const lang = processedLanguage(codeLanguage)
      if (lang && this.modifiedModel.getLanguageId() !== lang)
        monaco.editor.setModelLanguage(this.modifiedModel, lang)
    }
    const prev = this.lastKnownModifiedCode ?? this.modifiedModel.getValue()
    if (prev === newCode)
      return
    if (newCode.startsWith(prev) && prev.length < newCode.length) {
      // Prefer the buffered append path for streaming.
      this.appendModified(newCode.slice(prev.length), codeLanguage)
    }
    else {
      // If we have buffered appends, apply them first so the model matches the
      // optimistic lastKnownModifiedCode before computing a minimal edit.
      this.flushModifiedAppendBufferSync()
      const prevAfterFlush = this.modifiedModel.getValue()
      const prevLine = this.modifiedModel.getLineCount()
      this.applyMinimalEditToModel(this.modifiedModel, prevAfterFlush, newCode)
      const newLine = this.modifiedModel.getLineCount()
      if (newLine !== prevLine) {
        const shouldImmediate = this.shouldPerformImmediateRevealDiff()
        if (shouldImmediate)
          this.suppressScrollWatcherDiff(this.scrollWatcherSuppressionMs + 800)
        const computed = this.computedHeight()
        if (computed >= this.maxHeightValue - 1 && this.lastContainer) {
          this.lastContainer.style.height = `${this.maxHeightValue}px`
          this.lastContainer.style.overflow = 'auto'
        }
        if (shouldImmediate) {
          this.scheduleImmediateRevealAfterLayoutDiff(newLine)
        }
        else {
          this.maybeScrollDiffToBottom(newLine, prevLine)
        }
        // If auto-scroll is enabled, also perform an unconditional immediate
        // reveal of the current tail line so the diff view follows content
        // progressively even when container overflow/scrollbar state hasn't
        // flipped yet.
        if (this.autoScrollOnUpdate && this.shouldAutoScrollDiff) {
          try {
            const ScrollType: any = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
            const immediate = (ScrollType && typeof ScrollType.Immediate !== 'undefined') ? ScrollType.Immediate : undefined
            const me2 = this.diffEditorView!.getModifiedEditor()
            const targetLine = me2.getModel()?.getLineCount() ?? newLine
            if (typeof immediate !== 'undefined')
              me2.revealLine(targetLine, immediate)
            else
              me2.revealLine(targetLine)
            this.lastRevealLineDiff = targetLine
            this.shouldAutoScrollDiff = true
            this.lastScrollTopDiff = me2.getScrollTop?.() ?? this.lastScrollTopDiff
          }
          catch { }
        }
      }
    }
    this.lastKnownModifiedCode = newCode
  }

  appendOriginal(appendText: string, codeLanguage?: string) {
    if (!this.diffEditorView || !this.originalModel || !appendText)
      return
    if (codeLanguage) {
      const lang = processedLanguage(codeLanguage)
      if (lang && this.originalModel.getLanguageId() !== lang)
        monaco.editor.setModelLanguage(this.originalModel, lang)
    }
    // Buffer-only; actual edit is applied in flushAppendBufferDiff
    this.appendBufferOriginalDiff.push(appendText)
    this.scheduleFlushAppendBufferDiff()
  }

  appendModified(appendText: string, codeLanguage?: string) {
    if (!this.diffEditorView || !this.modifiedModel || !appendText)
      return
    if (codeLanguage) {
      const lang = processedLanguage(codeLanguage)
      if (lang && this.modifiedModel.getLanguageId() !== lang)
        monaco.editor.setModelLanguage(this.modifiedModel, lang)
    }
    // Buffer-only; actual edit is applied in flushAppendBufferDiff
    this.appendBufferModifiedDiff.push(appendText)
    this.scheduleFlushAppendBufferDiff()
  }

  setLanguage(language: MonacoLanguage, languages: MonacoLanguage[]) {
    if (!languages.includes(language)) {
      console.warn(`Language "${language}" is not registered. Available languages: ${languages.join(', ')}`)
      return
    }
    if (this.originalModel && this.originalModel.getLanguageId() !== language)
      monaco.editor.setModelLanguage(this.originalModel, language)
    if (this.modifiedModel && this.modifiedModel.getLanguageId() !== language)
      monaco.editor.setModelLanguage(this.modifiedModel, language)
  }

  getDiffEditorView() {
    return this.diffEditorView
  }

  getDiffModels() {
    return { original: this.originalModel, modified: this.modifiedModel }
  }

  cleanup() {
    this.rafScheduler.cancel('diff')
    this.pendingDiffUpdate = null
    this.rafScheduler.cancel('appendDiff')
    this.appendBufferDiffScheduled = false
    this.appendBufferOriginalDiff.length = 0
    this.appendBufferModifiedDiff.length = 0
    if (this.appendFlushThrottleTimerDiff != null) {
      clearTimeout(this.appendFlushThrottleTimerDiff)
      this.appendFlushThrottleTimerDiff = null
    }
    this.rafScheduler.cancel('content-size-change-diff')
    this.rafScheduler.cancel('sync-last-known-modified')
    this.disposeDiffHunkInteractions()
    this.disposeDiffUnchangedRegionEnhancements()

    if (this.diffScrollWatcher) {
      this.diffScrollWatcher.dispose()
      this.diffScrollWatcher = null
    }

    if (this.diffHeightManager) {
      this.diffHeightManager.dispose()
      this.diffHeightManager = null
    }

    if (this.diffEditorView) {
      this.diffEditorView.dispose()
      this.diffEditorView = null
    }
    if (this.originalModel) {
      this.originalModel.dispose()
      this.originalModel = null
    }
    if (this.modifiedModel) {
      this.modifiedModel.dispose()
      this.modifiedModel = null
    }

    this.lastKnownOriginalCode = null
    this.lastKnownModifiedCode = null
    if (this.lastContainer) {
      this.lastContainer.classList.remove('stream-monaco-diff-root')
      this.lastContainer.innerHTML = ''
      this.lastContainer = null
    }
    // clear any pending reveal debounce and reset last reveal cache
    if (this.revealDebounceIdDiff != null) {
      clearTimeout(this.revealDebounceIdDiff)
      this.revealDebounceIdDiff = null
    }
    if (this.revealIdleTimerIdDiff != null) {
      clearTimeout(this.revealIdleTimerIdDiff)
      this.revealIdleTimerIdDiff = null
    }
    if (this.diffScrollWatcherSuppressionTimer != null) {
      clearTimeout(this.diffScrollWatcherSuppressionTimer)
      this.diffScrollWatcherSuppressionTimer = null
    }
    this.revealTicketDiff = 0
    this.lastRevealLineDiff = null
    this.diffPersistedUnchangedModelState = null
  }

  safeClean() {
    this.rafScheduler.cancel('diff')
    this.pendingDiffUpdate = null
    this.rafScheduler.cancel('appendDiff')
    this.appendBufferDiffScheduled = false
    this.appendBufferOriginalDiff.length = 0
    this.appendBufferModifiedDiff.length = 0
    if (this.appendFlushThrottleTimerDiff != null) {
      clearTimeout(this.appendFlushThrottleTimerDiff)
      this.appendFlushThrottleTimerDiff = null
    }
    this.hideDiffHunkActions()
    this.cancelScheduledHideDiffHunkActions()
    this.disposeDiffUnchangedRegionEnhancements()

    if (this.diffScrollWatcher) {
      this.diffScrollWatcher.dispose()
      this.diffScrollWatcher = null
    }

    this._hasScrollBar = false
    this.shouldAutoScrollDiff = !!(this.autoScrollInitial && this.diffAutoScroll)
    this.lastScrollTopDiff = 0

    if (this.diffHeightManager) {
      this.diffHeightManager.dispose()
      this.diffHeightManager = null
    }
    if (this.revealDebounceIdDiff != null) {
      clearTimeout(this.revealDebounceIdDiff)
      this.revealDebounceIdDiff = null
    }
    if (this.revealIdleTimerIdDiff != null) {
      clearTimeout(this.revealIdleTimerIdDiff)
      this.revealIdleTimerIdDiff = null
    }
    if (this.diffScrollWatcherSuppressionTimer != null) {
      clearTimeout(this.diffScrollWatcherSuppressionTimer)
      this.diffScrollWatcherSuppressionTimer = null
    }
    this.revealTicketDiff = 0
    this.lastRevealLineDiff = null
    this.diffPersistedUnchangedModelState = null
    this.rafScheduler.cancel('content-size-change-diff')
    this.rafScheduler.cancel('sync-last-known-modified')
  }

  private syncLastKnownModified() {
    if (!this.diffEditorView || !this.lastKnownModifiedDirty)
      return
    try {
      const me = this.diffEditorView.getModifiedEditor()
      const model = me.getModel()
      if (model) {
        this.lastKnownModifiedCode = model.getValue()
        this.lastKnownModifiedLineCount = model.getLineCount()
      }
    }
    finally {
      this.lastKnownModifiedDirty = false
    }
  }

  private flushPendingDiffUpdate() {
    if (!this.pendingDiffUpdate || !this.diffEditorView)
      return
    const o = this.originalModel
    const m = this.modifiedModel
    if (!o || !m) {
      this.pendingDiffUpdate = null
      return
    }

    const { original, modified, lang } = this.pendingDiffUpdate
    this.pendingDiffUpdate = null

    // Ensure models match any buffered streaming appends before applying minimal
    // edits or non-prefix updates, otherwise ranges can be computed against an
    // optimistic state and applied to a shorter model.
    this.flushOriginalAppendBufferSync()
    this.flushModifiedAppendBufferSync()

    if (lang) {
      const plang = processedLanguage(lang)
      if (plang) {
        if (o.getLanguageId() !== plang) {
          monaco.editor.setModelLanguage(o, plang)
          monaco.editor.setModelLanguage(m, plang)
        }
      }
    }

    if (this.lastKnownOriginalCode == null)
      this.lastKnownOriginalCode = o.getValue()
    if (this.lastKnownModifiedCode == null)
      this.lastKnownModifiedCode = m.getValue()

    const prevO = this.lastKnownOriginalCode!
    if (prevO !== original) {
      if (original.startsWith(prevO) && prevO.length < original.length) {
        this.appendToModel(o, original.slice(prevO.length))
      }
      else {
        this.applyMinimalEditToModel(o, prevO, original)
      }
      this.lastKnownOriginalCode = original
    }

    const prevM = m.getValue()
    const prevMLineCount = m.getLineCount()
    if (prevM !== modified) {
      if (modified.startsWith(prevM) && prevM.length < modified.length) {
        this.appendToModel(m, modified.slice(prevM.length))
      }
      else {
        this.applyMinimalEditToModel(m, prevM, modified)
      }
      this.lastKnownModifiedCode = modified
      const newMLineCount = m.getLineCount()
      if (newMLineCount !== prevMLineCount) {
        const shouldImmediate = this.shouldPerformImmediateRevealDiff()
        if (shouldImmediate)
          this.suppressScrollWatcherDiff(this.scrollWatcherSuppressionMs + 800)
        const computed = this.computedHeight()
        if (computed >= this.maxHeightValue - 1 && this.lastContainer) {
          this.lastContainer.style.height = `${this.maxHeightValue}px`
          this.lastContainer.style.overflow = 'auto'
        }
        if (shouldImmediate) {
          this.scheduleImmediateRevealAfterLayoutDiff(newMLineCount)
        }
        else {
          this.maybeScrollDiffToBottom(newMLineCount, prevMLineCount)
        }
      }
    }
  }

  private flushModifiedAppendBufferSync() {
    if (!this.modifiedModel)
      return
    if (this.appendBufferModifiedDiff.length === 0)
      return
    // Prevent a scheduled async flush from applying the same content later.
    this.rafScheduler.cancel('appendDiff')
    this.appendBufferDiffScheduled = false
    const text = this.appendBufferModifiedDiff.join('')
    this.appendBufferModifiedDiff.length = 0
    if (!text)
      return
    this.appendToModel(this.modifiedModel, text)
  }

  private async flushAppendBufferDiff() {
    if (!this.diffEditorView)
      return
    if (this.appendBufferOriginalDiff.length === 0 && this.appendBufferModifiedDiff.length === 0)
      return
    this.lastAppendFlushTimeDiff = Date.now()
    this.appendBufferDiffScheduled = false

    // Apply original-side buffered appends first (no scroll logic needed).
    if (this.originalModel && this.appendBufferOriginalDiff.length > 0) {
      const oText = this.appendBufferOriginalDiff.join('')
      this.appendBufferOriginalDiff.length = 0
      if (oText)
        this.appendToModel(this.originalModel, oText)
    }

    const me = this.diffEditorView.getModifiedEditor()
    const model = me.getModel()
    if (!model) {
      this.appendBufferModifiedDiff.length = 0
      return
    }
    let parts = this.appendBufferModifiedDiff.splice(0)
    // If the buffered append is large, apply it in smaller sequential chunks
    // with a RAF pause between each so the editor can render and auto-scroll
    // progressively instead of jumping once all data is applied.
    const prevLineInit = model.getLineCount()
    const totalText = parts.join('')
    const totalChars = totalText.length
    // If we received a single very large chunk, split it by lines into smaller
    // chunks so the editor can render and scroll progressively.
    if (parts.length === 1 && totalChars > 5000) {
      const lines = totalText.split(/\r?\n/)
      const chunkSize = 200
      const chunks: string[] = []
      for (let i = 0; i < lines.length; i += chunkSize) {
        chunks.push(`${lines.slice(i, i + chunkSize).join('\n')}\n`)
      }
      if (chunks.length > 1) {
        parts = chunks
      }
    }
    const applyChunked = parts.length > 1 && (totalChars > 2000 || (model.getLineCount && (model.getLineCount() + 0) - prevLineInit > 50))
    log('diff', 'flushAppendBufferDiff start', { partsCount: parts.length, totalChars, applyChunked })
    let prevLine = prevLineInit

    // If we have a scroll watcher, explicitly suppress it for the duration
    // of this flush so its onPause/onMaybeResume logic doesn't flip
    // auto-scroll while we're programmatically applying edits.
    const watcherApi = this.diffScrollWatcher as any
    let suppressedByFlush = false
    if (watcherApi && typeof watcherApi.setSuppressed === 'function') {
      try {
        // clear any timer-based suppression we may have pending
        if (this.diffScrollWatcherSuppressionTimer != null) {
          clearTimeout(this.diffScrollWatcherSuppressionTimer)
          this.diffScrollWatcherSuppressionTimer = null
        }
        watcherApi.setSuppressed(true)
        suppressedByFlush = true
      }
      catch { }
    }

    if (applyChunked) {
      log('diff', 'flushAppendBufferDiff applying chunked', { partsLen: parts.length })
      let idx = 0
      for (const part of parts) {
        if (!part)
          continue
        idx += 1
        log('diff', 'flushAppendBufferDiff chunk', { idx, partLen: part.length, prevLine })
        const lastColumn = model.getLineMaxColumn(prevLine)
        const range = new monaco.Range(prevLine, lastColumn, prevLine, lastColumn)
        model.applyEdits([{ range, text: part, forceMoveMarkers: true }])
        // update lastKnownModifiedCode lazily based on model value to avoid drift
        this.lastKnownModifiedCode = model.getValue()
        const newLine = model.getLineCount()
        this.lastKnownModifiedLineCount = newLine
        // try to let the editor update layout before scheduling reveal/scroll
        await new Promise(resolve => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(resolve) : setTimeout(resolve, 0)))
        const shouldImmediate = this.shouldPerformImmediateRevealDiff()
        log('diff', 'flushAppendBufferDiff chunk metrics', { idx, newLine, prevLine, shouldImmediate })
        if (shouldImmediate)
          this.suppressScrollWatcherDiff(this.scrollWatcherSuppressionMs + 800)
        const computed = this.computedHeight()
        if (computed >= this.maxHeightValue - 1 && this.lastContainer) {
          this.lastContainer.style.height = `${this.maxHeightValue}px`
          this.lastContainer.style.overflow = 'auto'
        }
        if (shouldImmediate) {
          this.scheduleImmediateRevealAfterLayoutDiff(newLine)
        }
        else {
          this.maybeScrollDiffToBottom(newLine, prevLine)
        }
        prevLine = newLine
        log('diff', 'flushAppendBufferDiff chunk applied', { idx, newLine })
      }
      // restore suppression state
      if (suppressedByFlush) {
        watcherApi.setSuppressed(false)
      }
      return
    }

    const text = totalText
    this.appendBufferModifiedDiff.length = 0
    prevLine = model.getLineCount()
    const lastColumn = model.getLineMaxColumn(prevLine)
    const range = new monaco.Range(prevLine, lastColumn, prevLine, lastColumn)
    model.applyEdits([{ range, text, forceMoveMarkers: true }])
    // update lastKnownModifiedCode lazily based on model value to avoid drift
    this.lastKnownModifiedCode = model.getValue()

    const newLine = model.getLineCount()
    // keep internal line count cache in sync
    this.lastKnownModifiedLineCount = newLine
    const shouldImmediate = this.shouldPerformImmediateRevealDiff()
    if (shouldImmediate)
      this.suppressScrollWatcherDiff(this.scrollWatcherSuppressionMs + 800)
    // When appends push the computed height to the max, apply the max
    // immediately so the editor doesn't show an intermediate scrollbar
    // before the debounced height manager settles.
    const computed = this.computedHeight()
    if (computed >= this.maxHeightValue - 1 && this.lastContainer)
      this.lastContainer.style.height = `${this.maxHeightValue}px`
    if (shouldImmediate) {
      this.scheduleImmediateRevealAfterLayoutDiff(newLine)
    }
    else {
      // schedule a short RAF task to allow the editor to update layout/scroll heights
      // before we check for vertical scrollbar and potentially auto-scroll.
      this.maybeScrollDiffToBottom(newLine, prevLine)
    }
    // If auto-scroll is enabled, also perform an unconditional immediate reveal
    // here so the diff follows large single-appends even when scrollbar/overflow
    // state hasn't been toggled yet.
    if (this.autoScrollOnUpdate && this.shouldAutoScrollDiff) {
      try {
        const ScrollType: any = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
        const immediate = (ScrollType && typeof ScrollType.Immediate !== 'undefined') ? ScrollType.Immediate : undefined
        const me2 = this.diffEditorView!.getModifiedEditor()
        const targetLine = me2.getModel()?.getLineCount() ?? newLine
        if (typeof immediate !== 'undefined')
          me2.revealLine(targetLine, immediate)
        else
          me2.revealLine(targetLine)
        this.lastRevealLineDiff = targetLine
        this.shouldAutoScrollDiff = true
        this.lastScrollTopDiff = me2.getScrollTop?.() ?? this.lastScrollTopDiff
      }
      catch { }
    }
    // restore suppression state and ensure auto-scroll remains enabled
    if (suppressedByFlush) {
      watcherApi.setSuppressed(false)
    }
    try {
      this.shouldAutoScrollDiff = true
      this.lastScrollTopDiff = this.diffEditorView?.getModifiedEditor().getScrollTop?.() ?? this.lastScrollTopDiff
    }
    catch { }
  }

  private applyMinimalEditToModel(model: monaco.editor.ITextModel, prev: string, next: string) {
    const maxChars = minimalEditMaxChars
    const ratio = minimalEditMaxChangeRatio
    const maxLen = Math.max(prev.length, next.length)
    const changeRatio = maxLen > 0 ? Math.abs(next.length - prev.length) / maxLen : 0
    if (prev.length + next.length > maxChars || changeRatio > ratio) {
      model.setValue(next)
      if (model === this.modifiedModel) {
        this.lastKnownModifiedLineCount = model.getLineCount()
      }
      return
    }

    const res = computeMinimalEdit(prev, next)
    if (!res)
      return
    const { start, endPrevIncl, replaceText } = res
    const rangeStart = model.getPositionAt(start)
    const rangeEnd = model.getPositionAt(endPrevIncl + 1)
    const range = new monaco.Range(
      rangeStart.lineNumber,
      rangeStart.column,
      rangeEnd.lineNumber,
      rangeEnd.column,
    )
    model.applyEdits([{ range, text: replaceText, forceMoveMarkers: true }])
    if (model === this.modifiedModel) {
      this.lastKnownModifiedLineCount = model.getLineCount()
    }
  }

  private appendToModel(model: monaco.editor.ITextModel, appendText: string) {
    if (!appendText)
      return
    const lastLine = model.getLineCount()
    const lastColumn = model.getLineMaxColumn(lastLine)
    const range = new monaco.Range(lastLine, lastColumn, lastLine, lastColumn)
    model.applyEdits([{ range, text: appendText, forceMoveMarkers: true }])
    if (model === this.modifiedModel) {
      this.lastKnownModifiedLineCount = model.getLineCount()
    }
  }
}
