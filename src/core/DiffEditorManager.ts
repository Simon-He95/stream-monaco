import type {
  DiffHunkActionContext,
  DiffHunkActionKind,
  DiffHunkSide,
  DiffModelPair,
  DiffModelTransitionOptions,
  MonacoLanguage,
  MonacoOptions,
  MonacoTheme,
} from '../type'
import { processedLanguage } from '../code.detect'
import {
  defaultRevealBatchOnIdleMs,
  defaultRevealDebounceMs,
  defaultScrollbar,
  minimalEditMaxChangeRatio,
  minimalEditMaxChars,
  padding,
} from '../constant'
import { computeMinimalEdit } from '../minimalEdit'
import * as monaco from '../monaco-shim'
import { createHeightManager } from '../utils/height'
import { log } from '../utils/logger'
import { createRafScheduler } from '../utils/raf'
import { createScrollWatcherForEditor } from '../utils/scroll'

type DiffEditorSide = 'original' | 'modified'

interface DiffUnchangedBridgeEntry {
  key: string | null
  bridge: HTMLDivElement
  rail: HTMLDivElement | null
  summary: HTMLButtonElement
  visualMeta: HTMLDivElement
  divider: HTMLSpanElement
  activate: () => void
  topButton: HTMLButtonElement | null
  bottomButton: HTMLButtonElement | null
}

export class DiffEditorManager {
  private static readonly diffUiStyleId = 'stream-monaco-diff-ui-style'
  private static readonly diffLineStyleClasses = [
    'stream-monaco-diff-style-background',
    'stream-monaco-diff-style-bar',
  ] as const

  private static readonly diffUnchangedRegionStyleClasses = [
    'stream-monaco-diff-unchanged-style-line-info',
    'stream-monaco-diff-unchanged-style-line-info-basic',
    'stream-monaco-diff-unchanged-style-metadata',
    'stream-monaco-diff-unchanged-style-simple',
  ] as const

  private static readonly diffLayoutModeClasses = [
    'stream-monaco-diff-inline',
    'stream-monaco-diff-side-by-side',
  ] as const

  private static readonly diffAppearanceClasses = [
    'stream-monaco-diff-appearance-light',
    'stream-monaco-diff-appearance-dark',
  ] as const

  private diffEditorView: monaco.editor.IStandaloneDiffEditor | null = null
  private originalModel: monaco.editor.ITextModel | null = null
  private modifiedModel: monaco.editor.ITextModel | null = null
  private originalModelOwned = false
  private modifiedModelOwned = false
  private lastContainer: HTMLElement | null = null

  private lastKnownOriginalCode: string | null = null
  private lastKnownModifiedCode: string | null = null
  private lastKnownModifiedLineCount: number | null = null
  private pendingDiffUpdate: {
    original: string
    modified: string
    lang?: string
  } | null = null

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
    const lineHeight
      = this.cachedLineHeightDiff
        ?? me.getOption(monaco.editor.EditorOption.lineHeight)
    const scrollTop = me.getScrollTop?.() ?? this.lastScrollTopDiff ?? 0
    const scrollHeight
      = me.getScrollHeight?.() ?? this.cachedScrollHeightDiff ?? li?.height ?? 0
    const computedHeight
      = this.cachedComputedHeightDiff ?? this.computedHeight()
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
  private diffHeightManager: ReturnType<typeof createHeightManager> | null
    = null

  private diffHunkDisposables: monaco.IDisposable[] = []
  private diffHunkOverlay: HTMLDivElement | null = null
  private diffHunkUpperNode: HTMLDivElement | null = null
  private diffHunkLowerNode: HTMLDivElement | null = null
  private diffHunkActiveChange: monaco.editor.ILineChange | null = null
  private diffHunkActiveHoverSide: DiffHunkSide | null = null
  private diffHunkLineChanges: monaco.editor.ILineChange[] = []
  private diffHunkFallbackLineChanges: monaco.editor.ILineChange[] = []
  private diffHunkFallbackVersions: {
    original: number
    modified: number
  } | null = null

  private diffHunkActionInFlight = false
  private diffComputedVersions: {
    original: number
    modified: number
  } | null = null

  private diffPresentationDisposables: monaco.IDisposable[] = []
  private fallbackOriginalDecorationIds: string[] = []
  private fallbackModifiedDecorationIds: string[] = []
  private diffHunkHideTimer: number | null = null
  private diffUnchangedRegionDisposables: monaco.IDisposable[] = []
  private diffUnchangedRegionObserver: MutationObserver | null = null
  private diffUnchangedBridgeOverlay: HTMLDivElement | null = null
  private diffUnchangedBridgeEntries = new Map<
    string,
    DiffUnchangedBridgeEntry
  >()

  private diffUnchangedBridgePool: DiffUnchangedBridgeEntry[] = []
  private diffUnchangedNodeIds = new WeakMap<HTMLElement, string>()
  private diffUnchangedNodeIdSequence = 0
  private diffUnchangedOverlayScrollTop = 0
  private diffUnchangedOverlayScrollLeft = 0
  private diffRootAppearanceSignature: string | null = null
  private diffPersistedUnchangedModelState:
    | monaco.editor.IDiffEditorViewState['modelState']
    | null = null

  private pendingPreparedDiffViewModel: monaco.editor.IDiffEditorViewModel | null
    = null

  private cancelRafs() {
    this.rafScheduler.cancel('sync-diff-presentation')
    this.rafScheduler.cancel('capture-diff-unchanged-state')
    this.rafScheduler.cancel('restore-diff-unchanged-state')
    this.rafScheduler.cancel('patch-diff-unchanged-regions')
    this.rafScheduler.cancel('maybe-scroll-diff')
    this.rafScheduler.cancel('revealDiff')
    this.rafScheduler.cancel('immediate-reveal-diff')
    this.rafScheduler.cancel('maybe-resume-diff')
    this.rafScheduler.cancel('content-size-change-diff')
    this.rafScheduler.cancel('sync-last-known-modified')
    this.rafScheduler.cancel('diff')
    this.rafScheduler.cancel('appendDiff')
  }

  private clearRevealTimers() {
    if (this.revealDebounceIdDiff != null) {
      clearTimeout(this.revealDebounceIdDiff)
      this.revealDebounceIdDiff = null
    }
    if (this.revealIdleTimerIdDiff != null) {
      clearTimeout(this.revealIdleTimerIdDiff)
      this.revealIdleTimerIdDiff = null
    }
  }

  private resetAppendState() {
    this.appendBufferDiffScheduled = false
    this.appendBufferOriginalDiff.length = 0
    this.appendBufferModifiedDiff.length = 0
    if (this.appendFlushThrottleTimerDiff != null) {
      clearTimeout(this.appendFlushThrottleTimerDiff)
      this.appendFlushThrottleTimerDiff = null
    }
  }

  private clearAsyncWork() {
    this.cancelRafs()
    this.pendingDiffUpdate = null
    this.lastKnownModifiedDirty = false
    this.resetAppendState()
    this.clearRevealTimers()
    if (this.diffScrollWatcherSuppressionTimer != null) {
      clearTimeout(this.diffScrollWatcherSuppressionTimer)
      this.diffScrollWatcherSuppressionTimer = null
    }
    this.cancelScheduledHideDiffHunkActions()
    this.clearPendingDiffThemeSync()
  }

  private diffModelTransitionRequestId = 0
  private pendingDiffScrollRestorePosition: ReturnType<
    DiffEditorManager['captureDiffScrollPosition']
  > | null = null

  private pendingDiffScrollRestoreBudget = 0
  private diffHideUnchangedRegionsResolved: NonNullable<
    monaco.editor.IDiffEditorConstructionOptions['hideUnchangedRegions']
  > | null = null

  private diffHideUnchangedRegionsDeferred = false
  private diffHideUnchangedRegionsIdleTimer: number | null = null
  private diffThemeSyncRafId: number | null = null

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
  ) {}

  private resolveDiffHideUnchangedRegionsOption(): NonNullable<
    monaco.editor.IDiffEditorConstructionOptions['hideUnchangedRegions']
  > {
    const normalize = (
      value: unknown,
    ): NonNullable<
      monaco.editor.IDiffEditorConstructionOptions['hideUnchangedRegions']
    > => {
      if (typeof value === 'boolean')
        return { enabled: value }
      if (value && typeof value === 'object') {
        const raw
          = value as monaco.editor.IDiffEditorConstructionOptions['hideUnchangedRegions']
        return {
          enabled: (raw as any).enabled ?? true,
          ...(raw as object),
        }
      }
      return { enabled: false }
    }

    const direct = (
      this.options as monaco.editor.IDiffEditorConstructionOptions
    ).hideUnchangedRegions
    if (typeof direct !== 'undefined')
      return normalize(direct)

    const viaOption = this.options.diffHideUnchangedRegions
    if (typeof viaOption !== 'undefined')
      return normalize(viaOption)

    return {
      enabled: true,
      contextLineCount: 3,
      minimumLineCount: 3,
      revealLineCount: 5,
    }
  }

  private resolveDiffLineStyleOption(): 'background' | 'bar' {
    return this.options.diffLineStyle === 'bar' ? 'bar' : 'background'
  }

  private resolveDiffUnchangedRegionStyleOption():
    | 'line-info'
    | 'line-info-basic'
    | 'metadata'
    | 'simple' {
    if (this.options.diffUnchangedRegionStyle === 'simple')
      return 'simple'
    if (this.options.diffUnchangedRegionStyle === 'line-info-basic')
      return 'line-info-basic'
    return this.options.diffUnchangedRegionStyle === 'metadata'
      ? 'metadata'
      : 'line-info'
  }

  private resolveDiffStreamingThrottleMs() {
    const explicitThrottle
      = this.diffUpdateThrottleMsOption
        ?? (this.options as any).diffUpdateThrottleMs
    if (typeof explicitThrottle === 'number')
      return explicitThrottle

    return 50
  }

  private parseCssColorRgb(color: string): [number, number, number] | null {
    const normalized = color.trim().toLowerCase()
    const rgbMatch = normalized.match(
      /^rgba?\(\s*([+\-.\d]+)\s*,\s*([+\-.\d]+)\s*,\s*([+\-.\d]+)/,
    )
    if (rgbMatch) {
      return [
        Number.parseFloat(rgbMatch[1]),
        Number.parseFloat(rgbMatch[2]),
        Number.parseFloat(rgbMatch[3]),
      ]
    }

    const hexMatch = normalized.match(/^#([\da-f]{3,8})$/i)
    if (!hexMatch)
      return null

    const hex = hexMatch[1]
    if (hex.length === 3 || hex.length === 4) {
      return [
        Number.parseInt(`${hex[0]}${hex[0]}`, 16),
        Number.parseInt(`${hex[1]}${hex[1]}`, 16),
        Number.parseInt(`${hex[2]}${hex[2]}`, 16),
      ]
    }
    if (hex.length === 6 || hex.length === 8) {
      return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ]
    }
    return null
  }

  private resolveCssColorLuminance(color: string): number | null {
    const rgb = this.parseCssColorRgb(color)
    if (!rgb)
      return null

    const channel = (value: number) => {
      const normalized = Math.max(0, Math.min(255, value)) / 255
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
    }

    const [r, g, b] = rgb
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  private resolveDiffUnchangedLineInfoRailMetrics(node: HTMLElement) {
    const editorRoot = node.closest<HTMLElement>('.monaco-editor')
    if (!editorRoot) {
      return {
        leftInset: 0,
        width: null as number | null,
      }
    }

    const editorRect = editorRoot.getBoundingClientRect()
    const lineNumberNode = Array.from(
      editorRoot.querySelectorAll<HTMLElement>('.line-numbers'),
    ).find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    if (!lineNumberNode) {
      return {
        leftInset: 0,
        width: null as number | null,
      }
    }

    const lineNumberRect = lineNumberNode.getBoundingClientRect()
    return {
      leftInset: Math.max(0, lineNumberRect.left - editorRect.left),
      width: Math.max(0, lineNumberRect.width) || null,
    }
  }

  private looksLikeDarkThemeName(themeName: string | null | undefined) {
    if (!themeName)
      return false
    const normalized = themeName.toLowerCase()
    return (
      [
        'dark',
        'night',
        'moon',
        'black',
        'dracula',
        'mocha',
        'frappe',
        'macchiato',
        'palenight',
        'ocean',
        'poimandres',
        'monokai',
        'laserwave',
        'tokyo',
        'slack-dark',
        'rose-pine',
        'github-dark',
        'material-theme',
        'one-dark',
        'catppuccin-mocha',
        'catppuccin-frappe',
        'catppuccin-macchiato',
      ].some(token => normalized.includes(token))
      && !normalized.includes('light')
      && !normalized.includes('latte')
      && !normalized.includes('dawn')
      && !normalized.includes('lotus')
    )
  }

  private looksLikeLightThemeName(themeName: string | null | undefined) {
    if (!themeName)
      return false
    const normalized = themeName.toLowerCase()
    return [
      'light',
      'day',
      'dawn',
      'latte',
      'solarized-light',
      'github-light',
      'rose-pine-dawn',
      'catppuccin-latte',
      'one-light',
      'vitesse-light',
      'snazzy-light',
      'material-lighter',
      'material-theme-lighter',
      'lotus',
    ].some(token => normalized.includes(token))
  }

  private resolveDiffAppearanceOption(): 'light' | 'dark' {
    if (this.options.diffAppearance === 'light')
      return 'light'
    if (this.options.diffAppearance === 'dark')
      return 'dark'

    if (this.looksLikeDarkThemeName(this.options.theme))
      return 'dark'
    if (this.looksLikeLightThemeName(this.options.theme))
      return 'light'

    const appearanceProbeNodes = [
      this.diffEditorView?.getModifiedEditor().getContainerDomNode?.(),
      this.diffEditorView?.getOriginalEditor().getContainerDomNode?.(),
      this.lastContainer,
    ]

    for (const node of appearanceProbeNodes) {
      if (!(node instanceof HTMLElement))
        continue
      const style = globalThis.getComputedStyle(node)
      const editorSurface = node.querySelector<HTMLElement>(
        '.monaco-editor .monaco-editor-background, .monaco-editor .margin, .monaco-editor .lines-content',
      )
      const candidates = [
        style.getPropertyValue('--stream-monaco-editor-bg'),
        style.getPropertyValue('--vscode-editor-background'),
        editorSurface
          ? globalThis.getComputedStyle(editorSurface).backgroundColor
          : '',
        style.backgroundColor,
      ]
      for (const color of candidates) {
        const luminance = this.resolveCssColorLuminance(color)
        if (luminance == null)
          continue
        return luminance <= 0.42 ? 'dark' : 'light'
      }
    }

    return this.looksLikeDarkThemeName(this.options.theme) ? 'dark' : 'light'
  }

  private syncDiffRootThemeVariables(appearance: 'light' | 'dark') {
    if (!(this.lastContainer instanceof HTMLElement))
      return

    const probeNodes = [
      this.diffEditorView?.getModifiedEditor().getContainerDomNode?.(),
      this.diffEditorView?.getOriginalEditor().getContainerDomNode?.(),
      this.lastContainer,
    ]

    const containerStyle = globalThis.getComputedStyle(this.lastContainer)
    const fixedBackgroundColor
      = containerStyle
        .getPropertyValue('--stream-monaco-fixed-editor-bg')
        .trim() || null

    let backgroundColor: string | null = null
    let foregroundColor: string | null = null

    for (const node of probeNodes) {
      if (!(node instanceof HTMLElement))
        continue
      const backgroundProbe
        = node.querySelector<HTMLElement>(
          '.monaco-editor-background, .margin, .lines-content',
        ) ?? node
      const foregroundProbe
        = node.querySelector<HTMLElement>(
          '.view-lines, .monaco-editor, .view-overlays',
        ) ?? node

      const nextBackground
        = globalThis.getComputedStyle(backgroundProbe).backgroundColor
      if (
        !backgroundColor
        && this.resolveCssColorLuminance(nextBackground) != null
      ) {
        backgroundColor = nextBackground
      }

      const nextForeground = globalThis.getComputedStyle(foregroundProbe).color
      if (
        !foregroundColor
        && this.resolveCssColorLuminance(nextForeground) != null
      ) {
        foregroundColor = nextForeground
      }

      if (backgroundColor && foregroundColor)
        break
    }

    const resolvedBackgroundColor
      = fixedBackgroundColor
        || backgroundColor
        || (appearance === 'dark' ? 'rgb(10 10 11)' : 'rgb(255 255 255)')

    if (resolvedBackgroundColor) {
      this.lastContainer.style.setProperty(
        '--stream-monaco-editor-bg',
        resolvedBackgroundColor,
      )
    }
    else {
      this.lastContainer.style.removeProperty('--stream-monaco-editor-bg')
    }

    if (foregroundColor) {
      this.lastContainer.style.setProperty(
        '--stream-monaco-editor-fg',
        foregroundColor,
      )
    }
    else {
      this.lastContainer.style.removeProperty('--stream-monaco-editor-fg')
    }
  }

  private applyDiffRootAppearanceClass() {
    if (!this.lastContainer)
      return
    const resolvedAppearance = this.resolveDiffAppearanceOption()
    this.syncDiffRootThemeVariables(resolvedAppearance)
    const containerClassList = this.lastContainer.classList
    const activeLineStyleClass = `stream-monaco-diff-style-${this.resolveDiffLineStyleOption()}`
    const activeUnchangedRegionStyleClass = `stream-monaco-diff-unchanged-style-${this.resolveDiffUnchangedRegionStyleOption()}`
    const sideBySide = !this.isDiffInlineMode()
    const activeLayoutModeClass = sideBySide
      ? 'stream-monaco-diff-side-by-side'
      : 'stream-monaco-diff-inline'
    const activeAppearanceClass = `stream-monaco-diff-appearance-${resolvedAppearance}`
    const nextSignature = [
      activeLineStyleClass,
      activeUnchangedRegionStyleClass,
      activeLayoutModeClass,
      activeAppearanceClass,
    ].join('|')

    if (
      this.diffRootAppearanceSignature === nextSignature
      && containerClassList.contains('stream-monaco-diff-root')
    ) {
      return
    }

    containerClassList.add('stream-monaco-diff-root')

    for (const className of DiffEditorManager.diffLineStyleClasses) {
      containerClassList.toggle(className, className === activeLineStyleClass)
    }
    for (const className of DiffEditorManager.diffUnchangedRegionStyleClasses) {
      containerClassList.toggle(
        className,
        className === activeUnchangedRegionStyleClass,
      )
    }
    for (const className of DiffEditorManager.diffLayoutModeClasses) {
      containerClassList.toggle(className, className === activeLayoutModeClass)
    }
    for (const className of DiffEditorManager.diffAppearanceClasses) {
      containerClassList.toggle(className, className === activeAppearanceClass)
    }
    this.diffRootAppearanceSignature = nextSignature
  }

  private disposeDiffHunkInteractions() {
    if (this.diffHunkHideTimer != null) {
      clearTimeout(this.diffHunkHideTimer)
      this.diffHunkHideTimer = null
    }
    this.diffHunkActiveChange = null
    this.diffHunkActiveHoverSide = null
    this.diffHunkLineChanges = []
    this.diffHunkFallbackLineChanges = []
    this.diffHunkFallbackVersions = null

    if (this.diffHunkDisposables.length > 0) {
      for (const d of this.diffHunkDisposables) {
        try {
          d.dispose()
        }
        catch {}
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
        : [
            {
              originalStartLineNumber: 1,
              originalEndLineNumber: n,
              modifiedStartLineNumber: 1,
              modifiedEndLineNumber: m,
              charChanges: [],
            },
          ]
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
          originalEndLineNumber: hasOriginal ? oEnd : oStart - 1,
          modifiedStartLineNumber: hasModified ? mStart : mStart,
          modifiedEndLineNumber: hasModified ? mEnd : mStart - 1,
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
    if (nativeLineChanges && this.hasFreshNativeDiffResult()) {
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

  private captureCurrentDiffVersions() {
    if (!this.originalModel || !this.modifiedModel)
      return null
    return {
      original: this.originalModel.getAlternativeVersionId(),
      modified: this.modifiedModel.getAlternativeVersionId(),
    }
  }

  private hasFreshNativeDiffResult() {
    const versions = this.captureCurrentDiffVersions()
    return !!(
      versions
      && this.diffComputedVersions
      && versions.original === this.diffComputedVersions.original
      && versions.modified === this.diffComputedVersions.modified
    )
  }

  private scheduleSyncDiffPresentationDecorations() {
    this.rafScheduler.schedule('sync-diff-presentation', () => {
      this.syncDiffPresentationDecorations()
    })
  }

  private clearFallbackDiffDecorations() {
    const originalEditor = this.diffEditorView?.getOriginalEditor()
    const modifiedEditor = this.diffEditorView?.getModifiedEditor()
    if (originalEditor && this.fallbackOriginalDecorationIds.length > 0) {
      this.fallbackOriginalDecorationIds = originalEditor.deltaDecorations(
        this.fallbackOriginalDecorationIds,
        [],
      )
    }
    else {
      this.fallbackOriginalDecorationIds = []
    }

    if (modifiedEditor && this.fallbackModifiedDecorationIds.length > 0) {
      this.fallbackModifiedDecorationIds = modifiedEditor.deltaDecorations(
        this.fallbackModifiedDecorationIds,
        [],
      )
    }
    else {
      this.fallbackModifiedDecorationIds = []
    }
  }

  private toWholeLineDecoration(
    side: 'original' | 'modified',
    startLineNumber: number,
    endLineNumber: number,
  ): monaco.editor.IModelDeltaDecoration | null {
    if (endLineNumber < startLineNumber || startLineNumber < 1)
      return null
    const removed = side === 'original'
    return {
      range: new monaco.Range(startLineNumber, 1, endLineNumber, 1),
      options: {
        isWholeLine: true,
        className: removed
          ? 'stream-monaco-fallback-line-delete'
          : 'stream-monaco-fallback-line-insert',
        marginClassName: removed
          ? 'stream-monaco-fallback-gutter-delete'
          : 'stream-monaco-fallback-gutter-insert',
        linesDecorationsClassName: removed
          ? 'stream-monaco-fallback-lines-delete'
          : 'stream-monaco-fallback-lines-insert',
        lineNumberClassName: removed
          ? 'stream-monaco-fallback-line-number-delete'
          : 'stream-monaco-fallback-line-number-insert',
        zIndex: 5,
      },
    }
  }

  private syncDiffPresentationDecorations() {
    if (!this.diffEditorView || !this.lastContainer)
      return

    const nativeFresh = this.hasFreshNativeDiffResult()
    this.lastContainer.classList.toggle(
      'stream-monaco-diff-native-stale',
      !nativeFresh,
    )

    if (nativeFresh) {
      this.clearFallbackDiffDecorations()
      return
    }

    const originalEditor = this.diffEditorView.getOriginalEditor()
    const modifiedEditor = this.diffEditorView.getModifiedEditor()
    const lineChanges = this.getEffectiveLineChanges()

    const originalDecorations = lineChanges
      .map(change =>
        this.toWholeLineDecoration(
          'original',
          change.originalStartLineNumber,
          change.originalEndLineNumber,
        ),
      )
      .filter(Boolean) as monaco.editor.IModelDeltaDecoration[]

    const modifiedDecorations = lineChanges
      .map(change =>
        this.toWholeLineDecoration(
          'modified',
          change.modifiedStartLineNumber,
          change.modifiedEndLineNumber,
        ),
      )
      .filter(Boolean) as monaco.editor.IModelDeltaDecoration[]

    this.fallbackOriginalDecorationIds = originalEditor.deltaDecorations(
      this.fallbackOriginalDecorationIds,
      originalDecorations,
    )
    this.fallbackModifiedDecorationIds = modifiedEditor.deltaDecorations(
      this.fallbackModifiedDecorationIds,
      modifiedDecorations,
    )
  }

  private disposeDiffPresentationTracking() {
    this.clearFallbackDiffDecorations()
    if (this.lastContainer) {
      this.lastContainer.classList.remove('stream-monaco-diff-native-stale')
    }
    this.diffComputedVersions = null
    this.diffPresentationDisposables.forEach(disposable => disposable.dispose())
    this.diffPresentationDisposables = []
    this.rafScheduler.cancel('sync-diff-presentation')
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
  --stream-monaco-editor-fg: var(--vscode-editor-foreground, #111827);
  --stream-monaco-editor-bg: var(--vscode-editor-background, #fff);
  --stream-monaco-unchanged-fg: var(--vscode-diffEditor-unchangedRegionForeground, var(--stream-monaco-editor-fg));
  --stream-monaco-unchanged-bg: var(--vscode-diffEditor-unchangedRegionBackground, transparent);
  --stream-monaco-gutter-marker-width: 4px;
  --stream-monaco-gutter-gap: 16px;
  --stream-monaco-widget-shadow: var(--vscode-widget-shadow, rgb(15 23 42 / 26%));
  --stream-monaco-focus: var(--vscode-focusBorder, color-mix(in srgb, var(--stream-monaco-editor-fg) 56%, transparent));
  --stream-monaco-frame-radius: 20px;
  --stream-monaco-frame-border: color-mix(in srgb, var(--stream-monaco-editor-fg) 12%, transparent);
  --stream-monaco-frame-shadow: 0 28px 60px -46px var(--stream-monaco-widget-shadow);
  --stream-monaco-panel-border: color-mix(in srgb, var(--stream-monaco-editor-fg) 9%, transparent);
  --stream-monaco-pane-divider: var(--stream-monaco-panel-border);
  --stream-monaco-line-number: color-mix(in srgb, var(--stream-monaco-editor-fg) 34%, transparent);
  --stream-monaco-line-number-active: color-mix(in srgb, var(--stream-monaco-editor-fg) 46%, transparent);
  --stream-monaco-line-number-left: calc(
    var(--stream-monaco-gutter-marker-width) + var(--stream-monaco-gutter-gap)
  );
  --stream-monaco-line-number-width: 36px;
  --stream-monaco-line-number-align: center;
  --stream-monaco-original-margin-width: calc(
    var(--stream-monaco-line-number-left) +
      var(--stream-monaco-line-number-width)
  );
  --stream-monaco-original-scrollable-left: var(
    --stream-monaco-original-margin-width
  );
  --stream-monaco-original-scrollable-width: calc(
    100% - var(--stream-monaco-original-margin-width)
  );
  --stream-monaco-modified-margin-width: calc(
    var(--stream-monaco-line-number-left) +
      var(--stream-monaco-line-number-width)
  );
  --stream-monaco-modified-scrollable-left: var(
    --stream-monaco-modified-margin-width
  );
  --stream-monaco-modified-scrollable-width: calc(
    100% - var(--stream-monaco-modified-margin-width)
  );
  --stream-monaco-panel-bg:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 97%, white 3%) 0%,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 92%, var(--stream-monaco-editor-fg) 8%) 100%
    );
  --stream-monaco-panel-bg-soft: color-mix(in srgb, var(--stream-monaco-editor-bg) 94%, var(--stream-monaco-editor-fg) 6%);
  --stream-monaco-panel-bg-strong: color-mix(in srgb, var(--stream-monaco-editor-bg) 88%, var(--stream-monaco-editor-fg) 12%);
  --stream-monaco-gutter-bg:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 92%, var(--stream-monaco-editor-fg) 8%) 0%,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 88%, var(--stream-monaco-editor-fg) 12%) 100%
    );
  --stream-monaco-gutter-guide: color-mix(in srgb, var(--stream-monaco-editor-fg) 14%, transparent);
  --stream-monaco-surface: color-mix(in srgb, var(--stream-monaco-unchanged-bg) 76%, var(--stream-monaco-editor-bg) 24%);
  --stream-monaco-surface-hover: color-mix(in srgb, var(--stream-monaco-unchanged-bg) 64%, var(--stream-monaco-editor-bg) 36%);
  --stream-monaco-surface-soft: color-mix(in srgb, var(--stream-monaco-unchanged-bg) 55%, transparent);
  --stream-monaco-border: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 18%, transparent);
  --stream-monaco-border-strong: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 30%, transparent);
  --stream-monaco-muted: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 70%, transparent);
  --stream-monaco-added-fg: color-mix(in srgb, var(--vscode-diffEditorGutter-insertedLineBackground, #14b8a6) 78%, #0f766e 22%);
  --stream-monaco-added-line: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground, #ddfbe8) 88%, var(--stream-monaco-editor-bg) 12%);
  --stream-monaco-added-inline: color-mix(in srgb, var(--vscode-diffEditor-insertedTextBackground, #baf5d1) 92%, var(--stream-monaco-editor-bg) 8%);
  --stream-monaco-added-border: color-mix(in srgb, var(--stream-monaco-added-fg) 24%, transparent);
  --stream-monaco-added-outline: var(--stream-monaco-added-border);
  --stream-monaco-added-inline-border: var(--stream-monaco-added-border);
  --stream-monaco-added-line-shadow:
    inset 4px 0 0 var(--stream-monaco-added-fg),
    inset 0 0 0 1px var(--stream-monaco-added-outline);
  --stream-monaco-added-line-fill:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--stream-monaco-added-line) 94%, var(--stream-monaco-editor-bg) 6%) 0%,
      color-mix(in srgb, var(--stream-monaco-added-line) 82%, transparent) 100%
    );
  --stream-monaco-added-gutter:
    linear-gradient(
      90deg,
      var(--stream-monaco-added-fg) 0 4px,
      color-mix(in srgb, var(--stream-monaco-added-line) 82%, transparent) 4px 100%
    );
  --stream-monaco-removed-fg: color-mix(in srgb, var(--vscode-diffEditorGutter-removedLineBackground, #f43f5e) 74%, #dc2626 26%);
  --stream-monaco-removed-line: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground, #fde8ec) 88%, var(--stream-monaco-editor-bg) 12%);
  --stream-monaco-removed-inline: color-mix(in srgb, var(--vscode-diffEditor-removedTextBackground, #fecdd6) 92%, var(--stream-monaco-editor-bg) 8%);
  --stream-monaco-removed-border: color-mix(in srgb, var(--stream-monaco-removed-fg) 24%, transparent);
  --stream-monaco-removed-outline: var(--stream-monaco-removed-border);
  --stream-monaco-removed-inline-border: var(--stream-monaco-removed-border);
  --stream-monaco-removed-line-shadow:
    inset 4px 0 0 var(--stream-monaco-removed-fg),
    inset 0 0 0 1px var(--stream-monaco-removed-outline);
  --stream-monaco-removed-line-fill:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--stream-monaco-removed-line) 94%, var(--stream-monaco-editor-bg) 6%) 0%,
      color-mix(in srgb, var(--stream-monaco-removed-line) 82%, transparent) 100%
    );
  --stream-monaco-removed-gutter:
    linear-gradient(
      90deg,
      var(--stream-monaco-removed-fg) 0 4px,
      color-mix(in srgb, var(--stream-monaco-removed-line) 82%, transparent) 4px 100%
    );
  scrollbar-width: none;
  color-scheme: light;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark {
  --stream-monaco-frame-border: color-mix(in srgb, var(--stream-monaco-editor-fg) 16%, transparent);
  --stream-monaco-frame-shadow: 0 30px 60px -42px rgb(2 6 23 / 0.78);
  --stream-monaco-panel-border: color-mix(in srgb, var(--stream-monaco-editor-fg) 15%, transparent);
  --stream-monaco-pane-divider: color-mix(in srgb, var(--stream-monaco-editor-fg) 12%, transparent);
  --stream-monaco-panel-bg:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 94%, black 6%) 0%,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 82%, var(--stream-monaco-editor-fg) 18%) 100%
    );
  --stream-monaco-panel-bg-soft: color-mix(in srgb, var(--stream-monaco-editor-bg) 86%, var(--stream-monaco-editor-fg) 14%);
  --stream-monaco-panel-bg-strong: color-mix(in srgb, var(--stream-monaco-editor-bg) 78%, var(--stream-monaco-editor-fg) 22%);
  --stream-monaco-gutter-bg:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 84%, black 16%) 0%,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 76%, var(--stream-monaco-editor-fg) 24%) 100%
    );
  --stream-monaco-gutter-guide: color-mix(in srgb, var(--stream-monaco-editor-fg) 12%, transparent);
  --stream-monaco-surface: color-mix(in srgb, var(--stream-monaco-editor-bg) 91%, var(--stream-monaco-unchanged-fg) 9%);
  --stream-monaco-surface-hover: color-mix(in srgb, var(--stream-monaco-editor-bg) 84%, var(--stream-monaco-unchanged-fg) 16%);
  --stream-monaco-surface-soft: color-mix(in srgb, var(--stream-monaco-editor-bg) 78%, var(--stream-monaco-unchanged-fg) 22%);
  --stream-monaco-border: color-mix(in srgb, var(--stream-monaco-editor-fg) 22%, transparent);
  --stream-monaco-border-strong: color-mix(in srgb, var(--stream-monaco-editor-fg) 30%, transparent);
  --stream-monaco-muted: color-mix(in srgb, var(--stream-monaco-editor-fg) 72%, transparent);
  --stream-monaco-added-fg: color-mix(in srgb, var(--vscode-diffEditorGutter-insertedLineBackground, #2dd4bf) 88%, #99f6e4 12%);
  --stream-monaco-added-line: color-mix(in srgb, var(--vscode-diffEditor-insertedLineBackground, rgb(16 185 129 / 0.24)) 54%, var(--stream-monaco-editor-bg) 46%);
  --stream-monaco-added-inline: color-mix(in srgb, var(--vscode-diffEditor-insertedTextBackground, rgb(45 212 191 / 0.26)) 62%, var(--stream-monaco-editor-bg) 38%);
  --stream-monaco-added-border: color-mix(in srgb, var(--stream-monaco-added-fg) 32%, transparent);
  --stream-monaco-added-outline: color-mix(in srgb, var(--stream-monaco-added-fg) 20%, transparent);
  --stream-monaco-added-inline-border: color-mix(in srgb, var(--stream-monaco-added-fg) 26%, transparent);
  --stream-monaco-added-line-shadow:
    inset 4px 0 0 var(--stream-monaco-added-fg),
    inset 0 0 0 1px var(--stream-monaco-added-outline);
  --stream-monaco-added-line-fill:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--stream-monaco-added-line) 96%, var(--stream-monaco-editor-bg) 4%) 0%,
      color-mix(in srgb, var(--stream-monaco-added-line) 74%, transparent) 100%
    );
  --stream-monaco-added-gutter:
    linear-gradient(
      90deg,
      var(--stream-monaco-added-fg) 0 4px,
      color-mix(in srgb, var(--stream-monaco-added-line) 74%, transparent) 4px 100%
    );
  --stream-monaco-removed-fg: color-mix(in srgb, var(--vscode-diffEditorGutter-removedLineBackground, #fb7185) 86%, #fecdd3 14%);
  --stream-monaco-removed-line: color-mix(in srgb, var(--vscode-diffEditor-removedLineBackground, rgb(244 63 94 / 0.22)) 54%, var(--stream-monaco-editor-bg) 46%);
  --stream-monaco-removed-inline: color-mix(in srgb, var(--vscode-diffEditor-removedTextBackground, rgb(251 113 133 / 0.24)) 62%, var(--stream-monaco-editor-bg) 38%);
  --stream-monaco-removed-border: color-mix(in srgb, var(--stream-monaco-removed-fg) 32%, transparent);
  --stream-monaco-removed-outline: color-mix(in srgb, var(--stream-monaco-removed-fg) 20%, transparent);
  --stream-monaco-removed-inline-border: color-mix(in srgb, var(--stream-monaco-removed-fg) 26%, transparent);
  --stream-monaco-removed-line-shadow:
    inset 4px 0 0 var(--stream-monaco-removed-fg),
    inset 0 0 0 1px var(--stream-monaco-removed-outline);
  --stream-monaco-removed-line-fill:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--stream-monaco-removed-line) 96%, var(--stream-monaco-editor-bg) 4%) 0%,
      color-mix(in srgb, var(--stream-monaco-removed-line) 74%, transparent) 100%
    );
  --stream-monaco-removed-gutter:
    linear-gradient(
      90deg,
      var(--stream-monaco-removed-fg) 0 4px,
      color-mix(in srgb, var(--stream-monaco-removed-line) 74%, transparent) 4px 100%
    );
  color-scheme: dark;
}
.stream-monaco-diff-root::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.stream-monaco-diff-root .monaco-diff-editor {
  overflow: hidden;
  background: var(--stream-monaco-panel-bg);
  box-shadow: var(--stream-monaco-frame-shadow);
}
.stream-monaco-diff-root .monaco-diff-editor.side-by-side .editor.original .scrollbar.vertical,
.stream-monaco-diff-root .monaco-diff-editor.side-by-side .editor.modified .scrollbar.vertical {
  display: none !important;
}
.stream-monaco-diff-root .monaco-diff-editor.side-by-side {
  background:
    radial-gradient(circle at top center, color-mix(in srgb, var(--stream-monaco-editor-bg) 82%, white 18%) 0%, transparent 44%),
    var(--stream-monaco-panel-bg);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-diff-editor.side-by-side {
  background:
    radial-gradient(circle at top center, color-mix(in srgb, var(--stream-monaco-editor-bg) 88%, black 12%) 0%, transparent 48%),
    var(--stream-monaco-panel-bg);
}
.stream-monaco-diff-root .monaco-diff-editor .editor.original,
.stream-monaco-diff-root .monaco-diff-editor .editor.modified {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 98%, white 2%) 0%,
      var(--stream-monaco-editor-bg) 100%
    );
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-diff-editor .editor.original,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-diff-editor .editor.modified {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 94%, black 6%) 0%,
      var(--stream-monaco-editor-bg) 100%
    );
}
.stream-monaco-diff-root .monaco-diff-editor .editor.original .monaco-editor-background,
.stream-monaco-diff-root .monaco-diff-editor .editor.original .margin,
.stream-monaco-diff-root .monaco-diff-editor .editor.original .margin-view-overlays,
.stream-monaco-diff-root .monaco-diff-editor .editor.original .margin-view-zones,
.stream-monaco-diff-root .monaco-diff-editor .editor.original .lines-content,
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .monaco-editor-background,
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .margin,
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .margin-view-overlays,
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .margin-view-zones,
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .lines-content {
  background: var(--stream-monaco-editor-bg) !important;
}
.stream-monaco-diff-root .monaco-diff-editor.side-by-side .editor.modified {
  box-shadow: none;
  border-left: 1px solid var(--stream-monaco-pane-divider);
}
.stream-monaco-diff-root .monaco-diff-editor.side-by-side .editor.original {
  box-shadow: none;
  border-right: 1px solid var(--stream-monaco-pane-divider);
}
.stream-monaco-diff-root .monaco-diff-editor .gutter {
  background: var(--stream-monaco-gutter-bg);
  border-inline: 1px solid var(--stream-monaco-pane-divider);
}
.stream-monaco-diff-root .monaco-diff-editor .gutter .background {
  left: 50%;
  width: 1px;
  border-left: 0 !important;
  background: var(--stream-monaco-gutter-guide);
}
.stream-monaco-diff-root .monaco-diff-editor .gutter .buttons .monaco-toolbar .monaco-action-bar .actions-container {
  border-radius: 999px;
  border: 1px solid var(--stream-monaco-panel-border);
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 84%, var(--stream-monaco-editor-fg) 16%);
  box-shadow: 0 14px 24px -18px var(--stream-monaco-widget-shadow);
}
.stream-monaco-diff-root .monaco-diff-editor .gutter .buttons .monaco-toolbar .monaco-action-bar .actions-container .action-item {
  border-radius: 999px;
}
.stream-monaco-diff-root .monaco-diff-editor .insert-sign,
.stream-monaco-diff-root .monaco-diff-editor .delete-sign {
  display: none !important;
}
.stream-monaco-diff-root .monaco-diff-editor .gutter-insert {
  background: var(--stream-monaco-added-gutter) !important;
}
.stream-monaco-diff-root .monaco-diff-editor .gutter-delete,
.stream-monaco-diff-root .monaco-editor .inline-deleted-margin-view-zone {
  background: var(--stream-monaco-removed-gutter) !important;
}
.stream-monaco-diff-root .monaco-editor .line-insert,
.stream-monaco-diff-root .monaco-diff-editor .line-insert {
  background: var(--stream-monaco-added-line-fill) !important;
  border: 0 !important;
  box-shadow: var(--stream-monaco-added-line-shadow);
}
.stream-monaco-diff-root .monaco-editor .line-delete,
.stream-monaco-diff-root .monaco-diff-editor .line-delete {
  background: var(--stream-monaco-removed-line-fill) !important;
  border: 0 !important;
  box-shadow: var(--stream-monaco-removed-line-shadow);
}
.stream-monaco-diff-root .monaco-editor .char-insert,
.stream-monaco-diff-root .monaco-diff-editor .char-insert {
  background: var(--stream-monaco-added-inline) !important;
  border: 1px solid var(--stream-monaco-added-inline-border) !important;
  border-radius: 6px;
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--stream-monaco-added-fg) 18%, transparent);
}
.stream-monaco-diff-root .monaco-editor .char-delete,
.stream-monaco-diff-root .monaco-diff-editor .char-delete,
.stream-monaco-diff-root .monaco-editor .inline-deleted-text {
  background: var(--stream-monaco-removed-inline) !important;
  border: 1px solid var(--stream-monaco-removed-inline-border) !important;
  border-radius: 6px;
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--stream-monaco-removed-fg) 18%, transparent);
}
.stream-monaco-diff-root .monaco-editor .inline-deleted-text {
  text-decoration: none;
}
.stream-monaco-diff-root .monaco-editor .char-insert.diff-range-empty,
.stream-monaco-diff-root .monaco-editor .char-delete.diff-range-empty {
  min-width: 2px;
  margin: 0 1px;
  border-radius: 999px;
}
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-editor .line-insert,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-diff-editor .line-insert,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-editor .line-delete,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-diff-editor .line-delete,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-editor .char-insert,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-diff-editor .char-insert,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-editor .char-delete,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-diff-editor .char-delete,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-editor .inline-deleted-text,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-diff-editor .gutter-insert,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-diff-editor .gutter-delete,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-editor .inline-deleted-margin-view-zone {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-editor .line-delete.line-numbers,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-diff-editor .line-delete.line-numbers,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-editor .line-insert.line-numbers,
.stream-monaco-diff-root.stream-monaco-diff-native-stale .monaco-diff-editor .line-insert.line-numbers {
  color: var(--stream-monaco-line-number) !important;
}
.stream-monaco-diff-root .monaco-editor .stream-monaco-fallback-line-insert,
.stream-monaco-diff-root .monaco-diff-editor .stream-monaco-fallback-line-insert {
  background: var(--stream-monaco-added-line-fill) !important;
  border: 0 !important;
  box-shadow: var(--stream-monaco-added-line-shadow);
}
.stream-monaco-diff-root .monaco-editor .stream-monaco-fallback-line-delete,
.stream-monaco-diff-root .monaco-diff-editor .stream-monaco-fallback-line-delete {
  background: var(--stream-monaco-removed-line-fill) !important;
  border: 0 !important;
  box-shadow: var(--stream-monaco-removed-line-shadow);
}
.stream-monaco-diff-root .monaco-editor .stream-monaco-fallback-gutter-insert,
.stream-monaco-diff-root .monaco-diff-editor .stream-monaco-fallback-gutter-insert {
  background: var(--stream-monaco-added-gutter) !important;
}
.stream-monaco-diff-root .monaco-editor .stream-monaco-fallback-gutter-delete,
.stream-monaco-diff-root .monaco-diff-editor .stream-monaco-fallback-gutter-delete {
  background: var(--stream-monaco-removed-gutter) !important;
}
.stream-monaco-diff-root .monaco-editor .stream-monaco-fallback-line-number-delete,
.stream-monaco-diff-root .monaco-diff-editor .stream-monaco-fallback-line-number-delete {
  color: var(--stream-monaco-removed-fg) !important;
}
.stream-monaco-diff-root .monaco-editor .stream-monaco-fallback-line-number-insert,
.stream-monaco-diff-root .monaco-diff-editor .stream-monaco-fallback-line-number-insert {
  color: var(--stream-monaco-added-fg) !important;
}
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-diff-editor .gutter-insert {
  background:
    linear-gradient(
      90deg,
      var(--stream-monaco-added-fg) 0 4px,
      transparent 4px 100%
    ) !important;
}
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-diff-editor .gutter-delete,
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-editor .inline-deleted-margin-view-zone {
  background:
    linear-gradient(
      90deg,
      var(--stream-monaco-removed-fg) 0 4px,
      transparent 4px 100%
    ) !important;
}
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-editor .line-insert,
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-diff-editor .line-insert {
  background:
    color-mix(in srgb, var(--stream-monaco-added-line) 34%, transparent) !important;
  box-shadow: none !important;
}
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-editor .line-delete,
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-diff-editor .line-delete {
  background:
    color-mix(in srgb, var(--stream-monaco-removed-line) 34%, transparent) !important;
  box-shadow: none !important;
}
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-editor .char-insert,
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-diff-editor .char-insert {
  background:
    color-mix(in srgb, var(--stream-monaco-added-inline) 76%, transparent) !important;
  border: 0 !important;
  border-bottom: 1px solid
    color-mix(in srgb, var(--stream-monaco-added-fg) 30%, transparent) !important;
  box-shadow: inset 0 -1px 0
    color-mix(in srgb, var(--stream-monaco-added-fg) 26%, transparent);
}
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-editor .char-delete,
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-diff-editor .char-delete,
.stream-monaco-diff-root.stream-monaco-diff-style-bar .monaco-editor .inline-deleted-text {
  background:
    color-mix(in srgb, var(--stream-monaco-removed-inline) 76%, transparent) !important;
  border: 0 !important;
  border-bottom: 1px solid
    color-mix(in srgb, var(--stream-monaco-removed-fg) 30%, transparent) !important;
  box-shadow: inset 0 -1px 0
    color-mix(in srgb, var(--stream-monaco-removed-fg) 26%, transparent);
}
.stream-monaco-diff-root .monaco-diff-editor .diffOverview {
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 84%, var(--stream-monaco-editor-fg) 16%);
  border-left: 1px solid var(--stream-monaco-panel-border);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-diff-editor .diffOverview {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 96%, black 4%) 0%,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 90%, var(--stream-monaco-editor-fg) 10%) 100%
    );
  border-left-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 10%, transparent);
  box-shadow: inset 1px 0 0 rgb(255 255 255 / 0.03);
}
.stream-monaco-diff-root .monaco-diff-editor .diffViewport {
  border-radius: 999px;
  background: color-mix(in srgb, var(--stream-monaco-editor-fg) 18%, transparent);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-diff-editor .diffViewport {
  background: color-mix(in srgb, var(--stream-monaco-editor-fg) 24%, transparent);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.08),
    0 10px 18px -14px rgb(2 6 23 / 0.92);
}
.stream-monaco-diff-root .monaco-diff-editor .diffViewport:hover {
  background: color-mix(in srgb, var(--stream-monaco-editor-fg) 24%, transparent);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-diff-editor .diffViewport:hover {
  background: color-mix(in srgb, var(--stream-monaco-editor-fg) 31%, transparent);
}
.stream-monaco-diff-root .monaco-diff-editor .diffViewport:active {
  background: color-mix(in srgb, var(--stream-monaco-editor-fg) 32%, transparent);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-diff-editor .diffViewport:active {
  background: color-mix(in srgb, var(--stream-monaco-editor-fg) 38%, transparent);
}
.stream-monaco-diff-root .monaco-scrollable-element.modified-in-monaco-diff-editor .slider {
  border-radius: 999px;
}
.stream-monaco-diff-root .monaco-editor .line-numbers {
  color: var(--stream-monaco-line-number) !important;
  left: var(--stream-monaco-line-number-left) !important;
  width: var(--stream-monaco-line-number-width) !important;
  text-align: var(--stream-monaco-line-number-align) !important;
}
.stream-monaco-diff-root .monaco-editor .line-numbers.active-line-number {
  color: var(--stream-monaco-line-number-active) !important;
}
.stream-monaco-diff-root .monaco-editor .line-delete.line-numbers,
.stream-monaco-diff-root .monaco-diff-editor .line-delete.line-numbers {
  color: var(--stream-monaco-removed-fg) !important;
}
.stream-monaco-diff-root .monaco-editor .line-insert.line-numbers,
.stream-monaco-diff-root .monaco-diff-editor .line-insert.line-numbers {
  color: var(--stream-monaco-added-fg) !important;
}
.stream-monaco-diff-root .monaco-diff-editor .editor.original .margin,
.stream-monaco-diff-root .monaco-diff-editor .editor.original .margin-view-overlays,
.stream-monaco-diff-root .monaco-diff-editor .editor.original .margin-view-zones {
  width: var(--stream-monaco-original-margin-width, auto) !important;
}
.stream-monaco-diff-root .monaco-diff-editor .editor.original .current-line {
  width: var(--stream-monaco-original-margin-width, auto) !important;
}
.stream-monaco-diff-root .monaco-diff-editor .editor.original .monaco-scrollable-element.editor-scrollable {
  left: var(--stream-monaco-original-scrollable-left, auto) !important;
  width: var(--stream-monaco-original-scrollable-width, auto) !important;
}
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .margin,
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .margin-view-overlays,
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .margin-view-zones {
  width: var(--stream-monaco-modified-margin-width) !important;
}
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .current-line {
  width: var(--stream-monaco-modified-margin-width) !important;
}
.stream-monaco-diff-root .monaco-diff-editor .editor.modified .monaco-scrollable-element.editor-scrollable {
  left: var(--stream-monaco-modified-scrollable-left, var(--stream-monaco-modified-margin-width)) !important;
  width: var(
    --stream-monaco-modified-scrollable-width,
    calc(100% - var(--stream-monaco-modified-margin-width))
  ) !important;
}
.stream-monaco-diff-root .monaco-editor .diagonal-fill {
  opacity: 0.38;
  background-size: 10px 10px;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines-widget {
  pointer-events: auto;
  box-sizing: border-box;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .diff-hidden-lines-widget,
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .fold-unchanged {
  display: none !important;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .diff-hidden-lines {
  display: none !important;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original {
  width: 0 !important;
  min-width: 0 !important;
  flex: 0 0 0 !important;
  border: 0 !important;
  overflow: hidden !important;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .monaco-scrollable-element.editor-scrollable {
  left: 0 !important;
  width: 0 !important;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.modified {
  left: 0 !important;
  width: 100% !important;
  border-left: 0 !important;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .gutter-delete,
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .gutter-insert,
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .line-delete,
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .line-insert,
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .line-numbers,
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-diff-editor .editor.original .diagonal-fill {
  opacity: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  pointer-events: none !important;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines {
  height: auto;
  width: 100%;
  transform: none;
  padding: 0 8px;
  box-sizing: border-box;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-editor .diff-hidden-lines-widget {
  height: 24px !important;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-editor .diff-hidden-lines {
  height: 24px;
  padding: 0 8px;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .top,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .bottom {
  display: none !important;
  pointer-events: none !important;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center {
  align-items: center;
  gap: 0;
  max-width: calc(100% - 4px);
  min-height: 32px;
  margin: 0 auto;
  padding: 0;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--stream-monaco-editor-fg) 8%, transparent);
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 96%,
    var(--stream-monaco-editor-fg) 4%
  );
  box-shadow: 0 18px 28px -28px var(--stream-monaco-widget-shadow);
  box-sizing: border-box;
  overflow: hidden;
  transition: background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .monaco-editor .diff-hidden-lines .center {
  min-height: 24px;
  height: 24px;
  border-radius: 10px;
}
.stream-monaco-diff-root.stream-monaco-diff-unchanged-style-simple .monaco-editor .diff-hidden-lines .center {
  min-height: 28px;
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
  padding-left: 0;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-editor .diff-hidden-lines .center,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge {
  border-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 16%, transparent);
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 88%,
    var(--stream-monaco-editor-fg) 12%
  );
  box-shadow: 0 22px 34px -30px rgb(2 6 23 / 0.92);
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center:hover,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-focus-within {
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 94%,
    var(--stream-monaco-editor-fg) 6%
  );
  border-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 12%, transparent);
  box-shadow: 0 18px 30px -28px var(--stream-monaco-widget-shadow);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-editor .diff-hidden-lines .center:hover,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-editor .diff-hidden-lines .center.stream-monaco-focus-within,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary:hover,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary:focus-visible,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary.stream-monaco-focus-visible {
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 82%,
    var(--stream-monaco-editor-fg) 18%
  );
  border-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 22%, transparent);
  box-shadow: 0 24px 36px -30px rgb(2 6 23 / 0.94);
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-merged-secondary .stream-monaco-unchanged-primary {
  display: none !important;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-primary,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-primary {
  display: none !important;
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
  background: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 10%, var(--stream-monaco-editor-bg) 90%);
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
  background: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 14%, var(--stream-monaco-editor-bg) 86%);
  border-color: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 18%, transparent);
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
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 54%, transparent);
  white-space: nowrap;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-meta,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-meta {
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 78%, transparent);
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center.stream-monaco-unchanged-merged-secondary .stream-monaco-unchanged-meta {
  justify-content: flex-start;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-count,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-count {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 58%, transparent);
  font-size: 13px;
  line-height: 14px;
  font-weight: 500;
  letter-spacing: 0;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-count,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-count {
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 92%, transparent);
  font-weight: 600;
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
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-meta {
  justify-content: flex-start;
  padding: 0 18px 0 16px;
}
.stream-monaco-diff-root.stream-monaco-diff-unchanged-style-metadata .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-meta {
  padding: 0 28px;
}
.stream-monaco-diff-root.stream-monaco-diff-unchanged-style-simple .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-meta {
  justify-content: center;
  padding: 0 10px;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-separator,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-breadcrumb,
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-expand {
  display: none !important;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 12;
}
.stream-monaco-diff-root.stream-monaco-diff-inline .stream-monaco-diff-unchanged-overlay {
  display: none !important;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-overlay [hidden] {
  display: none !important;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge {
  position: absolute;
  display: grid;
  grid-template-columns: var(--stream-monaco-unchanged-rail-width, 54px) minmax(0, 1fr);
  align-items: center;
  column-gap: 0;
  min-height: 32px;
  padding: 0;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--stream-monaco-editor-fg) 8%, transparent);
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 96%,
    var(--stream-monaco-editor-fg) 4%
  );
  box-shadow: 0 18px 28px -28px var(--stream-monaco-widget-shadow);
  box-sizing: border-box;
  overflow: hidden;
  pointer-events: auto;
  transition: background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.stream-monaco-diff-root.stream-monaco-diff-side-by-side .stream-monaco-diff-unchanged-bridge {
  min-height: 24px;
  border-radius: 10px;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge:not(.stream-monaco-diff-unchanged-bridge-metadata):not(.stream-monaco-diff-unchanged-bridge-simple) {
  border-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 18%, transparent);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 84%, var(--stream-monaco-editor-fg) 16%) 0%,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 88%, var(--stream-monaco-editor-fg) 12%) 100%
    );
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.03),
    0 22px 34px -30px rgb(2 6 23 / 0.92);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-metadata {
  grid-template-columns: minmax(0, 1fr);
  min-height: 32px;
  border-radius: 0;
  border-left: 0;
  border-right: 0;
  box-shadow: none;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-metadata {
  border-top: 1px solid color-mix(in srgb, var(--stream-monaco-editor-fg) 14%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--stream-monaco-editor-fg) 14%, transparent);
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 92%,
    var(--stream-monaco-editor-fg) 8%
  );
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.02),
    inset 0 -1px 0 rgb(15 23 42 / 0.22);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple {
  grid-template-columns: minmax(0, 1fr);
  min-height: 28px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple {
  background: transparent;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge:focus {
  outline: none;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-rail {
  display: grid;
  grid-auto-rows: minmax(0, 1fr);
  align-self: stretch;
  min-height: 100%;
  border-right: 1px solid color-mix(in srgb, var(--stream-monaco-editor-fg) 7%, transparent);
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 94%,
    var(--stream-monaco-editor-fg) 6%
  );
  z-index: 1;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-rail {
  border-right-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 12%, transparent);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 82%, var(--stream-monaco-editor-fg) 18%) 0%,
      color-mix(in srgb, var(--stream-monaco-editor-bg) 88%, var(--stream-monaco-editor-fg) 12%) 100%
    );
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.04),
    inset -1px 0 0 rgb(15 23 42 / 0.22);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-line-info .stream-monaco-unchanged-rail {
  justify-items: stretch;
  border-right: 1px solid color-mix(in srgb, var(--stream-monaco-editor-fg) 8%, transparent);
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 92%,
    var(--stream-monaco-editor-fg) 8%
  );
  border-radius: 10px 0 0 10px;
  overflow: hidden;
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--stream-monaco-editor-fg) 6%, transparent);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-line-info .stream-monaco-unchanged-rail {
  border-right-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 14%, transparent);
  background: color-mix(
    in srgb,
    var(--stream-monaco-editor-bg) 80%,
    var(--stream-monaco-editor-fg) 20%
  );
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.04),
    inset -1px 0 0 rgb(15 23 42 / 0.24);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal {
  border-bottom-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 12%, transparent);
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 68%, transparent);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 15px;
  padding: 0;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--stream-monaco-editor-fg) 7%, transparent);
  background: transparent;
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 54%, transparent);
  cursor: pointer;
  font: inherit;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-line-info .stream-monaco-unchanged-reveal {
  width: 100%;
  min-width: 100%;
  margin-left: 0;
  border-bottom-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 8%, transparent);
  background: transparent;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-line-info .stream-monaco-unchanged-reveal:first-child {
  border-radius: 10px 0 0 0;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-line-info .stream-monaco-unchanged-reveal:last-child {
  border-radius: 0 0 0 10px;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-line-info .stream-monaco-unchanged-reveal:first-child:last-child {
  border-radius: 10px 0 0 10px;
}
.stream-monaco-diff-root.stream-monaco-diff-side-by-side .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal {
  min-height: 12px;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal .codicon {
  font-size: 18px;
  line-height: 1;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal:last-child {
  border-bottom: 0;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal:hover,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal:focus-visible,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal.stream-monaco-focus-visible {
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 88%, var(--stream-monaco-editor-fg) 12%);
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 68%, transparent);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal:hover,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal:focus-visible,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal.stream-monaco-focus-visible {
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 74%, var(--stream-monaco-editor-fg) 26%);
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 90%, transparent);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.06);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-line-info .stream-monaco-unchanged-reveal {
  border-bottom-color: color-mix(in srgb, var(--stream-monaco-editor-fg) 14%, transparent);
  background: transparent;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary {
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-width: 0;
  min-height: 30px;
  padding: 0 18px 0 16px;
  border: 0;
  background: transparent;
  box-sizing: border-box;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
  z-index: 1;
  transition: background-color 0.14s ease;
}
.stream-monaco-diff-root.stream-monaco-diff-side-by-side .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary {
  min-height: 22px;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary.stream-monaco-unchanged-summary-metadata {
  min-height: 30px;
  padding: 0 28px;
  cursor: default;
  pointer-events: none;
}
.stream-monaco-diff-root.stream-monaco-diff-side-by-side .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary.stream-monaco-unchanged-summary-metadata {
  min-height: 22px;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary.stream-monaco-unchanged-summary-simple {
  justify-content: center;
  min-height: 28px;
  padding: 0 10px;
  cursor: default;
  pointer-events: none;
}
.stream-monaco-diff-root.stream-monaco-diff-side-by-side .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary.stream-monaco-unchanged-summary-simple {
  min-height: 22px;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary:hover,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary:focus-visible,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary.stream-monaco-focus-visible {
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 91%, var(--stream-monaco-editor-fg) 9%);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple .stream-monaco-unchanged-summary:hover,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple .stream-monaco-unchanged-summary:focus-visible,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple .stream-monaco-unchanged-summary.stream-monaco-focus-visible {
  background: transparent;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple .stream-monaco-unchanged-summary:hover,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple .stream-monaco-unchanged-summary:focus-visible,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple .stream-monaco-unchanged-summary.stream-monaco-focus-visible {
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 96%, transparent);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-metadata .stream-monaco-unchanged-summary:hover,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-metadata .stream-monaco-unchanged-summary:focus-visible,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-metadata .stream-monaco-unchanged-summary.stream-monaco-focus-visible {
  background: transparent;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-metadata .stream-monaco-unchanged-summary:hover,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-metadata .stream-monaco-unchanged-summary:focus-visible,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-metadata .stream-monaco-unchanged-summary.stream-monaco-focus-visible {
  background: transparent;
  box-shadow: none;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-meta {
  justify-self: stretch;
  justify-content: flex-start;
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-meta.stream-monaco-unchanged-meta-simple {
  justify-content: center;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-metadata-label,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-metadata-label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 60%, transparent);
  font-size: 13px;
  line-height: 14px;
  font-weight: 500;
  letter-spacing: 0.01em;
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-metadata-label,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-metadata-label {
  color: color-mix(in srgb, var(--stream-monaco-editor-fg) 88%, transparent);
  font-weight: 550;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-simple-bar,
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-simple-bar {
  width: min(100%, calc(100% - 20px));
  height: 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 88%, var(--stream-monaco-editor-fg) 12%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.7);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .monaco-editor .diff-hidden-lines .center .stream-monaco-unchanged-simple-bar,
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-simple-bar {
  height: 9px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--stream-monaco-editor-bg) 78%, var(--stream-monaco-editor-fg) 22%) 0%,
    color-mix(in srgb, var(--stream-monaco-editor-bg) 72%, var(--stream-monaco-editor-fg) 28%) 100%
  );
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.04),
    inset 0 0 0 1px rgb(148 163 184 / 0.06);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-pane-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--stream-monaco-unchanged-split-offset, 50%);
  width: 1px;
  background: color-mix(in srgb, var(--stream-monaco-editor-fg) 7%, transparent);
  pointer-events: none;
  transform: translateX(-0.5px);
}
.stream-monaco-diff-root.stream-monaco-diff-appearance-dark .stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-pane-divider {
  background: color-mix(in srgb, var(--stream-monaco-editor-fg) 12%, transparent);
}
.stream-monaco-diff-root .stream-monaco-diff-unchanged-bridge.stream-monaco-diff-unchanged-bridge-simple .stream-monaco-unchanged-pane-divider {
  top: 8px;
  bottom: 8px;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines-compact {
  align-items: center;
  gap: 6px;
  height: 16px;
}
.stream-monaco-diff-root .monaco-editor .diff-hidden-lines-compact .text {
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--stream-monaco-unchanged-fg) 10%, var(--stream-monaco-editor-bg) 90%);
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
  background: color-mix(in srgb, var(--stream-monaco-surface) 92%, var(--stream-monaco-editor-bg) 8%);
  border: 1px solid var(--stream-monaco-border);
  box-shadow: 0 12px 20px -18px var(--stream-monaco-widget-shadow);
  opacity: 0.92 !important;
  transition: background-color 0.14s ease, border-color 0.14s ease, transform 0.14s ease, opacity 0.14s ease, box-shadow 0.14s ease;
}
.stream-monaco-diff-root .monaco-editor .fold-unchanged:hover,
.stream-monaco-diff-root .monaco-editor .fold-unchanged.stream-monaco-focus-visible {
  opacity: 1 !important;
  transform: translateY(-1px);
  background: var(--stream-monaco-surface-hover);
  border-color: var(--stream-monaco-border-strong);
  box-shadow: 0 16px 26px -18px var(--stream-monaco-widget-shadow);
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
  padding: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 80%, var(--stream-monaco-editor-fg) 20%);
  border: 1px solid color-mix(in srgb, var(--stream-monaco-editor-fg) 12%, transparent);
  box-shadow: 0 18px 34px -24px var(--stream-monaco-widget-shadow);
  backdrop-filter: blur(14px);
}
.stream-monaco-diff-hunk-actions button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  line-height: 1.35;
  font-weight: 700;
  background: color-mix(in srgb, var(--stream-monaco-editor-bg) 94%, var(--stream-monaco-editor-fg) 6%);
  color: var(--stream-monaco-editor-fg);
  cursor: pointer;
  transition: background-color 0.14s ease, border-color 0.14s ease, transform 0.14s ease;
}
.stream-monaco-diff-hunk-actions button[data-action="revert"] {
  background: color-mix(in srgb, var(--stream-monaco-removed-line) 78%, var(--stream-monaco-editor-bg) 22%);
  border-color: var(--stream-monaco-removed-border);
  color: color-mix(in srgb, var(--stream-monaco-removed-fg) 82%, var(--stream-monaco-editor-fg) 18%);
}
.stream-monaco-diff-hunk-actions button[data-action="stage"] {
  background: color-mix(in srgb, var(--stream-monaco-added-line) 78%, var(--stream-monaco-editor-bg) 22%);
  border-color: var(--stream-monaco-added-border);
  color: color-mix(in srgb, var(--stream-monaco-added-fg) 82%, var(--stream-monaco-editor-fg) 18%);
}
.stream-monaco-diff-hunk-actions button:hover {
  transform: translateY(-1px);
}
.stream-monaco-diff-hunk-actions button:disabled {
  opacity: 0.45;
  cursor: default;
  transform: none;
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

    node.append(
      createButton('revert', 'Revert'),
      createButton('stage', 'Stage'),
    )

    this.createDomDisposable(this.diffHunkDisposables, node, 'mouseenter', () =>
      this.cancelScheduledHideDiffHunkActions())
    this.createDomDisposable(this.diffHunkDisposables, node, 'mouseleave', () =>
      this.scheduleHideDiffHunkActions())
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
    this.diffPersistedUnchangedModelState = this.cloneSerializableValue(
      state.modelState,
    )
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
      modelState: this.cloneSerializableValue(
        this.diffPersistedUnchangedModelState,
      ),
    })
    this.applyPendingDiffScrollRestore()
  }

  private scheduleRestorePersistedDiffUnchangedState() {
    if (this.diffHideUnchangedRegionsDeferred)
      return
    if (!this.diffPersistedUnchangedModelState)
      return
    this.rafScheduler.schedule('restore-diff-unchanged-state', () => {
      requestAnimationFrame(() => {
        this.restorePersistedDiffUnchangedState()
      })
    })
  }

  private clearDeferredDiffUnchangedRegionsIdleTimer() {
    if (this.diffHideUnchangedRegionsIdleTimer != null) {
      clearTimeout(this.diffHideUnchangedRegionsIdleTimer)
      this.diffHideUnchangedRegionsIdleTimer = null
    }
  }

  private clearPendingDiffThemeSync() {
    if (this.diffThemeSyncRafId != null) {
      cancelAnimationFrame(this.diffThemeSyncRafId)
      this.diffThemeSyncRafId = null
    }
  }

  private withLockedDiffScrollPosition(callback: () => void) {
    if (!this.diffEditorView) {
      callback()
      return
    }

    const originalEditor = this.diffEditorView.getOriginalEditor()
    const modifiedEditor = this.diffEditorView.getModifiedEditor()
    const originalTop = originalEditor.getScrollTop?.() ?? 0
    const modifiedTop = modifiedEditor.getScrollTop?.() ?? 0
    const originalLeft = originalEditor.getScrollLeft?.() ?? 0
    const modifiedLeft = modifiedEditor.getScrollLeft?.() ?? 0

    callback()

    const restore = () => {
      originalEditor.setScrollTop?.(originalTop)
      modifiedEditor.setScrollTop?.(modifiedTop)
      originalEditor.setScrollLeft?.(originalLeft)
      modifiedEditor.setScrollLeft?.(modifiedLeft)
    }

    restore()
    requestAnimationFrame(restore)
  }

  private captureDiffScrollPosition() {
    if (!this.diffEditorView)
      return null
    const originalEditor = this.diffEditorView.getOriginalEditor()
    const modifiedEditor = this.diffEditorView.getModifiedEditor()
    return {
      originalTop: originalEditor.getScrollTop?.() ?? 0,
      modifiedTop: modifiedEditor.getScrollTop?.() ?? 0,
      originalLeft: originalEditor.getScrollLeft?.() ?? 0,
      modifiedLeft: modifiedEditor.getScrollLeft?.() ?? 0,
    }
  }

  private captureModifiedViewportAnchor() {
    if (!this.diffEditorView)
      return null
    const modifiedEditor = this.diffEditorView.getModifiedEditor()
    const editorRoot = modifiedEditor.getContainerDomNode?.()
    if (!(editorRoot instanceof HTMLElement))
      return null
    const editorRect = editorRoot.getBoundingClientRect()
    const anchorNode = Array.from(
      editorRoot.querySelectorAll<HTMLElement>('.line-numbers'),
    )
      .map((node) => {
        const lineNumber = Number.parseInt(node.textContent?.trim() || '', 10)
        const rect = node.getBoundingClientRect()
        return {
          node,
          lineNumber,
          rect,
        }
      })
      .filter(({ lineNumber, rect }) => {
        return (
          Number.isFinite(lineNumber)
          && rect.height > 0
          && rect.bottom > editorRect.top + 1
          && rect.top < editorRect.bottom - 1
        )
      })
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!anchorNode)
      return null
    return {
      lineNumber: anchorNode.lineNumber,
      topOffset: anchorNode.rect.top - editorRect.top,
    }
  }

  private restoreDiffScrollPosition(
    position: ReturnType<DiffEditorManager['captureDiffScrollPosition']>,
  ) {
    if (!this.diffEditorView || !position)
      return
    const originalEditor = this.diffEditorView.getOriginalEditor()
    const modifiedEditor = this.diffEditorView.getModifiedEditor()
    const apply = () => {
      originalEditor.setScrollTop?.(position.originalTop)
      modifiedEditor.setScrollTop?.(position.modifiedTop)
      originalEditor.setScrollLeft?.(position.originalLeft)
      modifiedEditor.setScrollLeft?.(position.modifiedLeft)
    }
    apply()
    requestAnimationFrame(() => {
      apply()
      requestAnimationFrame(apply)
    })
  }

  private restoreModifiedViewportAnchor(
    anchor: ReturnType<DiffEditorManager['captureModifiedViewportAnchor']>,
  ) {
    if (!this.diffEditorView || !anchor)
      return
    const originalEditor = this.diffEditorView.getOriginalEditor()
    const modifiedEditor = this.diffEditorView.getModifiedEditor()
    const editorRoot = modifiedEditor.getContainerDomNode?.()
    if (!(editorRoot instanceof HTMLElement))
      return
    const apply = () => {
      const editorRect = editorRoot.getBoundingClientRect()
      const currentNode = Array.from(
        editorRoot.querySelectorAll<HTMLElement>('.line-numbers'),
      )
        .map((node) => {
          const lineNumber = Number.parseInt(node.textContent?.trim() || '', 10)
          return { node, lineNumber }
        })
        .find(({ lineNumber }) => lineNumber === anchor.lineNumber)
        ?.node
      if (!(currentNode instanceof HTMLElement))
        return
      const currentTop
        = currentNode.getBoundingClientRect().top - editorRect.top
      const delta = currentTop - anchor.topOffset
      if (Math.abs(delta) < 0.5)
        return
      const nextTop = (modifiedEditor.getScrollTop?.() ?? 0) + delta
      originalEditor.setScrollTop?.(nextTop)
      modifiedEditor.setScrollTop?.(nextTop)
    }
    apply()
  }

  private scheduleRestoreModifiedViewportAnchor(
    anchor: ReturnType<DiffEditorManager['captureModifiedViewportAnchor']>,
    durationFrames = 8,
    delayFrames = 0,
  ) {
    if (!anchor)
      return
    let remainingDelay = Math.max(0, delayFrames)
    let remainingFrames = Math.max(0, durationFrames)
    const step = () => {
      if (remainingDelay > 0) {
        remainingDelay--
        requestAnimationFrame(step)
        return
      }
      this.restoreModifiedViewportAnchor(anchor)
      if (remainingFrames <= 0)
        return
      remainingFrames--
      requestAnimationFrame(step)
    }
    step()
  }

  private queuePendingDiffScrollRestore(
    position: ReturnType<DiffEditorManager['captureDiffScrollPosition']>,
    budget = 2,
  ) {
    if (!position || budget < 1) {
      this.pendingDiffScrollRestorePosition = null
      this.pendingDiffScrollRestoreBudget = 0
      return
    }
    this.pendingDiffScrollRestorePosition = { ...position }
    this.pendingDiffScrollRestoreBudget = budget
  }

  private applyPendingDiffScrollRestore() {
    if (
      !this.pendingDiffScrollRestorePosition
      || this.pendingDiffScrollRestoreBudget < 1
    ) {
      return
    }
    this.restoreDiffScrollPosition(this.pendingDiffScrollRestorePosition)
    this.pendingDiffScrollRestoreBudget -= 1
    if (this.pendingDiffScrollRestoreBudget < 1) {
      this.pendingDiffScrollRestorePosition = null
    }
  }

  private resolveDiffPresentationEditorOptions(
    hideUnchangedRegions = this.resolveDiffHideUnchangedRegionsOption(),
  ): monaco.editor.IDiffEditorOptions {
    return {
      readOnly: this.options.readOnly ?? true,
      lineDecorationsWidth: this.options.lineDecorationsWidth,
      lineNumbersMinChars: this.options.lineNumbersMinChars,
      glyphMargin: this.options.glyphMargin,
      fontFamily: this.options.fontFamily,
      fontSize: this.options.fontSize,
      lineHeight: this.options.lineHeight,
      padding: this.options.padding,
      renderLineHighlight: this.options.renderLineHighlight,
      renderLineHighlightOnlyWhenFocus:
        this.options.renderLineHighlightOnlyWhenFocus,
      renderOverviewRuler: this.options.renderOverviewRuler,
      scrollBeyondLastLine: this.options.scrollBeyondLastLine ?? false,
      scrollbar: {
        ...defaultScrollbar,
        ...(this.options.scrollbar || {}),
      },
      hideUnchangedRegions: this.diffHideUnchangedRegionsDeferred
        ? {
            ...hideUnchangedRegions,
            enabled: false,
          }
        : hideUnchangedRegions,
    }
  }

  refreshDiffPresentation() {
    if (!this.diffEditorView)
      return

    const hideUnchangedRegions = this.resolveDiffHideUnchangedRegionsOption()
    const presentationOptions
      = this.resolveDiffPresentationEditorOptions(hideUnchangedRegions)

    this.diffHideUnchangedRegionsResolved = hideUnchangedRegions
    this.diffUpdateThrottleMs = this.resolveDiffStreamingThrottleMs()

    if (this.lastContainer) {
      this.lastContainer.style.maxHeight = this.maxHeightCSS
      this.lastContainer.style.removeProperty('--stream-monaco-editor-bg')
      this.lastContainer.style.removeProperty('--stream-monaco-editor-fg')
    }

    this.withLockedDiffScrollPosition(() => {
      this.diffEditorView?.updateOptions(presentationOptions)
    })

    this.diffHeightManager?.update()
    this.applyDiffRootAppearanceClass()
    this.schedulePatchDiffUnchangedRegionsAfterInteraction(1)
    this.repositionDiffHunkNodes()
  }

  private restoreDeferredDiffUnchangedRegions() {
    this.clearDeferredDiffUnchangedRegionsIdleTimer()
    if (!this.diffEditorView)
      return
    const hideUnchangedRegions = this.diffHideUnchangedRegionsResolved
    if (!hideUnchangedRegions?.enabled)
      return
    if (!this.diffHideUnchangedRegionsDeferred)
      return

    this.diffHideUnchangedRegionsDeferred = false
    this.withLockedDiffScrollPosition(() => {
      this.diffEditorView?.updateOptions({
        hideUnchangedRegions,
      })
    })
    this.schedulePatchDiffUnchangedRegionsAfterInteraction(1)
    if (this.shouldAutoScrollDiff) {
      this.maybeScrollDiffToBottom(this.modifiedModel?.getLineCount())
    }
  }

  private markDiffStreamingActivity() {
    const hideUnchangedRegions = this.diffHideUnchangedRegionsResolved
    if (!this.diffEditorView || !hideUnchangedRegions?.enabled)
      return

    this.clearDeferredDiffUnchangedRegionsIdleTimer()
    this.rafScheduler.cancel('restore-diff-unchanged-state')
    this.diffHideUnchangedRegionsIdleTimer = setTimeout(() => {
      this.restoreDeferredDiffUnchangedRegions()
    }, 1800) as unknown as number

    if (this.diffHideUnchangedRegionsDeferred)
      return

    this.diffHideUnchangedRegionsDeferred = true
    this.hideAllDiffUnchangedBridgeEntries()
    this.withLockedDiffScrollPosition(() => {
      this.diffEditorView?.updateOptions({
        hideUnchangedRegions: {
          ...hideUnchangedRegions,
          enabled: false,
        },
      })
    })
    this.schedulePatchDiffUnchangedRegionsAfterInteraction(1)
  }

  notifyThemeChange(themeName: MonacoTheme | string) {
    const resolvedThemeName
      = typeof themeName === 'string' ? themeName : (themeName as any)?.name
    if (typeof resolvedThemeName === 'string')
      this.options.theme = resolvedThemeName
    this.diffRootAppearanceSignature = null
    this.clearPendingDiffThemeSync()
    if (this.lastContainer) {
      this.lastContainer.style.removeProperty('--stream-monaco-editor-bg')
      this.lastContainer.style.removeProperty('--stream-monaco-editor-fg')
    }

    const sync = () => {
      this.diffThemeSyncRafId = null
      this.applyDiffRootAppearanceClass()
      this.schedulePatchDiffUnchangedRegionsAfterInteraction(1)
      this.repositionDiffHunkNodes()
    }

    requestAnimationFrame(() => {
      this.diffThemeSyncRafId = requestAnimationFrame(sync)
    })
  }

  private bindPersistOnMouseRelease(
    bucket: monaco.IDisposable[],
    node: HTMLElement,
  ) {
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
        catch {}
      }
      this.diffUnchangedRegionDisposables.length = 0
    }

    this.rafScheduler.cancel('patch-diff-unchanged-regions')
    this.rafScheduler.cancel('capture-diff-unchanged-state')
    this.rafScheduler.cancel('restore-diff-unchanged-state')
    this.clearDeferredDiffUnchangedRegionsIdleTimer()
    this.diffHideUnchangedRegionsDeferred = false
  }

  private bindFocusVisibleClass(
    bucket: monaco.IDisposable[],
    node: HTMLElement,
  ) {
    this.createDomDisposable(bucket, node, 'focus', () =>
      node.classList.add('stream-monaco-focus-visible'))
    this.createDomDisposable(bucket, node, 'blur', () =>
      node.classList.remove('stream-monaco-focus-visible'))
  }

  private bindFocusWithinClass(
    bucket: monaco.IDisposable[],
    node: HTMLElement,
    className: string,
  ) {
    this.createDomDisposable(bucket, node, 'focusin', () =>
      node.classList.add(className))
    this.createDomDisposable(bucket, node, 'focusout', () => {
      requestAnimationFrame(() => {
        if (node.matches(':focus-within'))
          return
        node.classList.remove(className)
      })
    })
  }

  private clearDiffUnchangedBridgeOverlay(removeContainer = true) {
    this.clearDiffUnchangedBridgeSources()

    if (this.diffUnchangedBridgeOverlay)
      this.diffUnchangedBridgeOverlay.replaceChildren()
    if (this.diffUnchangedBridgeOverlay) {
      this.diffUnchangedBridgeOverlay.style.transform
        = 'translate3d(0px, 0px, 0px)'
    }

    this.diffUnchangedBridgeEntries.clear()
    this.diffUnchangedBridgePool.length = 0
    this.diffUnchangedOverlayScrollTop = 0
    this.diffUnchangedOverlayScrollLeft = 0

    if (removeContainer && this.diffUnchangedBridgeOverlay?.parentElement)
      this.diffUnchangedBridgeOverlay.remove()
    if (removeContainer)
      this.diffUnchangedBridgeOverlay = null
  }

  private clearDiffUnchangedBridgeSources() {
    if (!this.lastContainer)
      return
    const bridgedCenters = this.lastContainer.querySelectorAll<HTMLElement>(
      '.stream-monaco-unchanged-bridge-source',
    )
    bridgedCenters.forEach(node =>
      node.classList.remove('stream-monaco-unchanged-bridge-source'),
    )
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

  private readDiffUnchangedOverlayScrollState() {
    const modifiedEditor = this.diffEditorView?.getModifiedEditor()
    return {
      top: modifiedEditor?.getScrollTop?.() ?? 0,
      left: modifiedEditor?.getScrollLeft?.() ?? 0,
    }
  }

  private syncDiffUnchangedOverlayScrollBaseline() {
    const overlay = this.diffUnchangedBridgeOverlay
    if (overlay)
      overlay.style.transform = 'translate3d(0px, 0px, 0px)'
    const { top, left } = this.readDiffUnchangedOverlayScrollState()
    this.diffUnchangedOverlayScrollTop = top
    this.diffUnchangedOverlayScrollLeft = left
  }

  private applyDiffUnchangedOverlayScrollCompensation() {
    const overlay = this.diffUnchangedBridgeOverlay
    if (!overlay || overlay.hidden)
      return

    const { top, left } = this.readDiffUnchangedOverlayScrollState()
    const deltaY = this.diffUnchangedOverlayScrollTop - top
    const deltaX = this.diffUnchangedOverlayScrollLeft - left

    if (Math.abs(deltaY) < 0.5 && Math.abs(deltaX) < 0.5)
      return
    overlay.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0px)`
  }

  private resolveDiffUnchangedViewZoneHeight() {
    switch (this.resolveDiffUnchangedRegionStyleOption()) {
      case 'line-info':
      case 'line-info-basic':
      case 'metadata':
        return 32
      case 'simple':
        return 28
      default:
        return 32
    }
  }

  private collectDiffUnchangedViewZoneIds(
    editorRoot: HTMLElement,
    scrollTop: number,
  ) {
    const widgetTopValues = Array.from(
      editorRoot.querySelectorAll<HTMLElement>('.diff-hidden-lines-widget'),
    )
      .map(node => Number.parseFloat(node.style.top || 'NaN'))
      .filter(value => Number.isFinite(value) && value > -100000)
    if (widgetTopValues.length === 0)
      return []

    return Array.from(
      editorRoot.querySelectorAll<HTMLElement>(
        '.view-zones > div[monaco-view-zone][monaco-visible-view-zone="true"]',
      ),
    )
      .filter((node) => {
        const zoneTop = Number.parseFloat(node.style.top || 'NaN')
        const currentHeight = Number.parseFloat(node.style.height || '0')
        return (
          Number.isFinite(zoneTop)
          && Number.isFinite(currentHeight)
          && currentHeight > 0
          && widgetTopValues.some(
            widgetTop => Math.abs(zoneTop - scrollTop - widgetTop) < 0.5,
          )
        )
      })
      .map(node => node.getAttribute('monaco-view-zone'))
      .filter((value): value is string => Boolean(value))
  }

  private syncDiffUnchangedViewZoneHeightsForEditor(
    editor: monaco.editor.ICodeEditor | null | undefined,
    editorRoot: HTMLElement | null | undefined,
    targetHeight: number,
  ) {
    if (!editor || !(editorRoot instanceof HTMLElement))
      return false

    const zoneIds = this.collectDiffUnchangedViewZoneIds(
      editorRoot,
      editor.getScrollTop?.() ?? 0,
    )
    if (zoneIds.length === 0)
      return false

    const editorInternal = editor as typeof editor & {
      _modelData?: {
        view?: {
          _viewZones?: {
            _zones?: Record<
              string,
              {
                delegate?: {
                  heightInPx?: number
                }
              }
            >
          }
        }
      }
    }
    const zones = editorInternal._modelData?.view?._viewZones?._zones
    if (!zones)
      return false

    const changedZoneIds = zoneIds.filter((id) => {
      const delegate = zones[id]?.delegate
      return delegate && delegate.heightInPx !== targetHeight
    })
    if (changedZoneIds.length === 0)
      return false

    editor.changeViewZones((accessor) => {
      for (const id of changedZoneIds) {
        const delegate = zones[id]?.delegate
        if (!delegate)
          continue
        delegate.heightInPx = targetHeight
        accessor.layoutZone(id)
      }
    })
    return true
  }

  private syncDiffUnchangedViewZoneHeights() {
    if (!this.diffEditorView)
      return false
    const targetHeight = this.resolveDiffUnchangedViewZoneHeight()
    const originalEditor = this.diffEditorView.getOriginalEditor()
    const modifiedEditor = this.diffEditorView.getModifiedEditor()

    const originalChanged = this.syncDiffUnchangedViewZoneHeightsForEditor(
      originalEditor,
      originalEditor.getContainerDomNode?.(),
      targetHeight,
    )
    const modifiedChanged = this.syncDiffUnchangedViewZoneHeightsForEditor(
      modifiedEditor,
      modifiedEditor.getContainerDomNode?.(),
      targetHeight,
    )

    return originalChanged || modifiedChanged
  }

  private getDiffUnchangedNodeId(node: HTMLElement) {
    const existingId = this.diffUnchangedNodeIds.get(node)
    if (existingId)
      return existingId
    const nextId = `diff-unchanged-${++this.diffUnchangedNodeIdSequence}`
    this.diffUnchangedNodeIds.set(node, nextId)
    return nextId
  }

  private getDiffUnchangedBridgeKey(
    secondaryNode: HTMLElement,
    primaryNode: HTMLElement,
  ) {
    return `${this.getDiffUnchangedNodeId(
      secondaryNode,
    )}:${this.getDiffUnchangedNodeId(primaryNode)}`
  }

  private createDiffUnchangedBridgeEntry(key: string) {
    const bridge = document.createElement('div')
    bridge.className = 'stream-monaco-diff-unchanged-bridge'
    bridge.setAttribute('role', 'group')
    bridge.hidden = true

    const summary = document.createElement('button')
    summary.type = 'button'
    summary.className = 'stream-monaco-unchanged-summary'

    const visualMeta = document.createElement('div')
    visualMeta.className = 'stream-monaco-unchanged-meta'
    summary.append(visualMeta)

    const divider = document.createElement('span')
    divider.className = 'stream-monaco-unchanged-pane-divider'
    divider.setAttribute('aria-hidden', 'true')

    const entry: DiffUnchangedBridgeEntry = {
      key,
      bridge,
      rail: null,
      summary,
      visualMeta,
      divider,
      activate: () => {},
      topButton: null,
      bottomButton: null,
    }

    summary.onclick = (event) => {
      event.preventDefault()
      this.activateDiffUnchangedBridgeEntry(entry)
    }

    const onWheel = (event: WheelEvent) => {
      if (!this.diffEditorView)
        return
      if (Math.abs(event.deltaY) < 0.5 && Math.abs(event.deltaX) < 0.5)
        return
      event.preventDefault()
      event.stopPropagation()

      const originalEditor = this.diffEditorView.getOriginalEditor()
      const modifiedEditor = this.diffEditorView.getModifiedEditor()
      const targetScrollTop
        = (modifiedEditor.getScrollTop?.() ?? 0) + event.deltaY
      const targetScrollLeft
        = (modifiedEditor.getScrollLeft?.() ?? 0) + event.deltaX

      originalEditor.setScrollTop?.(targetScrollTop)
      modifiedEditor.setScrollTop?.(targetScrollTop)
      if (Math.abs(event.deltaX) >= 0.5) {
        originalEditor.setScrollLeft?.(targetScrollLeft)
        modifiedEditor.setScrollLeft?.(targetScrollLeft)
      }
      this.schedulePatchDiffUnchangedRegionsAfterScroll()
    }
    bridge.addEventListener('wheel', onWheel, { passive: false })
    this.diffUnchangedRegionDisposables.push({
      dispose: () => bridge.removeEventListener('wheel', onWheel),
    })

    bridge.append(summary, divider)
    return entry
  }

  private acquireDiffUnchangedBridgeEntry(key: string) {
    const existing = this.diffUnchangedBridgeEntries.get(key)
    if (existing)
      return existing

    const entry
      = this.diffUnchangedBridgePool.pop()
        ?? this.createDiffUnchangedBridgeEntry(key)
    entry.key = key
    entry.bridge.hidden = false
    entry.bridge.removeAttribute('aria-hidden')
    this.diffUnchangedBridgeEntries.set(key, entry)
    return entry
  }

  private releaseDiffUnchangedBridgeEntry(entry: DiffUnchangedBridgeEntry) {
    if (entry.key)
      this.diffUnchangedBridgeEntries.delete(entry.key)
    entry.key = null
    entry.bridge.hidden = true
    entry.bridge.setAttribute('aria-hidden', 'true')
    this.diffUnchangedBridgePool.push(entry)
  }

  private hideAllDiffUnchangedBridgeEntries() {
    for (const entry of Array.from(this.diffUnchangedBridgeEntries.values())) {
      this.releaseDiffUnchangedBridgeEntry(entry)
    }
    this.clearDiffUnchangedBridgeSources()
  }

  private schedulePatchDiffUnchangedRegionsAfterInteraction(frames = 1) {
    this.rafScheduler.schedule(
      'patch-diff-unchanged-regions-after-interaction',
      () => {
        let remaining = Math.max(0, frames)
        const step = () => {
          if (remaining > 0) {
            remaining--
            requestAnimationFrame(step)
            return
          }
          this.schedulePatchDiffUnchangedRegions()
        }
        step()
      },
    )
  }

  private activateDiffUnchangedBridgeEntry(entry: DiffUnchangedBridgeEntry) {
    this.hideAllDiffUnchangedBridgeEntries()
    entry.activate()
    this.schedulePatchDiffUnchangedRegionsAfterInteraction()
  }

  private updateDiffUnchangedBridgeMeta(
    entry: DiffUnchangedBridgeEntry,
    unchangedRegionStyle:
      | 'line-info'
      | 'line-info-basic'
      | 'metadata'
      | 'simple',
    summaryLabel: string,
  ) {
    this.updateDiffUnchangedMetaNode(
      entry.visualMeta,
      unchangedRegionStyle,
      summaryLabel,
    )
  }

  private updateDiffUnchangedMetaNode(
    metaNode: HTMLElement,
    unchangedRegionStyle:
      | 'line-info'
      | 'line-info-basic'
      | 'metadata'
      | 'simple',
    summaryLabel: string,
  ) {
    const lastStyle = metaNode.dataset.style
    const lastLabel = metaNode.dataset.label
    if (lastStyle === unchangedRegionStyle && lastLabel === summaryLabel)
      return

    metaNode.dataset.style = unchangedRegionStyle
    metaNode.dataset.label = summaryLabel
    metaNode.replaceChildren()
    metaNode.classList.toggle(
      'stream-monaco-unchanged-meta-simple',
      unchangedRegionStyle === 'simple',
    )

    if (unchangedRegionStyle === 'simple') {
      const simpleBar = document.createElement('span')
      simpleBar.className = 'stream-monaco-unchanged-simple-bar'
      simpleBar.setAttribute('aria-hidden', 'true')
      metaNode.append(simpleBar)
      return
    }

    const label = document.createElement('span')
    if (unchangedRegionStyle === 'metadata') {
      label.className = 'stream-monaco-unchanged-metadata-label'
    }
    else {
      label.className = 'stream-monaco-unchanged-count'
    }
    label.textContent = summaryLabel
    metaNode.append(label)
  }

  private syncDiffUnchangedRevealButton(
    entry: DiffUnchangedBridgeEntry,
    slot: 'topButton' | 'bottomButton',
    handle: HTMLElement | null,
    direction: 'up' | 'down',
    label: string,
  ) {
    const existingButton = entry[slot]
    const button = existingButton ?? document.createElement('button')
    if (!existingButton) {
      button.type = 'button'
      button.className = 'stream-monaco-unchanged-reveal'
      button.innerHTML = `<span class="codicon codicon-chevron-${direction}"></span>`
    }
    button.dataset.direction = direction
    button.hidden = !handle
    button.disabled = !handle
    button.toggleAttribute('aria-hidden', !handle)
    button.title = handle ? label : ''
    button.setAttribute('aria-label', handle ? label : '')
    button.onclick = handle
      ? (event) => {
          event.preventDefault()
          event.stopPropagation()
          this.hideAllDiffUnchangedBridgeEntries()
          this.activateDiffUnchangedHandle(handle)
          this.schedulePatchDiffUnchangedRegionsAfterInteraction()
        }
      : null
    entry[slot] = button
  }

  private syncDiffUnchangedBridgeRail(
    entry: DiffUnchangedBridgeEntry,
    showTopHandle: boolean,
    topHandle: HTMLElement | null,
    showBottomHandle: boolean,
    bottomHandle: HTMLElement | null,
  ) {
    if (!entry.rail) {
      entry.rail = document.createElement('div')
      entry.rail.className = 'stream-monaco-unchanged-rail'
    }

    const shouldRenderRail = showTopHandle || showBottomHandle
    this.syncDiffUnchangedRevealButton(
      entry,
      'topButton',
      showTopHandle ? topHandle : null,
      'down',
      'Reveal more unmodified lines below',
    )
    this.syncDiffUnchangedRevealButton(
      entry,
      'bottomButton',
      showBottomHandle ? bottomHandle : null,
      'up',
      'Reveal more unmodified lines above',
    )
    entry.rail.hidden = !shouldRenderRail
    entry.rail.toggleAttribute('aria-hidden', !shouldRenderRail)
    entry.rail.classList.toggle(
      'stream-monaco-unchanged-rail-top-only',
      showTopHandle && !showBottomHandle,
    )
    entry.rail.classList.toggle(
      'stream-monaco-unchanged-rail-bottom-only',
      !showTopHandle && showBottomHandle,
    )
    entry.rail.classList.toggle(
      'stream-monaco-unchanged-rail-both',
      showTopHandle && showBottomHandle,
    )
    if (entry.topButton && entry.topButton.parentElement !== entry.rail)
      entry.rail.append(entry.topButton)
    if (entry.bottomButton && entry.bottomButton.parentElement !== entry.rail)
      entry.rail.append(entry.bottomButton)
  }

  private pruneDiffUnchangedBridgeEntries(visibleKeys: Set<string>) {
    for (const [key, entry] of Array.from(this.diffUnchangedBridgeEntries)) {
      if (visibleKeys.has(key))
        continue
      this.releaseDiffUnchangedBridgeEntry(entry)
    }
  }

  private dispatchSyntheticMouseDown(node: HTMLElement) {
    const view = node.ownerDocument.defaultView
    if (!view)
      return
    const rect = node.getBoundingClientRect()
    node.dispatchEvent(
      new view.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    )
  }

  private dispatchSyntheticMouseTap(node: HTMLElement) {
    const view = node.ownerDocument.defaultView
    if (!view)
      return
    const rect = node.getBoundingClientRect()
    const clientX = rect.left + rect.width / 2
    const clientY = rect.top + rect.height / 2
    node.dispatchEvent(
      new view.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
      }),
    )
    node.dispatchEvent(
      new view.MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
      }),
    )
  }

  private formatDiffUnchangedCountLabel(text: string) {
    const match = text.match(/\d+/)
    const count = match ? Number.parseInt(match[0], 10) : Number.NaN
    if (Number.isFinite(count))
      return `${count} unmodified ${count === 1 ? 'line' : 'lines'}`
    return text.replace(/hidden/gi, 'unmodified')
  }

  private countDiffLines(startLineNumber: number, endLineNumber: number) {
    return endLineNumber >= startLineNumber
      ? endLineNumber - startLineNumber + 1
      : 0
  }

  private measureDiffUnchangedSurroundingLines(primaryNode: HTMLElement) {
    const editorRoot
      = primaryNode.closest<HTMLElement>('.editor.modified')
        ?? primaryNode.closest<HTMLElement>('.monaco-editor')
    if (!editorRoot) {
      return {
        previousVisibleLine: null as number | null,
        nextVisibleLine: null as number | null,
      }
    }

    const widgetRect = primaryNode.getBoundingClientRect()
    let previousVisibleLine: number | null = null
    let nextVisibleLine: number | null = null
    const lineNumberNodes
      = editorRoot.querySelectorAll<HTMLElement>('.line-numbers')

    lineNumberNodes.forEach((node) => {
      const lineNumber = Number.parseInt(node.textContent?.trim() || '', 10)
      if (!Number.isFinite(lineNumber))
        return
      const top = node.getBoundingClientRect().top
      if (top < widgetRect.top - 1) {
        previousVisibleLine
          = previousVisibleLine == null
            ? lineNumber
            : Math.max(previousVisibleLine, lineNumber)
      }
      else if (top > widgetRect.bottom + 1) {
        nextVisibleLine
          = nextVisibleLine == null
            ? lineNumber
            : Math.min(nextVisibleLine, lineNumber)
      }
    })

    return {
      previousVisibleLine,
      nextVisibleLine,
    }
  }

  private formatDiffMetadataRange(startLineNumber: number, lineCount: number) {
    return `${startLineNumber},${Math.max(0, lineCount)}`
  }

  private buildDiffHunkMetadataLabel(change: monaco.editor.ILineChange) {
    const contextLineCount
      = this.resolveDiffHideUnchangedRegionsOption().contextLineCount ?? 3
    const originalTotalLines = this.originalModel?.getLineCount() ?? 0
    const modifiedTotalLines = this.modifiedModel?.getLineCount() ?? 0

    const originalChangedCount = this.countDiffLines(
      change.originalStartLineNumber,
      change.originalEndLineNumber,
    )
    const modifiedChangedCount = this.countDiffLines(
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

    const originalEnd
      = originalChangedCount > 0
        ? Math.min(
            originalTotalLines,
            change.originalEndLineNumber + contextLineCount,
          )
        : Math.min(originalTotalLines, originalAnchor + contextLineCount - 1)
    const modifiedEnd
      = modifiedChangedCount > 0
        ? Math.min(
            modifiedTotalLines,
            change.modifiedEndLineNumber + contextLineCount,
          )
        : Math.min(modifiedTotalLines, modifiedAnchor + contextLineCount - 1)

    const originalDisplayCount
      = originalEnd >= originalStart ? originalEnd - originalStart + 1 : 0
    const modifiedDisplayCount
      = modifiedEnd >= modifiedStart ? modifiedEnd - modifiedStart + 1 : 0

    return {
      modifiedStart,
      originalStart,
      label: `@@ -${this.formatDiffMetadataRange(
        originalStart,
        originalDisplayCount,
      )} +${this.formatDiffMetadataRange(
        modifiedStart,
        modifiedDisplayCount,
      )} @@`,
    }
  }

  private resolveDiffMetadataLabel(
    primaryNode: HTMLElement,
    pairIndex: number,
  ) {
    const lineChanges = this.getEffectiveLineChanges()
    if (lineChanges.length === 0)
      return null

    const metadataEntries = lineChanges.map(change =>
      this.buildDiffHunkMetadataLabel(change),
    )
    const { nextVisibleLine }
      = this.measureDiffUnchangedSurroundingLines(primaryNode)

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

    return (
      metadataEntries[Math.min(pairIndex, metadataEntries.length - 1)]?.label
      ?? null
    )
  }

  private activateDiffUnchangedHandle(node: HTMLElement | null | undefined) {
    if (!(node instanceof HTMLElement))
      return
    this.dispatchSyntheticMouseTap(node)
    this.scheduleCapturePersistedDiffUnchangedState(1)
  }

  private resolveDiffUnchangedRevealLayout(
    primaryNode: HTMLElement,
    countText: string,
    pairIndex: number,
    pairCount: number,
  ) {
    let showTopHandle = pairCount === 1 || pairIndex > 0
    let showBottomHandle = pairCount === 1 || pairIndex < pairCount - 1

    const countMatch = countText.match(/\d+/)
    const hiddenCount = countMatch
      ? Number.parseInt(countMatch[0], 10)
      : Number.NaN
    if (!Number.isFinite(hiddenCount))
      return { showTopHandle, showBottomHandle }

    const { previousVisibleLine, nextVisibleLine }
      = this.measureDiffUnchangedSurroundingLines(primaryNode)

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

    const modelLineCount
      = this.diffEditorView?.getModifiedEditor().getModel()?.getLineCount?.()
        ?? null
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

  private resolveDiffUnchangedMergeRole(
    node: HTMLElement,
  ): 'none' | 'primary' | 'secondary' {
    const diffRoot = node.closest('.monaco-diff-editor.side-by-side')
    if (!(diffRoot instanceof HTMLElement))
      return 'none'

    const nodeRect = node.getBoundingClientRect()
    const nodeCenter = nodeRect.left + nodeRect.width / 2
    const originalHost = this.diffEditorView
      ?.getOriginalEditor()
      .getContainerDomNode?.()
    const modifiedHost = this.diffEditorView
      ?.getModifiedEditor()
      .getContainerDomNode?.()

    if (
      originalHost instanceof HTMLElement
      && modifiedHost instanceof HTMLElement
    ) {
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

  private patchDiffUnchangedCenter(node: HTMLElement, pairIndex = 0) {
    node.classList.add('stream-monaco-clickable')
    node.title = 'Click to expand all unmodified lines'
    const mergeRole = this.resolveDiffUnchangedMergeRole(node)
    const shouldUseMergedSecondary = mergeRole === 'secondary'
    const unchangedRegionStyle = this.resolveDiffUnchangedRegionStyleOption()
    node.classList.toggle(
      'stream-monaco-unchanged-merged-secondary',
      shouldUseMergedSecondary,
    )
    node.classList.toggle(
      'stream-monaco-unchanged-merged-primary',
      mergeRole === 'primary',
    )

    const primary = node.children.item(0)
    const meta = node.children.item(1)
    if (primary instanceof HTMLElement)
      primary.classList.add('stream-monaco-unchanged-primary')
    if (meta instanceof HTMLElement) {
      meta.classList.add('stream-monaco-unchanged-meta')
      const countSource
        = meta.querySelector<HTMLElement>('.count') ?? meta.firstElementChild
      const countText = this.formatDiffUnchangedCountLabel(
        countSource?.textContent?.trim() || 'Unmodified lines',
      )
      const summaryLabel
        = unchangedRegionStyle === 'metadata'
          ? this.resolveDiffMetadataLabel(node, pairIndex) ?? countText
          : countText
      this.updateDiffUnchangedMetaNode(meta, unchangedRegionStyle, summaryLabel)
    }

    const action = node.querySelector('a')
    if (action instanceof HTMLElement) {
      action.classList.add('stream-monaco-unchanged-expand')
      action.dataset.streamMonacoLabel = 'Expand all'
      action.title = 'Expand all unmodified lines'
      action.setAttribute('aria-label', 'Expand all unmodified lines')
      action.toggleAttribute('aria-hidden', shouldUseMergedSecondary)
      action.tabIndex = shouldUseMergedSecondary ? -1 : 0
      if (action.dataset.streamMonacoExpandPatched !== 'true') {
        action.dataset.streamMonacoExpandPatched = 'true'
        this.createDomDisposable(
          this.diffUnchangedRegionDisposables,
          action,
          'click',
          () => {
            this.hideAllDiffUnchangedBridgeEntries()
            this.scheduleCapturePersistedDiffUnchangedState(1)
            this.schedulePatchDiffUnchangedRegionsAfterInteraction()
          },
        )
      }
    }

    if (node.dataset.streamMonacoCenterPatched !== 'true') {
      node.dataset.streamMonacoCenterPatched = 'true'
      this.bindFocusWithinClass(
        this.diffUnchangedRegionDisposables,
        node,
        'stream-monaco-focus-within',
      )

      const activate = () => {
        const action = node.querySelector('a')
        if (action instanceof HTMLElement)
          action.click()
      }

      this.createDomDisposable(
        this.diffUnchangedRegionDisposables,
        node,
        'click',
        (event) => {
          const mouseEvent = event as MouseEvent
          if (mouseEvent.button !== 0)
            return
          const target
            = event.target instanceof HTMLElement ? event.target : null
          if (target?.closest('a, .breadcrumb-item'))
            return
          event.preventDefault()
          this.hideAllDiffUnchangedBridgeEntries()
          activate()
          this.scheduleCapturePersistedDiffUnchangedState(1)
          this.schedulePatchDiffUnchangedRegionsAfterInteraction()
        },
      )
    }
  }

  private renderMergedDiffUnchangedBridge(
    secondaryNode: HTMLElement,
    primaryNode: HTMLElement,
    pairIndex: number,
    pairCount: number,
  ): string | null {
    if (!this.lastContainer)
      return null
    const overlay = this.ensureDiffUnchangedBridgeOverlay()
    if (!overlay)
      return null

    const containerRect = this.lastContainer.getBoundingClientRect()
    const secondaryRect = secondaryNode.getBoundingClientRect()
    const primaryRect = primaryNode.getBoundingClientRect()
    const primaryStyle = globalThis.getComputedStyle(primaryNode)
    const countSource
      = primaryNode.querySelector<HTMLElement>(
        '.stream-monaco-unchanged-count',
      )
      ?? secondaryNode.querySelector<HTMLElement>('.stream-monaco-unchanged-count')
    const countText = this.formatDiffUnchangedCountLabel(
      countSource?.textContent?.trim() || 'Unmodified lines',
    )
    const unchangedRegionStyle = this.resolveDiffUnchangedRegionStyleOption()
    const metadataLabel
      = unchangedRegionStyle === 'metadata'
        ? this.resolveDiffMetadataLabel(primaryNode, pairIndex)
        : null
    const editorSurface
      = primaryNode.closest<HTMLElement>('.monaco-editor') ?? primaryNode
    const editorSurfaceStyle = globalThis.getComputedStyle(editorSurface)
    const primaryHidden = primaryNode.parentElement
    const secondaryHidden = secondaryNode.parentElement
    const primaryWidget = primaryHidden?.parentElement
    const secondaryWidget = secondaryHidden?.parentElement
    const topHandle
      = primaryHidden?.querySelector<HTMLElement>('.top')
        ?? secondaryHidden?.querySelector<HTMLElement>('.top')
    const bottomHandle
      = primaryHidden?.querySelector<HTMLElement>('.bottom')
        ?? secondaryHidden?.querySelector<HTMLElement>('.bottom')
    const { showTopHandle, showBottomHandle }
      = this.resolveDiffUnchangedRevealLayout(
        primaryNode,
        countText,
        pairIndex,
        pairCount,
      )
    const key = this.getDiffUnchangedBridgeKey(secondaryNode, primaryNode)

    secondaryNode.classList.add('stream-monaco-unchanged-bridge-source')
    primaryNode.classList.add('stream-monaco-unchanged-bridge-source')

    const entry = this.acquireDiffUnchangedBridgeEntry(key)

    const { bridge, summary, divider } = entry
    bridge.className = 'stream-monaco-diff-unchanged-bridge'
    bridge.classList.add(
      `stream-monaco-diff-unchanged-bridge-${unchangedRegionStyle}`,
    )

    const secondaryAnchorRect
      = secondaryWidget?.getBoundingClientRect() ?? secondaryRect
    const primaryAnchorRect
      = primaryWidget?.getBoundingClientRect() ?? primaryRect
    const secondaryMargin = secondaryNode
      .closest<HTMLElement>('.monaco-editor')
      ?.querySelector<HTMLElement>('.margin')
    const secondaryMarginRect = secondaryMargin?.getBoundingClientRect()
    const lineInfoRailMetrics
      = unchangedRegionStyle === 'line-info'
        ? this.resolveDiffUnchangedLineInfoRailMetrics(secondaryNode)
        : null
    const bridgeLeftInset = lineInfoRailMetrics?.leftInset ?? 0
    const bridgeRailWidth
      = lineInfoRailMetrics?.width ?? secondaryMarginRect?.width ?? null

    bridge.style.left = `${
      secondaryAnchorRect.left
      - containerRect.left
      + this.lastContainer.scrollLeft
      + bridgeLeftInset
    }px`
    bridge.style.top = `${
      primaryAnchorRect.top - containerRect.top + this.lastContainer.scrollTop
    }px`
    bridge.style.width = `${Math.max(
      0,
      primaryAnchorRect.right - secondaryAnchorRect.left - bridgeLeftInset,
    )}px`
    bridge.style.height = `${Math.max(
      secondaryAnchorRect.height,
      primaryAnchorRect.height,
    )}px`
    bridge.style.color = primaryStyle.color
    bridge.style.fontFamily = primaryStyle.fontFamily
    bridge.style.fontSize = primaryStyle.fontSize
    bridge.style.lineHeight = primaryStyle.lineHeight
    bridge.style.setProperty('--stream-monaco-unchanged-fg', primaryStyle.color)
    bridge.style.setProperty(
      '--stream-monaco-editor-bg',
      editorSurfaceStyle.backgroundColor,
    )
    bridge.style.setProperty(
      '--stream-monaco-unchanged-split-offset',
      `${Math.max(0, secondaryAnchorRect.width - bridgeLeftInset)}px`,
    )
    if (bridgeRailWidth) {
      bridge.style.setProperty(
        '--stream-monaco-unchanged-rail-width',
        `${bridgeRailWidth}px`,
      )
    }
    else {
      bridge.style.removeProperty('--stream-monaco-unchanged-rail-width')
    }

    summary.classList.remove(
      'stream-monaco-unchanged-summary-line-info',
      'stream-monaco-unchanged-summary-line-info-basic',
      'stream-monaco-unchanged-summary-metadata',
      'stream-monaco-unchanged-summary-simple',
    )
    summary.classList.add(
      `stream-monaco-unchanged-summary-${unchangedRegionStyle}`,
    )
    const summaryLabel = metadataLabel || countText
    const summaryInteractive
      = unchangedRegionStyle === 'line-info'
        || unchangedRegionStyle === 'line-info-basic'
    summary.disabled = !summaryInteractive
    summary.tabIndex = summaryInteractive ? 0 : -1
    if (summaryInteractive) {
      summary.removeAttribute('aria-hidden')
      summary.setAttribute(
        'aria-label',
        `${summaryLabel}. Expand all unmodified lines`,
      )
      summary.title = 'Expand all unmodified lines'
    }
    else if (unchangedRegionStyle === 'simple') {
      summary.setAttribute('aria-hidden', 'true')
      summary.removeAttribute('aria-label')
      summary.title = ''
    }
    else {
      summary.removeAttribute('aria-hidden')
      summary.removeAttribute('aria-label')
      summary.title = ''
    }
    this.updateDiffUnchangedBridgeMeta(
      entry,
      unchangedRegionStyle,
      summaryLabel,
    )

    if (
      unchangedRegionStyle === 'line-info'
      || unchangedRegionStyle === 'line-info-basic'
    ) {
      this.syncDiffUnchangedBridgeRail(
        entry,
        showTopHandle,
        topHandle ?? null,
        showBottomHandle,
        bottomHandle ?? null,
      )
      if (entry.rail && entry.rail.parentElement !== bridge) {
        bridge.prepend(entry.rail)
      }
    }
    else if (entry.rail) {
      entry.rail.hidden = true
      entry.rail.setAttribute('aria-hidden', 'true')
    }

    entry.activate = () => {
      const action
        = primaryNode.querySelector<HTMLElement>('a, button')
          ?? secondaryNode.querySelector<HTMLElement>('a, button')
      if (action instanceof HTMLElement) {
        action.click()
        this.scheduleCapturePersistedDiffUnchangedState(1)
      }
    }

    if (summary.parentElement !== bridge)
      bridge.append(summary)
    if (divider.parentElement !== bridge)
      bridge.append(divider)
    if (bridge.parentElement !== overlay)
      overlay.append(bridge)

    return key
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
    this.createDomDisposable(
      this.diffUnchangedRegionDisposables,
      node,
      'keydown',
      (event) => {
        const keyboardEvent = event as KeyboardEvent
        if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ')
          return
        keyboardEvent.preventDefault()
        this.dispatchSyntheticMouseDown(node)
        this.scheduleCapturePersistedDiffUnchangedState(1)
      },
    )
  }

  private scanAndPatchDiffUnchangedRegions() {
    if (!this.lastContainer)
      return
    this.applyDiffRootAppearanceClass()
    const viewZoneHeightsChanged = this.syncDiffUnchangedViewZoneHeights()

    const centers = this.lastContainer.querySelectorAll<HTMLElement>(
      '.diff-hidden-lines .center',
    )
    Array.from(centers)
      .sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )
      .forEach((node, index) => this.patchDiffUnchangedCenter(node, index))
    const partialRevealHandles
      = this.lastContainer.querySelectorAll<HTMLElement>(
        '.diff-hidden-lines .top, .diff-hidden-lines .bottom',
      )
    partialRevealHandles.forEach((node) => {
      node.removeAttribute('title')
      node.removeAttribute('aria-label')
      node.removeAttribute('role')
      node.removeAttribute('tabindex')
    })
    this.clearDiffUnchangedBridgeSources()

    const secondaryCenters = Array.from(centers)
      .filter(node =>
        node.classList.contains('stream-monaco-unchanged-merged-secondary'),
      )
      .sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )
    const primaryCenters = Array.from(centers)
      .filter(node =>
        node.classList.contains('stream-monaco-unchanged-merged-primary'),
      )
      .sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )

    const pairCount = Math.min(secondaryCenters.length, primaryCenters.length)
    const visibleKeys = new Set<string>()
    for (let i = 0; i < pairCount; i++) {
      const secondaryNode = secondaryCenters[i]
      const primaryNode = primaryCenters[i]
      const topDelta = Math.abs(
        secondaryNode.getBoundingClientRect().top
        - primaryNode.getBoundingClientRect().top,
      )
      if (topDelta > 6)
        continue
      const key = this.renderMergedDiffUnchangedBridge(
        secondaryNode,
        primaryNode,
        i,
        pairCount,
      )
      if (key)
        visibleKeys.add(key)
    }
    this.pruneDiffUnchangedBridgeEntries(visibleKeys)
    this.syncDiffUnchangedOverlayScrollBaseline()

    const foldGlyphs
      = this.lastContainer.querySelectorAll<HTMLElement>('.fold-unchanged')
    foldGlyphs.forEach(node => this.patchDiffUnchangedFoldGlyph(node))

    if (viewZoneHeightsChanged)
      this.schedulePatchDiffUnchangedRegions()
  }

  private schedulePatchDiffUnchangedRegions() {
    this.rafScheduler.schedule('patch-diff-unchanged-regions', () => {
      this.scanAndPatchDiffUnchangedRegions()
    })
  }

  private schedulePatchDiffUnchangedRegionsAfterScroll() {
    this.applyDiffUnchangedOverlayScrollCompensation()
    this.schedulePatchDiffUnchangedRegions()
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
    this.applyDiffRootAppearanceClass()
    this.schedulePatchDiffUnchangedRegions()

    if (typeof MutationObserver !== 'undefined') {
      this.diffUnchangedRegionObserver = new MutationObserver((mutations) => {
        const shouldRepatch = mutations.some((mutation) => {
          const target
            = mutation.target instanceof HTMLElement ? mutation.target : null
          if (target?.closest('.stream-monaco-diff-unchanged-overlay'))
            return false
          const changedNodes = Array.from(mutation.addedNodes).concat(
            Array.from(mutation.removedNodes),
          )
          if (
            changedNodes.length > 0
            && changedNodes.every((node) => {
              return (
                node instanceof HTMLElement
                && node.classList.contains('stream-monaco-diff-unchanged-overlay')
              )
            })
          ) {
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
    const repatch = () => {
      this.applyDiffRootAppearanceClass()
      this.schedulePatchDiffUnchangedRegions()
    }
    this.diffUnchangedRegionDisposables.push(
      this.diffEditorView.onDidUpdateDiff(() => {
        repatch()
        this.scheduleRestorePersistedDiffUnchangedState()
      }),
    )
    this.diffUnchangedRegionDisposables.push(
      originalEditor.onDidLayoutChange(repatch),
    )
    this.diffUnchangedRegionDisposables.push(
      modifiedEditor.onDidLayoutChange(repatch),
    )
    this.diffUnchangedRegionDisposables.push(
      originalEditor.onDidScrollChange(() =>
        this.schedulePatchDiffUnchangedRegionsAfterScroll(),
      ),
    )
    this.diffUnchangedRegionDisposables.push(
      modifiedEditor.onDidScrollChange(() =>
        this.schedulePatchDiffUnchangedRegionsAfterScroll(),
      ),
    )
    this.createDomDisposable(
      this.diffUnchangedRegionDisposables,
      this.lastContainer,
      'scroll',
      () => this.schedulePatchDiffUnchangedRegionsAfterScroll(),
    )
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
      this.diffHunkDisposables.push(
        editor.onMouseMove((event) => {
          this.handleDiffHunkMouseMove(side, event)
        }),
      )
      this.diffHunkDisposables.push(
        editor.onMouseLeave(() => this.scheduleHideDiffHunkActions()),
      )
      this.diffHunkDisposables.push(
        editor.onDidScrollChange(() => this.repositionDiffHunkNodes()),
      )
      this.diffHunkDisposables.push(
        editor.onDidLayoutChange(() => {
          this.applyDiffRootAppearanceClass()
          this.repositionDiffHunkNodes()
        }),
      )
    }
    bindHover(originalEditor, 'original')
    bindHover(modifiedEditor, 'modified')

    this.diffHunkDisposables.push(
      this.diffEditorView.onDidUpdateDiff(() => {
        this.applyDiffRootAppearanceClass()
        this.diffHunkLineChanges = this.getEffectiveLineChanges()
        if (this.diffHunkActiveChange)
          this.hideDiffHunkActions()
      }),
    )
    this.diffHunkLineChanges = this.getEffectiveLineChanges()
  }

  private cancelScheduledHideDiffHunkActions() {
    if (this.diffHunkHideTimer != null) {
      clearTimeout(this.diffHunkHideTimer)
      this.diffHunkHideTimer = null
    }
  }

  private scheduleHideDiffHunkActions(
    delayMs = this.options.diffHunkHoverHideDelayMs ?? 160,
  ) {
    this.cancelScheduledHideDiffHunkActions()
    this.diffHunkHideTimer = setTimeout(() => {
      this.diffHunkHideTimer = null
      this.hideDiffHunkActions()
    }, delayMs) as unknown as number
  }

  private hideDiffHunkActions() {
    this.diffHunkActiveChange = null
    this.diffHunkActiveHoverSide = null
    if (this.diffHunkUpperNode)
      this.diffHunkUpperNode.style.display = 'none'
    if (this.diffHunkLowerNode)
      this.diffHunkLowerNode.style.display = 'none'
  }

  private inferInlineDiffHunkHoverSide(
    change: monaco.editor.ILineChange,
    event: monaco.editor.IEditorMouseEvent,
  ): DiffHunkSide {
    const targetElement
      = event.target.element instanceof HTMLElement ? event.target.element : null
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
    if (!this.hasModifiedLines(change))
      return 'upper'
    if (!this.hasOriginalLines(change))
      return 'lower'
    const hoverLine = event.target.position?.lineNumber ?? 0
    const modifiedAnchor = Math.max(
      1,
      change.modifiedStartLineNumber || change.modifiedEndLineNumber || 1,
    )
    return hoverLine < modifiedAnchor ? 'upper' : 'lower'
  }

  private hasOriginalLines(change: monaco.editor.ILineChange) {
    return (
      change.originalStartLineNumber > 0
      && change.originalEndLineNumber >= change.originalStartLineNumber
    )
  }

  private hasModifiedLines(change: monaco.editor.ILineChange) {
    return (
      change.modifiedStartLineNumber > 0
      && change.modifiedEndLineNumber >= change.modifiedStartLineNumber
    )
  }

  private distanceToLineChange(
    side: DiffEditorSide,
    change: monaco.editor.ILineChange,
    line: number,
  ) {
    const hasRange
      = side === 'original'
        ? this.hasOriginalLines(change)
        : this.hasModifiedLines(change)
    const start
      = side === 'original'
        ? change.originalStartLineNumber
        : change.modifiedStartLineNumber
    const end
      = side === 'original'
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

  private findLineChangeByHoverLine(side: DiffEditorSide, line: number) {
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
    this.diffHunkActiveHoverSide = this.isDiffInlineMode()
      ? this.inferInlineDiffHunkHoverSide(change, event)
      : null
    this.repositionDiffHunkNodes()
  }

  private isOriginalEditorCollapsed() {
    if (!this.diffEditorView)
      return true
    const info = this.diffEditorView.getOriginalEditor().getLayoutInfo?.()
    return !info || info.width < 24
  }

  private isDiffInlineMode() {
    const diffRoot = this.lastContainer?.querySelector('.monaco-diff-editor')
    if (diffRoot instanceof HTMLElement)
      return !diffRoot.classList.contains('side-by-side')
    return this.isOriginalEditorCollapsed()
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

  private applyDiffModelLanguage(
    models: DiffModelPair,
    codeLanguage?: MonacoLanguage,
  ) {
    if (!codeLanguage)
      return
    const lang = processedLanguage(codeLanguage)
    if (!lang)
      return
    if (models.original.getLanguageId() !== lang)
      monaco.editor.setModelLanguage(models.original, lang)
    if (models.modified.getLanguageId() !== lang)
      monaco.editor.setModelLanguage(models.modified, lang)
  }

  private restoreDiffViewState(
    viewState: monaco.editor.IDiffEditorViewState | null,
  ) {
    if (!this.diffEditorView || !viewState)
      return
    const restore = () => {
      try {
        this.diffEditorView?.restoreViewState(viewState)
      }
      catch {}
    }
    restore()
    requestAnimationFrame(restore)
  }

  private disposePreviousDiffModel(
    model: monaco.editor.ITextModel | null,
    owned: boolean,
    nextModel: monaco.editor.ITextModel,
  ) {
    if (!model || !owned || model === nextModel)
      return
    model.dispose()
  }

  private disposePendingPreparedDiffViewModel() {
    if (!this.pendingPreparedDiffViewModel)
      return
    try {
      this.pendingPreparedDiffViewModel.dispose()
    }
    catch {}
    this.pendingPreparedDiffViewModel = null
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
    this.cachedScrollHeightDiff
      = this.diffEditorView?.getModifiedEditor().getScrollHeight?.()
        ?? this.cachedScrollHeightDiff
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
      const range = hasModified
        ? this.getInsertRangeBeforeLine(
            this.modifiedModel,
            lineChange.modifiedStartLineNumber,
          )
        : this.getInsertRangeAfterLine(
            this.modifiedModel,
            Math.max(
              0,
              lineChange.modifiedStartLineNumber
              || lineChange.modifiedEndLineNumber,
            ),
          )
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
      this.modifiedModel.applyEdits([
        { range, text: '', forceMoveMarkers: true },
      ])
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
      this.originalModel.applyEdits([
        { range, text: '', forceMoveMarkers: true },
      ])
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
        : Math.max(0, lineChange.originalStartLineNumber)
      const range = this.getInsertRangeAfterLine(this.originalModel, anchor)
      this.originalModel.applyEdits([{ range, text, forceMoveMarkers: true }])
    }
  }

  private async applyDiffHunkAction(
    side: DiffHunkSide,
    action: DiffHunkActionKind,
  ) {
    if (
      !this.diffHunkActiveChange
      || !this.originalModel
      || !this.modifiedModel
    ) {
      return
    }
    if (this.diffHunkActionInFlight)
      return

    this.diffHunkActionInFlight = true
    this.setDiffHunkNodeEnabled(this.diffHunkUpperNode, false)
    this.setDiffHunkNodeEnabled(this.diffHunkLowerNode, false)

    try {
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
          allowDefault = (await this.options.onDiffHunkAction(context)) !== false
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
    finally {
      this.diffHunkActionInFlight = false
    }
  }

  private setDiffHunkNodeEnabled(
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
    const rawTop
      = editor.getTopForLineNumber(line) - (editor.getScrollTop?.() ?? 0)
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
    const nodeWidth = node.offsetWidth || 130
    const nodeHeight = node.offsetHeight || 30
    const left
      = host.offsetLeft + Math.max(6, host.clientWidth - nodeWidth - 10)
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
    node.style.transform = `translate(${Math.round(left)}px, ${Math.round(
      top,
    )}px)`
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

    const inlineMode = this.isDiffInlineMode()
    if (inlineMode) {
      const inlineHoverSide
        = this.diffHunkActiveHoverSide
          ?? (hasOriginal && !hasModified ? 'upper' : 'lower')
      if (inlineHoverSide === 'upper' && hasOriginal) {
        const upperAnchor = Math.max(
          1,
          change.modifiedStartLineNumber - 1
          || change.modifiedEndLineNumber
          || 1,
        )
        this.positionDiffHunkNode(
          this.diffHunkUpperNode,
          'modified',
          upperAnchor,
        )
        this.diffHunkLowerNode.style.display = 'none'
        return
      }
      if (hasModified) {
        const lowerAnchor = Math.max(
          1,
          change.modifiedStartLineNumber || change.modifiedEndLineNumber || 1,
        )
        this.positionDiffHunkNode(
          this.diffHunkLowerNode,
          'modified',
          lowerAnchor,
        )
        this.diffHunkUpperNode.style.display = 'none'
        return
      }
      this.hideDiffHunkActions()
      return
    }

    if (hasOriginal) {
      const upperSide: DiffEditorSide = 'original'
      const upperAnchor = change.originalStartLineNumber
      this.positionDiffHunkNode(this.diffHunkUpperNode, upperSide, upperAnchor)
    }
    else {
      this.diffHunkUpperNode.style.display = 'none'
    }

    if (hasModified) {
      const lowerAnchor = change.modifiedStartLineNumber
      this.positionDiffHunkNode(this.diffHunkLowerNode, 'modified', lowerAnchor)
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
      this.rafScheduler.schedule('appendDiff', () =>
        this.flushAppendBufferDiff())
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
    this.appendFlushThrottleTimerDiff = setTimeout(() => {
      this.appendFlushThrottleTimerDiff = null
      schedule()
    }, wait) as unknown as number
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
    const lineHeight = modifiedEditor.getOption(
      monaco.editor.EditorOption.lineHeight,
    )
    const oCount = originalEditor.getModel()?.getLineCount() ?? 1
    const mCount = modifiedEditor.getModel()?.getLineCount() ?? 1
    const lineCount = Math.max(oCount, mCount)
    const fromLines = lineCount * lineHeight + padding
    // prefer rendered scrollHeight when available (covers view zones, inline diffs, wrapping)
    const scrollH = Math.max(
      originalEditor.getScrollHeight?.() ?? 0,
      modifiedEditor.getScrollHeight?.() ?? 0,
    )
    const desired = Math.max(fromLines, scrollH)
    return Math.min(desired, this.maxHeightValue)
  }

  private isOverflowAutoDiff() {
    if (!this.lastContainer)
      return false
    return this.computedHeight() >= this.maxHeightValue - 1
  }

  private shouldPerformImmediateRevealDiff() {
    return (
      this.autoScrollOnUpdate
      && this.shouldAutoScrollDiff
      && !this.diffHideUnchangedRegionsDeferred
      && this.hasVerticalScrollbarModified()
      && this.isOverflowAutoDiff()
    )
  }

  private suppressScrollWatcherDiff(ms: number) {
    if (
      !this.diffScrollWatcher
      || typeof (this.diffScrollWatcher as any).setSuppressed !== 'function'
    ) {
      return
    }
    // clear existing timer
    if (this.diffScrollWatcherSuppressionTimer != null) {
      clearTimeout(this.diffScrollWatcherSuppressionTimer)
      this.diffScrollWatcherSuppressionTimer = null
    }
    ;(this.diffScrollWatcher as any).setSuppressed(true)
    this.diffScrollWatcherSuppressionTimer = setTimeout(() => {
      try {
        ;(this.diffScrollWatcher as any).setSuppressed(false)
      }
      catch {}
      this.diffScrollWatcherSuppressionTimer = null
    }, ms) as unknown as number
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
    return (this._hasScrollBar
      = m.scrollHeight > m.computedHeight + Math.max(padding / 2, epsilon))
  }

  private userIsNearBottomDiff(): boolean {
    if (!this.diffEditorView)
      return true
    const m = this.measureViewportDiff()
    if (!m || !m.li)
      return true
    const lineThreshold = (this.autoScrollThresholdLines ?? 0) * m.lineHeight
    const threshold = Math.max(
      lineThreshold || 0,
      this.autoScrollThresholdPx || 0,
    )
    const distance = m.scrollHeight - (m.scrollTop + m.li.height)
    return distance <= threshold
  }

  private maybeScrollDiffToBottom(
    targetLine?: number,
    prevLineOverride?: number,
  ) {
    // Defer measurement and reveal work to RAF to avoid forcing sync layout during hot paths
    this.rafScheduler.schedule('maybe-scroll-diff', () => {
      log('diff', 'maybeScrollDiffToBottom called', {
        targetLine,
        prevLineOverride,
        diffAutoScroll: this.diffAutoScroll,
        autoScrollOnUpdate: this.autoScrollOnUpdate,
        shouldAutoScrollDiff: this.shouldAutoScrollDiff,
      })
      if (!this.diffEditorView)
        return
      const hasV = this.hasVerticalScrollbarModified()
      log('diff', 'hasVerticalScrollbarModified ->', hasV)
      if (
        !(
          this.diffAutoScroll
          && this.autoScrollOnUpdate
          && this.shouldAutoScrollDiff
          && hasV
        )
      ) {
        return
      }
      const me = this.diffEditorView.getModifiedEditor()
      const model = me.getModel()
      const currentLine = model?.getLineCount() ?? 1
      const line = targetLine ?? currentLine

      const prevLine
        = typeof prevLineOverride === 'number'
          ? prevLineOverride
          : this.lastKnownModifiedLineCount ?? -1
      log('diff', 'scroll metrics', {
        prevLine,
        currentLine,
        line,
        lastRevealLineDiff: this.lastRevealLineDiff,
      })
      if (prevLine !== -1 && prevLine === currentLine && line === currentLine)
        return

      if (this.lastRevealLineDiff !== null && this.lastRevealLineDiff === line)
        return

      const batchMs
        = this.revealBatchOnIdleMsOption
          ?? this.options.revealBatchOnIdleMs
          ?? defaultRevealBatchOnIdleMs
      log('diff', 'reveal timing', {
        batchMs,
        revealDebounceMs: this.revealDebounceMs,
        revealDebounceMsOption: this.revealDebounceMsOption,
      })
      if (typeof batchMs === 'number' && batchMs > 0) {
        // If a vertical scrollbar is present, don't wait for the idle batch
        // timer — reveal immediately (ticketed) so continuous streaming
        // keeps the viewport following new content.
        if (hasV) {
          const ticket = ++this.revealTicketDiff
          log('diff', 'has scrollbar -> immediate ticketed reveal', {
            ticket,
            line,
          })
          this.performRevealDiffTicketed(line, ticket)
          return
        }
        if (this.revealIdleTimerIdDiff != null) {
          clearTimeout(this.revealIdleTimerIdDiff)
        }
        const ticket = ++this.revealTicketDiff
        log('diff', 'scheduling idle reveal', { ticket, batchMs, line })
        this.revealIdleTimerIdDiff = setTimeout(() => {
          this.revealIdleTimerIdDiff = null
          this.performRevealDiffTicketed(line, ticket)
        }, batchMs) as unknown as number
        return
      }

      if (this.revealDebounceIdDiff != null) {
        clearTimeout(this.revealDebounceIdDiff)
        this.revealDebounceIdDiff = null
      }
      const ms
        = typeof this.revealDebounceMs === 'number' && this.revealDebounceMs > 0
          ? this.revealDebounceMs
          : typeof this.revealDebounceMsOption === 'number'
            && this.revealDebounceMsOption > 0
            ? this.revealDebounceMsOption
            : this.revealDebounceMs
      this.revealDebounceIdDiff = setTimeout(() => {
        this.revealDebounceIdDiff = null
        const ticket = ++this.revealTicketDiff
        log('diff', 'debounced reveal firing', { ticket, line })
        this.performRevealDiffTicketed(line, ticket)
      }, ms) as unknown as number

      this.lastKnownModifiedLineCount = currentLine
    })
  }

  private performRevealDiffTicketed(line: number, ticket: number) {
    this.rafScheduler.schedule('revealDiff', () => {
      // Temporarily suppress scroll watcher to avoid misinterpreting programmatic scroll
      if (this.diffScrollWatcher) {
        log('diff', 'performRevealDiffTicketed - suppressing watcher', {
          ticket,
          line,
          ms: this.scrollWatcherSuppressionMs,
        })
        this.suppressScrollWatcherDiff(this.scrollWatcherSuppressionMs)
      }
      if (ticket !== this.revealTicketDiff)
        return
      log('diff', 'performRevealDiffTicketed - performing reveal', {
        ticket,
        line,
      })
      const strategy = this.diffHideUnchangedRegionsDeferred
        ? 'bottom'
        : this.revealStrategyOption
          ?? this.options.revealStrategy
          ?? 'centerIfOutside'
      const ScrollType: any
        = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
      const smooth
        = !this.diffHideUnchangedRegionsDeferred
          && ScrollType
          && typeof ScrollType.Smooth !== 'undefined'
          ? ScrollType.Smooth
          : undefined
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
        catch {}
      }
      this.lastRevealLineDiff = line
      log('diff', 'performRevealDiffTicketed - revealed', {
        line,
        lastRevealLineDiff: this.lastRevealLineDiff,
      })
      try {
        this.lastScrollTopDiff
          = this.diffEditorView?.getModifiedEditor().getScrollTop?.()
            ?? this.lastScrollTopDiff
      }
      catch {}
    })
  }

  private performImmediateRevealDiff(line: number, ticket: number) {
    if (!this.diffEditorView)
      return
    if (ticket !== this.revealTicketDiff)
      return
    const ScrollType: any
      = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
    const immediate
      = ScrollType && typeof ScrollType.Immediate !== 'undefined'
        ? ScrollType.Immediate
        : undefined
    const me = this.diffEditorView.getModifiedEditor()
    if (typeof immediate !== 'undefined')
      me.revealLine(line, immediate)
    else me.revealLine(line)
    this.measureViewportDiff()
    log('diff', 'performImmediateRevealDiff', { line, ticket })
  }

  private scheduleImmediateRevealAfterLayoutDiff(line: number) {
    const ticket = ++this.revealTicketDiff
    this.rafScheduler.schedule('immediate-reveal-diff', async () => {
      const target
        = this.diffEditorView && this.diffHeightManager
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
      const start
        = typeof performance !== 'undefined' && performance.now
          ? performance.now()
          : Date.now()
      const check = () => {
        const applied = this.lastContainer
          ? Number.parseFloat(
            (this.lastContainer.style.height || '').replace('px', ''),
          ) || 0
          : -1
        if (applied >= target - 1) {
          resolve()
          return
        }
        if (
          (typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : Date.now())
          - start
          > timeoutMs
        ) {
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

    // Keep the host clipped and let Monaco's own scrollable layers own
    // vertical scrolling. Allowing the outer host to become scrollable can
    // cause overlay widgets to intercept wheel input and drift visually.
    container.style.overflow = 'hidden'
    container.style.maxHeight = this.maxHeightCSS

    const lang = processedLanguage(language) || language
    this.originalModel = monaco.editor.createModel(originalCode, lang)
    this.modifiedModel = monaco.editor.createModel(modifiedCode, lang)
    this.originalModelOwned = true
    this.modifiedModelOwned = true
    const hideUnchangedRegions = this.resolveDiffHideUnchangedRegionsOption()
    this.diffHideUnchangedRegionsResolved = hideUnchangedRegions
    this.diffHideUnchangedRegionsDeferred = false

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

    this.diffEditorView.setModel({
      original: this.originalModel,
      modified: this.modifiedModel,
    })

    this.lastKnownOriginalCode = originalCode
    this.lastKnownModifiedCode = modifiedCode

    // When unchanged-region folding is enabled, Monaco often needs a slightly
    // longer quiet window to finish intermediate diff computations. Without
    // that, collapsed unchanged regions can appear only after streaming ends.
    this.diffUpdateThrottleMs = this.resolveDiffStreamingThrottleMs()

    this.shouldAutoScrollDiff = !!(
      this.autoScrollInitial && this.diffAutoScroll
    )
    if (this.diffScrollWatcher) {
      this.diffScrollWatcher.dispose()
      this.diffScrollWatcher = null
    }
    if (this.diffAutoScroll) {
      const me = this.diffEditorView.getModifiedEditor()
      this.diffScrollWatcher = createScrollWatcherForEditor(me, {
        onPause: () => {
          this.shouldAutoScrollDiff = false
        },
        onMaybeResume: () => {
          this.rafScheduler.schedule('maybe-resume-diff', () => {
            this.shouldAutoScrollDiff = this.userIsNearBottomDiff()
          })
        },
        getLast: () => this.lastScrollTopDiff,
        setLast: (v: number) => {
          this.lastScrollTopDiff = v
        },
      })
    }
    log('diff', 'createDiffEditor', {
      autoScrollInitial: this.autoScrollInitial,
      diffAutoScroll: this.diffAutoScroll,
    })

    // Compute and apply the editor's height (with internal hysteresis to
    // avoid tiny changes). Provide a small minimum visible height so the
    // editor doesn't collapse to a single line while content is streaming.
    const MIN_VISIBLE_HEIGHT = Math.min(120, this.maxHeightValue)
    container.style.minHeight = `${MIN_VISIBLE_HEIGHT}px`

    if (this.diffHeightManager) {
      this.diffHeightManager.dispose()
      this.diffHeightManager = null
    }
    this.diffHeightManager = createHeightManager(container, () =>
      this.computedHeight())
    this.diffHeightManager.update()

    // If the initial computed height already reaches (or is very near) the
    // configured max height, apply it immediately so Monaco can start
    // rendering with the final clipped viewport height.
    const initialComputed = this.computedHeight()
    if (initialComputed >= this.maxHeightValue - 1) {
      container.style.height = `${this.maxHeightValue}px`
    }

    const me = this.diffEditorView.getModifiedEditor()
    this.cachedScrollHeightDiff = me.getScrollHeight?.() ?? null
    this.cachedLineHeightDiff
      = me.getOption?.(monaco.editor.EditorOption.lineHeight) ?? null
    this.cachedComputedHeightDiff = this.computedHeight()

    const oEditor = this.diffEditorView.getOriginalEditor()
    const mEditor = this.diffEditorView.getModifiedEditor()
    this.disposeDiffPresentationTracking()
    this.diffComputedVersions = null
    this.diffPresentationDisposables.push(
      this.diffEditorView.onDidUpdateDiff(() => {
        this.diffComputedVersions = this.captureCurrentDiffVersions()
        this.scheduleSyncDiffPresentationDecorations()
      }),
    )
    this.diffPresentationDisposables.push(
      oEditor.onDidChangeModelContent(() => {
        this.scheduleSyncDiffPresentationDecorations()
      }),
    )
    this.diffPresentationDisposables.push(
      mEditor.onDidChangeModelContent(() => {
        this.scheduleSyncDiffPresentationDecorations()
      }),
    )
    oEditor.onDidContentSizeChange?.(() => {
      this._hasScrollBar = false
      this.rafScheduler.schedule('content-size-change-diff', () => {
        this.cachedScrollHeightDiff
          = oEditor.getScrollHeight?.() ?? this.cachedScrollHeightDiff
        this.cachedLineHeightDiff
          = oEditor.getOption?.(monaco.editor.EditorOption.lineHeight)
            ?? this.cachedLineHeightDiff
        this.cachedComputedHeightDiff = this.computedHeight()
        if (this.diffHeightManager?.isSuppressed())
          return
        this.diffHeightManager?.update()
        const computed = this.computedHeight()
        if (this.lastContainer) {
          this.lastContainer.style.overflow = 'hidden'
          if (
            computed >= this.maxHeightValue - 1
            && this.shouldAutoScrollDiff
            && !this.diffHideUnchangedRegionsDeferred
          ) {
            this.maybeScrollDiffToBottom(this.modifiedModel?.getLineCount())
          }
        }
      })
    })
    mEditor.onDidContentSizeChange?.(() => {
      this._hasScrollBar = false
      this.rafScheduler.schedule('content-size-change-diff', () => {
        this.cachedScrollHeightDiff
          = mEditor.getScrollHeight?.() ?? this.cachedScrollHeightDiff
        this.cachedLineHeightDiff
          = mEditor.getOption?.(monaco.editor.EditorOption.lineHeight)
            ?? this.cachedLineHeightDiff
        this.cachedComputedHeightDiff = this.computedHeight()
        if (this.diffHeightManager?.isSuppressed())
          return
        this.diffHeightManager?.update()
        const computed = this.computedHeight()
        if (this.lastContainer) {
          this.lastContainer.style.overflow = 'hidden'
          if (
            computed >= this.maxHeightValue - 1
            && this.shouldAutoScrollDiff
            && !this.diffHideUnchangedRegionsDeferred
          ) {
            this.maybeScrollDiffToBottom(this.modifiedModel?.getLineCount())
          }
        }
      })
    })

    // defer getValue reads for modified model to once-per-frame
    mEditor.onDidChangeModelContent(() => {
      this.lastKnownModifiedDirty = true
      this.rafScheduler.schedule('sync-last-known-modified', () =>
        this.syncLastKnownModified())
    })

    this.maybeScrollDiffToBottom(
      this.modifiedModel.getLineCount(),
      this.lastKnownModifiedLineCount ?? undefined,
    )
    this.setupDiffUnchangedRegionEnhancements()
    this.setupDiffHunkInteractions()
    this.applyDiffRootAppearanceClass()
    this.scheduleSyncDiffPresentationDecorations()

    return this.diffEditorView
  }

  updateDiff(
    originalCode: string,
    modifiedCode: string,
    codeLanguage?: string,
  ) {
    if (!this.diffEditorView || !this.originalModel || !this.modifiedModel)
      return

    const plang = codeLanguage ? processedLanguage(codeLanguage) : undefined
    if (
      plang
      && (this.originalModel.getLanguageId() !== plang
        || this.modifiedModel.getLanguageId() !== plang)
    ) {
      this.pendingDiffUpdate = {
        original: originalCode,
        modified: modifiedCode,
        lang: codeLanguage,
      }
      this.rafScheduler.schedule('diff', () => this.flushPendingDiffUpdate())
      return
    }

    if (this.lastKnownOriginalCode == null)
      this.lastKnownOriginalCode = this.originalModel.getValue()
    if (this.lastKnownModifiedCode == null)
      this.lastKnownModifiedCode = this.modifiedModel.getValue()

    const prevO = this.lastKnownOriginalCode!
    const prevM = this.lastKnownModifiedCode!
    if (originalCode !== prevO || modifiedCode !== prevM) {
      this.markDiffStreamingActivity()
    }
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

    if (
      originalCode !== this.lastKnownOriginalCode
      || modifiedCode !== this.lastKnownModifiedCode
    ) {
      this.pendingDiffUpdate = {
        original: originalCode,
        modified: modifiedCode,
      }
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
    this.markDiffStreamingActivity()
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
    this.markDiffStreamingActivity()
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
          this.lastContainer.style.overflow = 'hidden'
        }
        if (shouldImmediate) {
          this.scheduleImmediateRevealAfterLayoutDiff(newLine)
        }
        else {
          this.maybeScrollDiffToBottom(newLine, prevLine)
        }
      }
    }
    this.lastKnownModifiedCode = newCode
  }

  appendOriginal(appendText: string, codeLanguage?: string) {
    if (!this.diffEditorView || !this.originalModel || !appendText)
      return
    this.markDiffStreamingActivity()
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
    this.markDiffStreamingActivity()
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
      console.warn(
        `Language "${language}" is not registered. Available languages: ${languages.join(
          ', ',
        )}`,
      )
      return
    }
    if (this.originalModel && this.originalModel.getLanguageId() !== language)
      monaco.editor.setModelLanguage(this.originalModel, language)
    if (this.modifiedModel && this.modifiedModel.getLanguageId() !== language)
      monaco.editor.setModelLanguage(this.modifiedModel, language)
  }

  async setDiffModels(
    models: DiffModelPair,
    options: DiffModelTransitionOptions = {},
  ) {
    if (!this.diffEditorView)
      return

    const transitionRequestId = ++this.diffModelTransitionRequestId
    this.disposePendingPreparedDiffViewModel()

    const nextOriginal = models.original
    const nextModified = models.modified
    this.applyDiffModelLanguage(models, options.codeLanguage)

    const currentOriginalValue
      = this.lastKnownOriginalCode ?? this.originalModel?.getValue() ?? null
    const currentModifiedValue
      = this.lastKnownModifiedCode ?? this.modifiedModel?.getValue() ?? null
    const nextOriginalValue = nextOriginal.getValue()
    const nextModifiedValue = nextModified.getValue()
    const sameContent
      = currentOriginalValue === nextOriginalValue
        && currentModifiedValue === nextModifiedValue
    const preserveViewState = options.preserveViewState ?? sameContent
    let preparedViewModel: monaco.editor.IDiffEditorViewModel | null = null

    if (preserveViewState && sameContent) {
      try {
        preparedViewModel = this.diffEditorView.createViewModel({
          original: nextOriginal,
          modified: nextModified,
        })
        this.pendingPreparedDiffViewModel = preparedViewModel
        await preparedViewModel.waitForDiff()
      }
      catch {
        if (preparedViewModel === this.pendingPreparedDiffViewModel)
          this.pendingPreparedDiffViewModel = null
        try {
          preparedViewModel?.dispose()
        }
        catch {}
        preparedViewModel = null
      }
    }

    if (preparedViewModel === this.pendingPreparedDiffViewModel)
      this.pendingPreparedDiffViewModel = null

    if (
      !this.diffEditorView
      || this.diffModelTransitionRequestId !== transitionRequestId
    ) {
      if (preparedViewModel) {
        try {
          preparedViewModel.dispose()
        }
        catch {}
      }
      return
    }

    const nextModelTarget:
      | monaco.editor.IDiffEditorModel
      | monaco.editor.IDiffEditorViewModel = preparedViewModel ?? {
        original: nextOriginal,
        modified: nextModified,
      }

    if (!this.originalModel || !this.modifiedModel) {
      this.diffEditorView.setModel(nextModelTarget)
      this.originalModel = nextOriginal
      this.modifiedModel = nextModified
      this.originalModelOwned = false
      this.modifiedModelOwned = false
      this.syncDiffKnownValues()
      this.refreshDiffPresentation()
      return
    }

    this.rafScheduler.cancel('diff')
    this.pendingDiffUpdate = null
    this.flushOriginalAppendBufferSync()
    this.flushModifiedAppendBufferSync()

    const currentOriginal = this.originalModel
    const currentModified = this.modifiedModel
    const shouldRestorePersistedUnchangedState
      = preserveViewState && !sameContent
    const preservedScrollPosition = preserveViewState
      ? this.captureDiffScrollPosition()
      : null
    const preservedViewportAnchor
      = preserveViewState && sameContent
        ? this.captureModifiedViewportAnchor()
        : null
    const viewState = preserveViewState
      ? this.diffEditorView.saveViewState()
      : null

    this.queuePendingDiffScrollRestore(
      preservedScrollPosition,
      shouldRestorePersistedUnchangedState ? 2 : 0,
    )
    if (shouldRestorePersistedUnchangedState)
      this.capturePersistedDiffUnchangedState()

    const applyModelSwap = () => {
      this.diffEditorView?.setModel(nextModelTarget)
    }

    if (preserveViewState)
      this.withLockedDiffScrollPosition(applyModelSwap)
    else applyModelSwap()

    const previousOriginalOwned = this.originalModelOwned
    const previousModifiedOwned = this.modifiedModelOwned
    this.originalModel = nextOriginal
    this.modifiedModel = nextModified
    this.originalModelOwned = false
    this.modifiedModelOwned = false
    this.lastKnownOriginalCode = nextOriginalValue
    this.lastKnownModifiedCode = nextModifiedValue
    this.lastKnownModifiedLineCount = nextModified.getLineCount()
    this.lastKnownModifiedDirty = false
    this._hasScrollBar = false
    this.cachedScrollHeightDiff
      = this.diffEditorView.getModifiedEditor().getScrollHeight?.() ?? null
    this.cachedLineHeightDiff
      = this.diffEditorView
        .getModifiedEditor()
        .getOption?.(monaco.editor.EditorOption.lineHeight) ?? null
    this.cachedComputedHeightDiff = this.computedHeight()
    this.diffHunkLineChanges = this.getEffectiveLineChanges()
    this.hideDiffHunkActions()
    this.clearDiffUnchangedBridgeOverlay(false)
    this.syncDiffUnchangedViewZoneHeights()
    this.diffComputedVersions = null

    if (viewState)
      this.restoreDiffViewState(viewState)

    this.refreshDiffPresentation()
    this.scheduleSyncDiffPresentationDecorations()
    if (shouldRestorePersistedUnchangedState)
      this.scheduleRestorePersistedDiffUnchangedState()
    this.applyPendingDiffScrollRestore()
    if (preservedViewportAnchor)
      this.scheduleRestoreModifiedViewportAnchor(preservedViewportAnchor)

    this.disposePreviousDiffModel(
      currentOriginal,
      previousOriginalOwned,
      nextOriginal,
    )
    this.disposePreviousDiffModel(
      currentModified,
      previousModifiedOwned,
      nextModified,
    )
  }

  getDiffEditorView() {
    return this.diffEditorView
  }

  getDiffModels() {
    return { original: this.originalModel, modified: this.modifiedModel }
  }

  cleanup() {
    this.diffModelTransitionRequestId += 1
    this.disposePendingPreparedDiffViewModel()
    this.clearAsyncWork()
    this.disposeDiffHunkInteractions()
    this.disposeDiffUnchangedRegionEnhancements()
    this.disposeDiffPresentationTracking()

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
    if (this.originalModel && this.originalModelOwned) {
      this.originalModel.dispose()
    }
    if (this.modifiedModel && this.modifiedModelOwned) {
      this.modifiedModel.dispose()
    }
    this.originalModel = null
    this.modifiedModel = null
    this.originalModelOwned = false
    this.modifiedModelOwned = false

    this.lastKnownOriginalCode = null
    this.lastKnownModifiedCode = null
    this.diffRootAppearanceSignature = null
    if (this.lastContainer) {
      this.lastContainer.classList.remove('stream-monaco-diff-root')
      this.lastContainer.classList.remove(
        ...DiffEditorManager.diffLineStyleClasses,
        ...DiffEditorManager.diffUnchangedRegionStyleClasses,
        ...DiffEditorManager.diffLayoutModeClasses,
        ...DiffEditorManager.diffAppearanceClasses,
      )
      this.lastContainer.innerHTML = ''
      this.lastContainer = null
    }
    // clear any pending reveal debounce and reset last reveal cache
    this.revealTicketDiff = 0
    this.lastRevealLineDiff = null
    this.diffPersistedUnchangedModelState = null
    this.pendingDiffScrollRestorePosition = null
    this.pendingDiffScrollRestoreBudget = 0
    this.diffHideUnchangedRegionsResolved = null
    this.diffHideUnchangedRegionsDeferred = false
  }

  safeClean() {
    this.diffModelTransitionRequestId += 1
    this.disposePendingPreparedDiffViewModel()
    this.clearAsyncWork()
    this.hideDiffHunkActions()
    this.disposeDiffUnchangedRegionEnhancements()
    this.disposeDiffPresentationTracking()

    if (this.diffScrollWatcher) {
      this.diffScrollWatcher.dispose()
      this.diffScrollWatcher = null
    }

    this._hasScrollBar = false
    this.shouldAutoScrollDiff = !!(
      this.autoScrollInitial && this.diffAutoScroll
    )
    this.lastScrollTopDiff = 0

    if (this.diffHeightManager) {
      this.diffHeightManager.dispose()
      this.diffHeightManager = null
    }
    this.revealTicketDiff = 0
    this.lastRevealLineDiff = null
    this.diffPersistedUnchangedModelState = null
    this.diffHideUnchangedRegionsDeferred = false
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
          this.lastContainer.style.overflow = 'hidden'
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
    if (
      this.appendBufferOriginalDiff.length === 0
      && this.appendBufferModifiedDiff.length === 0
    ) {
      return
    }
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
    const applyChunked
      = parts.length > 1
        && (totalChars > 2000
          || (model.getLineCount && model.getLineCount() + 0 - prevLineInit > 50))
    log('diff', 'flushAppendBufferDiff start', {
      partsCount: parts.length,
      totalChars,
      applyChunked,
    })
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
      catch {}
    }

    if (applyChunked) {
      log('diff', 'flushAppendBufferDiff applying chunked', {
        partsLen: parts.length,
      })
      let idx = 0
      for (const part of parts) {
        if (!part)
          continue
        idx += 1
        log('diff', 'flushAppendBufferDiff chunk', {
          idx,
          partLen: part.length,
          prevLine,
        })
        const lastColumn = model.getLineMaxColumn(prevLine)
        const range = new monaco.Range(
          prevLine,
          lastColumn,
          prevLine,
          lastColumn,
        )
        model.applyEdits([{ range, text: part, forceMoveMarkers: true }])
        // update lastKnownModifiedCode lazily based on model value to avoid drift
        this.lastKnownModifiedCode = model.getValue()
        const newLine = model.getLineCount()
        this.lastKnownModifiedLineCount = newLine
        // try to let the editor update layout before scheduling reveal/scroll
        await new Promise(resolve =>
          typeof requestAnimationFrame !== 'undefined'
            ? requestAnimationFrame(resolve)
            : setTimeout(resolve, 0),
        )
        const shouldImmediate = this.shouldPerformImmediateRevealDiff()
        log('diff', 'flushAppendBufferDiff chunk metrics', {
          idx,
          newLine,
          prevLine,
          shouldImmediate,
        })
        if (shouldImmediate)
          this.suppressScrollWatcherDiff(this.scrollWatcherSuppressionMs + 800)
        const computed = this.computedHeight()
        if (computed >= this.maxHeightValue - 1 && this.lastContainer) {
          this.lastContainer.style.height = `${this.maxHeightValue}px`
          this.lastContainer.style.overflow = 'hidden'
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
    // restore suppression state and sync the watcher position after the
    // programmatic edits so subsequent user scroll deltas stay accurate.
    if (suppressedByFlush) {
      watcherApi.setSuppressed(false)
    }
    try {
      this.lastScrollTopDiff
        = this.diffEditorView?.getModifiedEditor().getScrollTop?.()
          ?? this.lastScrollTopDiff
    }
    catch {}
  }

  private applyMinimalEditToModel(
    model: monaco.editor.ITextModel,
    prev: string,
    next: string,
  ) {
    const maxChars = minimalEditMaxChars
    const ratio = minimalEditMaxChangeRatio
    const maxLen = Math.max(prev.length, next.length)
    const changeRatio
      = maxLen > 0 ? Math.abs(next.length - prev.length) / maxLen : 0
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
