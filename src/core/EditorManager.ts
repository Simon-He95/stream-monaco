import type { MonacoLanguage, MonacoOptions } from '../type'
import { processedLanguage } from '../code.detect'
import { defaultRevealBatchOnIdleMs, defaultRevealDebounceMs, defaultScrollbar, minimalEditMaxChangeRatio, minimalEditMaxChars, padding } from '../constant'
import { computeMinimalEdit } from '../minimalEdit'
import * as monaco from '../monaco-shim'
import { createHeightManager } from '../utils/height'
import { error, log } from '../utils/logger'
import { createRafScheduler } from '../utils/raf'
import { createScrollWatcherForEditor } from '../utils/scroll'

const defaultHeightTransitionMs = 120
const defaultHeightTransitionEasing = 'cubic-bezier(0.4, 0, 0.2, 1)'
const smoothHeightTolerancePx = 1
const legacyHeightTolerancePx = 12
const smoothHeightDebounceMs = 16
const legacyHeightDebounceMs = 0

export class EditorManager {
  private editorView: monaco.editor.IStandaloneCodeEditor | null = null
  private lastContainer: HTMLElement | null = null
  private lastKnownCode: string | null = null
  private pendingUpdate: { code: string, lang: string } | null = null
  private _hasScrollBar = false
  private updateThrottleMs = 50
  private minimalEditMaxCharsValue = minimalEditMaxChars
  private minimalEditMaxChangeRatioValue = minimalEditMaxChangeRatio
  private lastUpdateFlushTime = 0
  private updateThrottleTimer: number | null = null
  private lastAppendFlushTime = 0
  private appendFlushThrottleTimer: number | null = null

  private shouldAutoScroll = true
  private scrollWatcher: any = null
  private scrollWatcherSuppressionTimer: number | null = null
  private lastScrollTop = 0

  private cachedScrollHeight: number | null = null
  private cachedLineHeight: number | null = null
  private cachedComputedHeight: number | null = null
  private cachedLineCount: number | null = null
  private lastKnownCodeDirty = false
  private programmaticContentChangeDepth = 0
  private debug = false

  // read a small set of viewport/layout metrics once to avoid repeated DOM reads
  private measureViewport() {
    if (!this.editorView)
      return null
    const li = this.editorView.getLayoutInfo?.() ?? null
    const lineHeight = this.cachedLineHeight ?? this.editorView.getOption(
      monaco.editor.EditorOption.lineHeight,
    )
    const scrollTop = this.editorView.getScrollTop?.() ?? this.lastScrollTop ?? 0
    const scrollHeight = this.editorView.getScrollHeight?.() ?? this.cachedScrollHeight ?? (li?.height ?? 0)
    const computedHeight = this.cachedComputedHeight ?? this.computedHeight(this.editorView)
    // update caches
    this.cachedLineHeight = lineHeight
    this.cachedScrollHeight = scrollHeight
    this.cachedComputedHeight = computedHeight
    this.lastScrollTop = scrollTop
    return { li, lineHeight, scrollTop, scrollHeight, computedHeight }
  }

  private appendBuffer: string[] = []
  private appendBufferScheduled = false

  private rafScheduler = createRafScheduler()
  private editorHeightManager: ReturnType<typeof createHeightManager> | null = null
  private previousScrollbarGutter: string | null = null
  // debounce id for reveal to coalesce rapid calls (ms)
  private revealDebounceId: number | null = null
  private readonly revealDebounceMs = defaultRevealDebounceMs
  // idle timer for final batch reveal
  private revealIdleTimerId: number | null = null
  private revealTicket = 0
  private layoutTicket = 0
  private revealStrategyOption?: 'bottom' | 'centerIfOutside' | 'center'
  private revealBatchOnIdleMsOption?: number
  private readonly scrollWatcherSuppressionMs = 500

  constructor(
    private options: MonacoOptions,
    private maxHeightValue: number,
    private maxHeightCSS: string,
    private autoScrollOnUpdate: boolean,
    private autoScrollInitial: boolean,
    private autoScrollThresholdPx: number,
    private autoScrollThresholdLines: number,
    private revealDebounceMsOption?: number,
    private updateThrottleMsOption?: number,
  ) {
    this.updateThrottleMs
      = this.updateThrottleMsOption
        ?? (this.options as any).updateThrottleMs
        ?? 50
    this.minimalEditMaxCharsValue
      = (this.options as any).minimalEditMaxChars
        ?? minimalEditMaxChars
    this.minimalEditMaxChangeRatioValue
      = (this.options as any).minimalEditMaxChangeRatio
        ?? minimalEditMaxChangeRatio
  }

  private cancelRafs() {
    this.rafScheduler.cancel('update')
    this.rafScheduler.cancel('sync-last-known')
    this.rafScheduler.cancel('content-size-change')
    this.rafScheduler.cancel('maybe-scroll')
    this.rafScheduler.cancel('reveal')
    this.rafScheduler.cancel('immediate-reveal')
    this.rafScheduler.cancel('layout-after-height')
    this.rafScheduler.cancel('maybe-resume')
    this.rafScheduler.cancel('append')
  }

  private clearRevealTimers() {
    if (this.revealDebounceId != null) {
      clearTimeout(this.revealDebounceId)
      this.revealDebounceId = null
    }
    if (this.revealIdleTimerId != null) {
      clearTimeout(this.revealIdleTimerId)
      this.revealIdleTimerId = null
    }
  }

  private resetAppendState() {
    this.appendBufferScheduled = false
    this.appendBuffer.length = 0
  }

  private clearAsyncWork() {
    this.revealTicket += 1
    this.layoutTicket += 1
    this.cancelRafs()
    this.pendingUpdate = null
    this.lastKnownCodeDirty = false
    this.resetAppendState()
    this.clearRevealTimers()
    if (this.scrollWatcherSuppressionTimer != null) {
      clearTimeout(this.scrollWatcherSuppressionTimer)
      this.scrollWatcherSuppressionTimer = null
    }
    if (this.updateThrottleTimer != null) {
      clearTimeout(this.updateThrottleTimer)
      this.updateThrottleTimer = null
    }
    if (this.appendFlushThrottleTimer != null) {
      clearTimeout(this.appendFlushThrottleTimer)
      this.appendFlushThrottleTimer = null
    }
  }

  // initialize debug flag: prefer explicit runtime flag, then options, fallback to false
  private initDebugFlag() {
    // Browser global override: `window.__STREAM_MONACO_DEBUG__` (true/false)
    if (typeof window !== 'undefined' && (window as any).__STREAM_MONACO_DEBUG__ !== undefined) {
      this.debug = Boolean((window as any).__STREAM_MONACO_DEBUG__)
      return
    }
    // Option-level override: `options.debug`
    if (this.options && (this.options as any).debug !== undefined) {
      this.debug = Boolean((this.options as any).debug)
      return
    }
    this.debug = false
  }

  // instance-level debug logger helper to avoid repetitive guards
  private dlog(...args: any[]) {
    if (!this.debug)
      return
    log('EditorManager', ...args)
  }

  private runAsProgrammaticContentChange<T>(fn: () => T): T {
    this.programmaticContentChangeDepth += 1
    try {
      return fn()
    }
    finally {
      this.programmaticContentChangeDepth -= 1
    }
  }

  private hasVerticalScrollbar(): boolean {
    if (!this.editorView)
      return false
    if (this._hasScrollBar)
      return true
    const m = this.measureViewport()
    if (!m)
      return false
    return this._hasScrollBar = (m.scrollHeight > m.computedHeight + padding / 2)
  }

  private isSmoothHeightTransitionEnabled() {
    return this.options.smoothHeightTransition ?? false
  }

  private isAutomaticLayoutEnabled() {
    return this.options.automaticLayout !== false
  }

  private getHeightChangeTolerancePx() {
    return this.options.heightChangeTolerancePx
      ?? (this.isSmoothHeightTransitionEnabled() ? smoothHeightTolerancePx : legacyHeightTolerancePx)
  }

  private getHeightManagerOptions() {
    const smooth = this.isSmoothHeightTransitionEnabled()
    return {
      smooth,
      transitionMs: this.options.heightTransitionMs ?? defaultHeightTransitionMs,
      transitionEasing: this.options.heightTransitionEasing ?? defaultHeightTransitionEasing,
      debounceMs: this.options.heightUpdateDebounceMs
        ?? (smooth ? smoothHeightDebounceMs : legacyHeightDebounceMs),
      hysteresisPx: this.getHeightChangeTolerancePx(),
    }
  }

  private setOverflowForHeight(computed: number) {
    if (!this.lastContainer)
      return null
    const next = computed >= this.maxHeightValue - 1 ? 'auto' : 'hidden'
    const prev = this.lastContainer.style.overflow
    if (prev !== next)
      this.lastContainer.style.overflow = next
    if (next === 'hidden')
      this._hasScrollBar = false
    return { prev, next, changed: prev !== next }
  }

  private userIsNearBottom(): boolean {
    if (!this.editorView)
      return true
    const m = this.measureViewport()
    if (!m || !m.li)
      return true
    const lineThreshold = (this.autoScrollThresholdLines ?? 0) * m.lineHeight
    const threshold = Math.max(lineThreshold || 0, this.autoScrollThresholdPx || 0)
    const distance = m.scrollHeight - (m.scrollTop + m.li.height)
    return distance <= threshold
  }

  private computedHeight(editorView: monaco.editor.IStandaloneCodeEditor) {
    const contentHeight = editorView.getContentHeight?.()
    if (
      typeof contentHeight === 'number'
      && Number.isFinite(contentHeight)
      && contentHeight > 0
    ) {
      const height = Math.min(contentHeight, this.maxHeightValue)
      log('EditorManager.computedHeight', { contentHeight, computed: height, maxHeightValue: this.maxHeightValue })
      return height
    }
    const lineCount = this.cachedLineCount ?? editorView.getModel()?.getLineCount() ?? 1
    const lineHeight = editorView.getOption(monaco.editor.EditorOption.lineHeight)
    const height = Math.min(lineCount * lineHeight + padding, this.maxHeightValue)
    // log is defensive itself; no need for an extra try/catch here
    log('EditorManager.computedHeight', { lineCount, lineHeight, computed: height, maxHeightValue: this.maxHeightValue })
    return height
  }

  private maybeScrollToBottom(targetLine?: number) {
    // Defer measurement and reveal work to the raf scheduler so we avoid forcing sync layout
    // during hot update paths. This coalesces multiple calls into one frame.
    this.rafScheduler.schedule('maybe-scroll', () => {
      if (!(this.autoScrollOnUpdate && this.shouldAutoScroll)) {
        this.dlog('maybeScrollToBottom skipped (auto-scroll disabled)', { autoScrollOnUpdate: this.autoScrollOnUpdate, shouldAutoScroll: this.shouldAutoScroll, targetLine })
        return
      }
      const hasVS = this.hasVerticalScrollbar()

      this.dlog('maybeScrollToBottom called', { autoScrollOnUpdate: this.autoScrollOnUpdate, shouldAutoScroll: this.shouldAutoScroll, hasVerticalScrollbar: hasVS, targetLine })

      if (!hasVS) {
        this.dlog('maybeScrollToBottom skipped (no vertical scrollbar)')
        return
      }

      const model = this.editorView!.getModel()
      const line = targetLine ?? model?.getLineCount() ?? 1
      // if revealBatchOnIdleMs is provided, use idle-batching: delay final reveal until idle
      const batchMs = this.revealBatchOnIdleMsOption ?? this.options.revealBatchOnIdleMs ?? defaultRevealBatchOnIdleMs
      if (typeof batchMs === 'number' && batchMs > 0) {
        if (this.revealIdleTimerId != null) {
          clearTimeout(this.revealIdleTimerId)
        }
        const ticket = ++this.revealTicket
        this.dlog('scheduled idle reveal ticket=', ticket, 'line=', line, 'batchMs=', batchMs)
        this.revealIdleTimerId = (setTimeout(() => {
          this.revealIdleTimerId = null
          this.dlog('idle reveal timer firing, ticket=', ticket, 'line=', line)
          this.performReveal(line, ticket)
        }, batchMs) as unknown) as number
        return
      }

      // otherwise use debounce behavior
      if (this.revealDebounceId != null) {
        clearTimeout(this.revealDebounceId)
        this.revealDebounceId = null
      }
      const ms = (typeof this.revealDebounceMs === 'number' && this.revealDebounceMs > 0)
        ? this.revealDebounceMs
        : (typeof this.revealDebounceMsOption === 'number' && this.revealDebounceMsOption > 0)
            ? this.revealDebounceMsOption
            : this.revealDebounceMs
      this.revealDebounceId = (setTimeout(() => {
        this.revealDebounceId = null
        const ticket = ++this.revealTicket
        this.dlog('scheduled debounce reveal ticket=', ticket, 'line=', line, 'ms=', ms)
        this.performReveal(line, ticket)
      }, ms) as unknown) as number
    })
  }

  private performReveal(line: number, ticket: number) {
    this.rafScheduler.schedule('reveal', () => {
      if (ticket !== this.revealTicket) {
        this.dlog('performReveal skipped, stale ticket', ticket, 'current', this.revealTicket)
        return
      }
      this.dlog('performReveal executing, ticket=', ticket, 'line=', line)
      const strategy = this.revealStrategyOption ?? this.options.revealStrategy ?? 'centerIfOutside'
      this.dlog('performReveal strategy=', strategy)
      const ScrollType: any = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
      const smooth = (ScrollType && typeof ScrollType.Smooth !== 'undefined') ? ScrollType.Smooth : undefined
      try {
        if (strategy === 'bottom') {
          if (typeof smooth !== 'undefined')
            this.editorView!.revealLine(line, smooth)
          else this.editorView!.revealLine(line)
        }
        else if (strategy === 'center') {
          if (typeof smooth !== 'undefined')
            this.editorView!.revealLineInCenter(line, smooth)
          else this.editorView!.revealLineInCenter(line)
        }
        else {
          if (typeof smooth !== 'undefined')
            this.editorView!.revealLineInCenterIfOutsideViewport(line, smooth)
          else this.editorView!.revealLineInCenterIfOutsideViewport(line)
        }
      }
      catch {
        // fallback to simple revealLine
        try {
          this.editorView!.revealLine(line)
        }
        catch { }
      }
    })
  }

  // Try to reveal immediately (synchronous) to keep the scroll in-step with
  // edits when we know an update just appended or changed line count.
  // This is a fast-path to reduce the perceived lag before the debounced
  // reveal kicks in. It still leaves the debounced/idle reveal as a fallback
  // for coalescing frequent updates.
  private performImmediateReveal(line: number, ticket: number) {
    this.dlog('performImmediateReveal line=', line, 'ticket=', ticket)
    try {
      if (!this.editorView)
        return
      if (ticket !== this.revealTicket) {
        this.dlog('performImmediateReveal skipped, stale ticket', ticket, 'current', this.revealTicket)
        return
      }
      // Prefer an immediate (non-animated) reveal here to avoid visual
      // jitter caused by smooth scroll animations. Some Monaco builds expose
      // a ScrollType with Immediate; otherwise calling revealLine without
      // a Smooth type typically performs an instant jump.
      const ScrollType: any = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
      const immediate = (ScrollType && typeof ScrollType.Immediate !== 'undefined') ? ScrollType.Immediate : undefined
      if (typeof immediate !== 'undefined') {
        this.editorView.revealLine(line, immediate)
      }
      else {
        this.editorView.revealLine(line)
      }
    }
    catch { }
    // Update cached viewport metrics to keep internal state consistent
    try {
      this.measureViewport()
    }
    catch { }
  }

  private forceReveal(line: number) {
    try {
      if (!this.editorView)
        return
      const ScrollType: any = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
      const immediate = (ScrollType && typeof ScrollType.Immediate !== 'undefined') ? ScrollType.Immediate : undefined
      if (typeof immediate !== 'undefined')
        this.editorView.revealLine(line, immediate)
      else this.editorView.revealLine(line)
    }
    catch { }
    try {
      this.measureViewport()
    }
    catch { }
    try {
      this.shouldAutoScroll = true
      this.lastScrollTop = this.editorView?.getScrollTop?.() ?? this.lastScrollTop
    }
    catch { }
  }

  private shouldRevealAfterLayout() {
    return this.autoScrollOnUpdate && this.shouldAutoScroll
  }

  private getRevealSuppressionMs() {
    const transitionMs = this.editorHeightManager?.getTransitionMs?.() ?? 0
    return Math.max(this.scrollWatcherSuppressionMs, transitionMs + 100)
  }

  private syncHeightAndRevealAfterContentChange(targetLine?: number) {
    const shouldReveal = this.shouldRevealAfterLayout()
    const willReveal = !!(
      shouldReveal
      && this.editorView
      && this.computedHeight(this.editorView) >= this.maxHeightValue - 1
    )
    if (willReveal)
      this.suppressScrollWatcher(this.getRevealSuppressionMs())
    const computed = this.syncNonOverflowingLayout()
    if (computed != null && computed >= this.maxHeightValue - 1 && shouldReveal) {
      const line = targetLine ?? this.editorView?.getModel()?.getLineCount() ?? 1
      if (this.isSmoothHeightTransitionEnabled())
        this.scheduleImmediateRevealAfterLayout(line)
      else
        this.forceReveal(line)
    }
    else if (!shouldReveal && targetLine != null) {
      this.maybeScrollToBottom(targetLine)
    }
    return computed
  }

  private syncNonOverflowingLayout() {
    if (!this.editorView || !this.lastContainer)
      return null

    const computed = this.computedHeight(this.editorView)
    const needsRevealSync = computed >= this.maxHeightValue - 1 && this.shouldRevealAfterLayout()
    const useSmoothHeightTransition = this.isSmoothHeightTransitionEnabled()
    if (needsRevealSync || !useSmoothHeightTransition)
      this.editorHeightManager?.updateNow()
    else
      this.editorHeightManager?.update()
    this.setOverflowForHeight(computed)
    if (computed >= this.maxHeightValue - 1) {
      if (useSmoothHeightTransition)
        this.scheduleLayoutAfterHeightApplied(computed)
      return computed
    }

    this._hasScrollBar = false
    if (useSmoothHeightTransition) {
      this.scheduleLayoutAfterHeightApplied(computed)
      try {
        if ((this.editorView.getScrollTop?.() ?? 0) !== 0)
          this.editorView.setScrollTop?.(0)
        this.lastScrollTop = 0
      }
      catch {}
      return computed
    }
    try {
      this.editorView.layout?.()
    }
    catch {}
    try {
      if ((this.editorView.getScrollTop?.() ?? 0) !== 0)
        this.editorView.setScrollTop?.(0)
      this.lastScrollTop = 0
    }
    catch {}
    return computed
  }

  private scheduleLayoutAfterHeightApplied(target: number) {
    if (this.isAutomaticLayoutEnabled() || !this.editorView)
      return
    const editor = this.editorView
    const ticket = ++this.layoutTicket
    this.rafScheduler.schedule('layout-after-height', async () => {
      try {
        await this.waitForHeightApplied(target, 500)
        if (ticket !== this.layoutTicket || this.editorView !== editor)
          return
        editor.layout?.()
        this.measureViewport()
      }
      catch (err) { error('EditorManager', 'scheduleLayoutAfterHeightApplied error', err) }
    })
  }

  async createEditor(
    container: HTMLElement,
    code: string,
    language: string,
    currentTheme: string,
  ) {
    this.cleanup()
    this.lastContainer = container

    this.initDebugFlag()
    this.dlog('createEditor container, maxHeight', this.maxHeightValue)

    // Start with hidden overflow so we don't show a scrollbar before the
    // editor reaches its configured max height. We'll toggle to `auto`
    // when the computed height reaches `maxHeightValue`.
    container.style.overflow = 'hidden'
    this.previousScrollbarGutter = null
    if (this.isSmoothHeightTransitionEnabled()) {
      this.previousScrollbarGutter = container.style.scrollbarGutter || ''
      container.style.scrollbarGutter = 'stable'
    }
    container.style.maxHeight = this.maxHeightCSS

    this.editorView = monaco.editor.create(container, {
      value: code,
      language: processedLanguage(language) || language,
      theme: currentTheme,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      automaticLayout: true,
      readOnly: this.options.readOnly ?? true,
      contextmenu: false,
      scrollbar: {
        ...defaultScrollbar,
        ...(this.options.scrollbar || {}),
      },
      ...this.options,
    })
    monaco.editor.setTheme(currentTheme)

    this.lastKnownCode = this.editorView.getValue()

    if (this.editorHeightManager) {
      try {
        this.editorHeightManager.dispose()
      }
      catch { }
      this.editorHeightManager = null
    }
    // clear any pending reveal debounce
    if (this.revealDebounceId != null) {
      clearTimeout(this.revealDebounceId)
      this.revealDebounceId = null
    }
    if (this.revealIdleTimerId != null) {
      clearTimeout(this.revealIdleTimerId)
    }
    this.revealIdleTimerId = null
    // Compute and apply the editor's content height. Consumers such as
    // CodeBlockNode may also sync this same host height from Monaco, so avoid
    // enforcing a separate minimum that would fight the host.
    this.editorHeightManager = createHeightManager(container, () => {
      const computed = this.computedHeight(this.editorView!)
      return Math.min(computed, this.maxHeightValue)
    }, this.getHeightManagerOptions())
    const initialComputed = this.editorHeightManager.updateNow()
    if (initialComputed != null)
      this.setOverflowForHeight(initialComputed)

    this.cachedScrollHeight = this.editorView.getScrollHeight?.() ?? null
    this.cachedLineHeight = this.editorView.getOption?.(monaco.editor.EditorOption.lineHeight) ?? null
    this.cachedComputedHeight = this.computedHeight(this.editorView)
    this.cachedLineCount = this.editorView.getModel()?.getLineCount() ?? null

    this.editorView.onDidContentSizeChange?.(() => {
      this._hasScrollBar = false
      // Defer expensive measurements to RAF to avoid forcing sync layout on
      // the content-size-change event which can fire frequently.
      this.rafScheduler.schedule('content-size-change', () => {
        try {
          this.dlog('content-size-change frame')
          this.cachedLineCount = this.editorView?.getModel()?.getLineCount() ?? this.cachedLineCount
          this.cachedComputedHeight = null
          const m = this.measureViewport()
          this.dlog('content-size-change measure', m)
          if (this.editorHeightManager?.isSuppressed()) {
            this.dlog('content-size-change skipped height update (suppressed)')
            return
          }
          this.dlog('content-size-change syncing height/reveal')
          this.syncHeightAndRevealAfterContentChange()
        }
        catch (err) { error('EditorManager', 'content-size-change error', err) }
      })
    })

    // Avoid calling getValue() synchronously on every content change; instead
    // mark dirty and sync once per RAF frame to reduce CPU and style recalcs.
    this.editorView.onDidChangeModelContent(() => {
      if (this.programmaticContentChangeDepth > 0)
        return
      this.lastKnownCodeDirty = true
      this.rafScheduler.schedule('sync-last-known', () => this.syncLastKnownCode())
    })

    this.shouldAutoScroll = !!this.autoScrollInitial
    if (this.scrollWatcher) {
      this.scrollWatcher.dispose()
      this.scrollWatcher = null
    }
    this.scrollWatcher = createScrollWatcherForEditor(this.editorView, {
      onPause: () => { this.shouldAutoScroll = false },
      onMaybeResume: () => {
        // defer the expensive userIsNearBottom check to the raf scheduler
        this.rafScheduler.schedule('maybe-resume', () => {
          this.shouldAutoScroll = this.userIsNearBottom()
        })
      },
      getLast: () => this.lastScrollTop,
      setLast: (v: number) => { this.lastScrollTop = v },
    })

    if (this.shouldAutoScroll)
      this.maybeScrollToBottom()

    return this.editorView
  }

  private syncLastKnownCode() {
    if (!this.editorView || !this.lastKnownCodeDirty)
      return
    const model = this.editorView.getModel()
    if (model) {
      this.lastKnownCode = model.getValue()
      this.cachedLineCount = model.getLineCount() ?? this.cachedLineCount
      this.cachedComputedHeight = null
    }
    this.lastKnownCodeDirty = false
  }

  private suppressScrollWatcher(ms: number) {
    if (!this.scrollWatcher || typeof this.scrollWatcher.setSuppressed !== 'function')
      return
    this.dlog('suppressScrollWatcher', ms)
    // clear existing timer
    if (this.scrollWatcherSuppressionTimer != null) {
      clearTimeout(this.scrollWatcherSuppressionTimer)
      this.scrollWatcherSuppressionTimer = null
    }
    this.scrollWatcher.setSuppressed(true)
    this.scrollWatcherSuppressionTimer = (setTimeout(() => {
      if (this.scrollWatcher && typeof this.scrollWatcher.setSuppressed === 'function') {
        this.scrollWatcher.setSuppressed(false)
        this.dlog('suppressScrollWatcher cleared')
      }
      this.scrollWatcherSuppressionTimer = null
    }, ms) as unknown) as number
  }

  // Schedule an immediate reveal after layout has settled (two RAFs).
  // This reduces races where a reveal runs before the editor/container
  // has applied its new size, which can cause reveal to be a no-op or
  // be applied in the wrong order relative to other reveals.
  private scheduleImmediateRevealAfterLayout(line: number) {
    const ticket = ++this.revealTicket
    this.dlog('scheduleImmediateRevealAfterLayout ticket=', ticket, 'line=', line)
    this.rafScheduler.schedule('immediate-reveal', async () => {
      try {
        // If we have a height manager, compute the expected applied height
        const target = this.editorView && this.editorHeightManager
          ? Math.min(this.computedHeight(this.editorView), this.maxHeightValue)
          : -1
        if (target !== -1 && this.editorHeightManager) {
          // Wait until the height manager reports the target as applied
          await this.waitForHeightApplied(target, 500)
        }
        else {
          // fallback: wait two frames to let layout settle
          await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        }
        this.dlog('running delayed immediate reveal', 'ticket=', ticket, 'line=', line)
        if (ticket !== this.revealTicket) {
          this.dlog('delayed immediate reveal skipped, stale ticket', ticket, 'current', this.revealTicket)
          return
        }
        this.suppressScrollWatcher(this.scrollWatcherSuppressionMs)
        this.performImmediateReveal(line, ticket)
      }
      catch (err) { error('EditorManager', 'scheduleImmediateRevealAfterLayout error', err) }
    })
  }

  private waitForHeightApplied(target: number, timeoutMs = 500) {
    return new Promise<void>((resolve) => {
      const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
      const tolerance = this.getHeightChangeTolerancePx()
      const transitionMs = this.editorHeightManager?.getTransitionMs?.() ?? 0
      let settled = false
      const resolveAfterSettle = () => {
        if (settled)
          return
        settled = true
        if (transitionMs > 0) {
          setTimeout(resolve, transitionMs)
          return
        }
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }
      const check = () => {
        try {
          const last = this.editorHeightManager?.getLastApplied?.() ?? -1
          if (last !== -1 && Math.abs(last - target) <= tolerance) {
            this.dlog('waitForHeightApplied satisfied', last, 'target=', target)
            resolveAfterSettle()
            return
          }
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
          if (now - start > timeoutMs) {
            log('EditorManager', 'waitForHeightApplied timeout', last, 'target=', target)
            resolveAfterSettle()
            return
          }
        }
        catch { }
        requestAnimationFrame(check)
      }
      check()
    })
  }

  updateCode(newCode: string, codeLanguage: string) {
    this.pendingUpdate = { code: newCode, lang: codeLanguage }
    this.rafScheduler.schedule('update', () => {
      if (!this.updateThrottleMs) {
        this.flushPendingUpdate()
        return
      }
      const now = Date.now()
      const since = now - this.lastUpdateFlushTime
      if (since >= this.updateThrottleMs) {
        this.flushPendingUpdate()
        return
      }
      if (this.updateThrottleTimer != null)
        return
      const wait = this.updateThrottleMs - since
      this.updateThrottleTimer = (setTimeout(() => {
        this.updateThrottleTimer = null
        this.rafScheduler.schedule('update', () => this.flushPendingUpdate())
      }, wait) as unknown) as number
    })
  }

  private flushPendingUpdate() {
    if (!this.pendingUpdate || !this.editorView)
      return
    const model = this.editorView.getModel()
    if (!model)
      return

    const { code: newCode, lang: codeLanguage } = this.pendingUpdate
    this.pendingUpdate = null
    this.lastUpdateFlushTime = Date.now()
    const processedCodeLanguage = processedLanguage(codeLanguage)
    const languageId = model.getLanguageId()

    if (languageId !== processedCodeLanguage) {
      if (processedCodeLanguage)
        monaco.editor.setModelLanguage(model, processedCodeLanguage)
      const prevLineCount = model.getLineCount()
      this.runAsProgrammaticContentChange(() => {
        model.setValue(newCode)
      })
      this.lastKnownCode = newCode
      const newLineCount = model.getLineCount()
      this.cachedLineCount = newLineCount
      this.cachedComputedHeight = null
      if (newLineCount !== prevLineCount) {
        this.syncHeightAndRevealAfterContentChange(newLineCount)
      }
      return
    }

    let prevCode: string
    if (this.appendBuffer.length > 0) {
      this.resetAppendState()
      this.rafScheduler.cancel('append')
      try {
        prevCode = model.getValue()
        this.lastKnownCode = prevCode
      }
      catch {
        prevCode = this.lastKnownCode ?? ''
      }
    }
    else if (this.lastKnownCode != null) {
      prevCode = this.lastKnownCode
    }
    else {
      prevCode = this.editorView.getValue()
      this.lastKnownCode = prevCode
    }
    if (prevCode === newCode)
      return

    if (newCode.startsWith(prevCode) && prevCode.length < newCode.length) {
      const suffix = newCode.slice(prevCode.length)
      if (suffix)
        this.appendCode(suffix, codeLanguage)
      return
    }

    const prevLineCount = model.getLineCount()
    this.applyMinimalEdit(prevCode, newCode)
    this.lastKnownCode = newCode
    const newLineCount = model.getLineCount()
    this.cachedLineCount = newLineCount
    this.cachedComputedHeight = null
    if (newLineCount !== prevLineCount) {
      this.syncHeightAndRevealAfterContentChange(newLineCount)
    }
  }

  appendCode(appendText: string, codeLanguage?: string) {
    if (!this.editorView)
      return
    const model = this.editorView.getModel()
    if (!model)
      return

    const processedCodeLanguage = codeLanguage ? processedLanguage(codeLanguage) : model.getLanguageId()
    if (processedCodeLanguage && model.getLanguageId() !== processedCodeLanguage)
      monaco.editor.setModelLanguage(model, processedCodeLanguage)

    // Buffer-only; actual edit is applied in flushAppendBuffer once per frame
    if (appendText) {
      this.appendBuffer.push(appendText)
      if (!this.appendBufferScheduled) {
        this.appendBufferScheduled = true
        this.scheduleFlushAppendBuffer()
      }
    }
  }

  private scheduleFlushAppendBuffer() {
    const schedule = () => {
      this.rafScheduler.schedule('append', () => this.flushAppendBuffer())
    }

    if (!this.updateThrottleMs) {
      schedule()
      return
    }

    const now = Date.now()
    const since = now - this.lastAppendFlushTime
    if (since >= this.updateThrottleMs) {
      schedule()
      return
    }

    if (this.appendFlushThrottleTimer != null)
      return
    const wait = this.updateThrottleMs - since
    this.appendFlushThrottleTimer = (setTimeout(() => {
      this.appendFlushThrottleTimer = null
      schedule()
    }, wait) as unknown) as number
  }

  private applyMinimalEdit(prev: string, next: string) {
    if (!this.editorView)
      return
    const model = this.editorView.getModel()
    if (!model)
      return
    // Avoid expensive minimal edit calculation for extremely large documents
    // or when the size delta is very large; fallback to full setValue.
    const maxChars = this.minimalEditMaxCharsValue
    const ratio = this.minimalEditMaxChangeRatioValue
    const maxLen = Math.max(prev.length, next.length)
    const changeRatio = maxLen > 0 ? Math.abs(next.length - prev.length) / maxLen : 0
    if (prev.length + next.length > maxChars || changeRatio > ratio) {
      const prevLineCount = model.getLineCount()
      this.runAsProgrammaticContentChange(() => {
        model.setValue(next)
      })
      this.lastKnownCode = next
      const newLineCount = model.getLineCount()
      this.cachedLineCount = newLineCount
      if (newLineCount !== prevLineCount) {
        this.syncHeightAndRevealAfterContentChange(newLineCount)
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

    const isReadOnly = this.editorView.getOption(monaco.editor.EditorOption.readOnly)
    const edit = [{ range, text: replaceText, forceMoveMarkers: true }]
    this.runAsProgrammaticContentChange(() => {
      if (isReadOnly)
        model.applyEdits(edit)
      else this.editorView!.executeEdits('minimal-replace', edit)
    })
  }

  private flushAppendBuffer() {
    if (!this.editorView)
      return
    if (this.appendBuffer.length === 0)
      return
    this.appendBufferScheduled = false
    this.lastAppendFlushTime = Date.now()
    const model = this.editorView.getModel()
    if (!model) {
      this.appendBuffer.length = 0
      return
    }
    const text = this.appendBuffer.join('')
    this.appendBuffer.length = 0
    const lastLine = model.getLineCount()
    const lastColumn = model.getLineMaxColumn(lastLine)
    const range = new monaco.Range(lastLine, lastColumn, lastLine, lastColumn)
    const isReadOnly = this.editorView.getOption(monaco.editor.EditorOption.readOnly)
    this.runAsProgrammaticContentChange(() => {
      if (isReadOnly) {
        model.applyEdits([{ range, text, forceMoveMarkers: true }])
      }
      else {
        this.editorView!.executeEdits('append', [{ range, text, forceMoveMarkers: true }])
      }
    })
    if (this.lastKnownCode != null)
      this.lastKnownCode = this.lastKnownCode + text
    else
      this.lastKnownCode = model.getValue()
    const newLineCount = model.getLineCount()
    if (lastLine !== newLineCount) {
      this.cachedLineCount = newLineCount
      this.cachedComputedHeight = null
      this.syncHeightAndRevealAfterContentChange(newLineCount)
    }
  }

  setLanguage(language: MonacoLanguage, languages: MonacoLanguage[]) {
    if (languages.includes(language)) {
      if (this.editorView) {
        const model = this.editorView.getModel()
        if (model && model.getLanguageId() !== language)
          monaco.editor.setModelLanguage(model, language)
      }
    }
    else {
      console.warn(`Language "${language}" is not registered. Available languages: ${languages.join(', ')}`)
    }
  }

  getEditorView() {
    return this.editorView
  }

  getCode() {
    return this.editorView?.getModel()?.getValue() ?? null
  }

  setUpdateThrottleMs(ms: number) {
    this.updateThrottleMs = ms
    if (!this.updateThrottleMs && this.updateThrottleTimer != null) {
      clearTimeout(this.updateThrottleTimer)
      this.updateThrottleTimer = null
      this.rafScheduler.schedule('update', () => this.flushPendingUpdate())
    }
    if (!this.updateThrottleMs && this.appendFlushThrottleTimer != null) {
      clearTimeout(this.appendFlushThrottleTimer)
      this.appendFlushThrottleTimer = null
      this.rafScheduler.schedule('append', () => this.flushAppendBuffer())
    }
  }

  getUpdateThrottleMs() {
    return this.updateThrottleMs
  }

  cleanup() {
    this.clearAsyncWork()

    if (this.editorView) {
      this.editorView.dispose()
      this.editorView = null
    }
    this.lastKnownCode = null
    if (this.lastContainer) {
      if (this.previousScrollbarGutter != null)
        this.lastContainer.style.scrollbarGutter = this.previousScrollbarGutter
      this.previousScrollbarGutter = null
      this.lastContainer.style.minHeight = ''
      this.lastContainer.innerHTML = ''
      this.lastContainer = null
    }
    if (this.scrollWatcher) {
      this.scrollWatcher.dispose()
      this.scrollWatcher = null
    }
    if (this.editorHeightManager) {
      this.editorHeightManager.dispose()
      this.editorHeightManager = null
    }
  }

  safeClean() {
    this.clearAsyncWork()
    // Cancel/cleanup watchers and timers
    if (this.scrollWatcher) {
      try {
        this.scrollWatcher.dispose()
      }
      catch { }
      this.scrollWatcher = null
    }

    this._hasScrollBar = false
    this.shouldAutoScroll = !!this.autoScrollInitial
    this.lastScrollTop = 0
    if (this.lastContainer && this.previousScrollbarGutter != null)
      this.lastContainer.style.scrollbarGutter = this.previousScrollbarGutter
    this.previousScrollbarGutter = null

    if (this.editorHeightManager) {
      this.editorHeightManager.dispose()
      this.editorHeightManager = null
    }
  }
}
