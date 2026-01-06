import type { MonacoLanguage, MonacoOptions } from '../type'
import { processedLanguage } from '../code.detect'
import { defaultRevealBatchOnIdleMs, defaultRevealDebounceMs, defaultScrollbar, minimalEditMaxChangeRatio, minimalEditMaxChars, padding } from '../constant'
import { computeMinimalEdit } from '../minimalEdit'
import * as monaco from '../monaco-shim'
import { createHeightManager } from '../utils/height'
import { error, log } from '../utils/logger'
import { createRafScheduler } from '../utils/raf'
import { createScrollWatcherForEditor } from '../utils/scroll'

export class EditorManager {
  private editorView: monaco.editor.IStandaloneCodeEditor | null = null
  private lastContainer: HTMLElement | null = null
  private lastKnownCode: string | null = null
  private pendingUpdate: { code: string, lang: string } | null = null
  private _hasScrollBar = false

  private shouldAutoScroll = true
  private scrollWatcher: any = null
  private scrollWatcherSuppressionTimer: number | null = null
  private lastScrollTop = 0

  private cachedScrollHeight: number | null = null
  private cachedLineHeight: number | null = null
  private cachedComputedHeight: number | null = null
  private cachedLineCount: number | null = null
  private lastKnownCodeDirty = false
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
  // debounce id for reveal to coalesce rapid calls (ms)
  private revealDebounceId: number | null = null
  private readonly revealDebounceMs = defaultRevealDebounceMs
  // idle timer for final batch reveal
  private revealIdleTimerId: number | null = null
  private revealTicket = 0
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
  ) { }

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
      const hasVS = this.hasVerticalScrollbar()

      this.dlog('maybeScrollToBottom called', { autoScrollOnUpdate: this.autoScrollOnUpdate, shouldAutoScroll: this.shouldAutoScroll, hasVerticalScrollbar: hasVS, targetLine })

      if (!(this.autoScrollOnUpdate && this.shouldAutoScroll && this.hasVerticalScrollbar())) {
        this.dlog('maybeScrollToBottom skipped (auto-scroll conditions not met)')
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

  // Force an immediate (synchronous) reveal of a line, bypassing the
  // ticketing/debounce mechanism. Used when we explicitly applied the
  // container to the max height and need the scroll to follow immediately.
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
    // After forcing a reveal, ensure auto-scroll state is on and the
    // lastScrollTop is synchronized so the scrollWatcher doesn't treat
    // this programmatic scroll as user input.
    try {
      this.shouldAutoScroll = true
      this.lastScrollTop = this.editorView?.getScrollTop?.() ?? this.lastScrollTop
    }
    catch { }
  }

  private isOverflowAuto() {
    try {
      return !!this.lastContainer && this.lastContainer.style.overflow === 'auto'
    }
    catch { return false }
  }

  private shouldPerformImmediateReveal() {
    return this.autoScrollOnUpdate && this.shouldAutoScroll && this.hasVerticalScrollbar() && this.isOverflowAuto()
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
    this.dlog('createEditor apply theme', currentTheme)
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
    // Compute and apply the editor's height (with internal hysteresis to
    // avoid tiny changes). Provide a small minimum visible height so the
    // editor doesn't collapse to a single line while content is streaming.
    const MIN_VISIBLE_HEIGHT = Math.min(120, this.maxHeightValue)
    // Ensure the container cannot visually collapse below the minimum height
    // even if height manager misses an update or receives an invalid value.
    container.style.minHeight = `${MIN_VISIBLE_HEIGHT}px`
    this.editorHeightManager = createHeightManager(container, () => {
      const computed = this.computedHeight(this.editorView!)
      const clamped = Math.min(computed, this.maxHeightValue)
      return Math.max(clamped, MIN_VISIBLE_HEIGHT)
    })
    this.editorHeightManager.update()

    // If the initial computed height already reaches (or is very near) the
    // configured max height, apply it immediately so the UI shows the
    // scrolled state without waiting for the debounced height manager.
    const initialComputed = this.computedHeight(this.editorView)
    if (initialComputed >= this.maxHeightValue - 1) {
      container.style.height = `${this.maxHeightValue}px`
      container.style.overflow = 'auto'
      this.dlog('applied immediate maxHeight on createEditor', this.maxHeightValue)
    }

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
          const m = this.measureViewport()
          this.dlog('content-size-change measure', m)
          this.cachedLineCount = this.editorView?.getModel()?.getLineCount() ?? this.cachedLineCount
          if (this.editorHeightManager?.isSuppressed()) {
            this.dlog('content-size-change skipped height update (suppressed)')
            return
          }
          this.dlog('content-size-change calling heightManager.update')
          this.editorHeightManager?.update()
          // Toggle overflow based on whether we've effectively reached max height.
          const computed = this.computedHeight(this.editorView!)
          if (this.lastContainer) {
            const prevOverflow = this.lastContainer.style.overflow
            const newOverflow = computed >= this.maxHeightValue - 1 ? 'auto' : 'hidden'
            if (prevOverflow !== newOverflow) {
              this.lastContainer.style.overflow = newOverflow
              // If we just switched to visible overflow and auto-scroll is on,
              // schedule a scroll to bottom so the user sees the latest content.
              if (newOverflow === 'auto' && this.shouldAutoScroll) {
                this.maybeScrollToBottom()
              }
            }
          }
        }
        catch (err) { error('EditorManager', 'content-size-change error', err) }
      })
    })

    // Avoid calling getValue() synchronously on every content change; instead
    // mark dirty and sync once per RAF frame to reduce CPU and style recalcs.
    this.editorView.onDidChangeModelContent(() => {
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
        this.performImmediateReveal(line, ticket)
      }
      catch (err) { error('EditorManager', 'scheduleImmediateRevealAfterLayout error', err) }
    })
  }

  private waitForHeightApplied(target: number, timeoutMs = 500) {
    return new Promise<void>((resolve) => {
      const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
      const check = () => {
        try {
          const last = this.editorHeightManager?.getLastApplied?.() ?? -1
          if (last !== -1 && Math.abs(last - target) <= 12) {
            this.dlog('waitForHeightApplied satisfied', last, 'target=', target)
            resolve()
            return
          }
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
          if (now - start > timeoutMs) {
            log('EditorManager', 'waitForHeightApplied timeout', last, 'target=', target)
            resolve()
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
    this.rafScheduler.schedule('update', () => this.flushPendingUpdate())
  }

  private flushPendingUpdate() {
    if (!this.pendingUpdate || !this.editorView)
      return
    const model = this.editorView.getModel()
    if (!model)
      return

    const { code: newCode, lang: codeLanguage } = this.pendingUpdate
    this.pendingUpdate = null
    const processedCodeLanguage = processedLanguage(codeLanguage)
    const languageId = model.getLanguageId()

    if (languageId !== processedCodeLanguage) {
      if (processedCodeLanguage)
        monaco.editor.setModelLanguage(model, processedCodeLanguage)
      const prevLineCount = model.getLineCount()
      model.setValue(newCode)
      this.lastKnownCode = newCode
      const newLineCount = model.getLineCount()
      this.cachedLineCount = newLineCount
      if (newLineCount !== prevLineCount) {
        // Temporarily suppress the scroll watcher while we run the
        // immediate reveal to avoid the watcher interpreting the layout
        // driven scroll as user input and toggling auto-scroll state.
        const shouldImmediate = this.shouldPerformImmediateReveal()
        if (shouldImmediate)
          this.suppressScrollWatcher(this.scrollWatcherSuppressionMs)
        // If we jumped to the max height, apply it immediately so the
        // scroller appears consistently while content streams.
        const computed = this.computedHeight(this.editorView)
        if (computed >= this.maxHeightValue - 1 && this.lastContainer)
          this.lastContainer.style.height = `${this.maxHeightValue}px`
        this.forceReveal(newLineCount)
      }
      return
    }

    // If we have pending append buffer entries that haven't been flushed to the
    // underlying model yet, prefer reading the authoritative model value plus
    // any buffered suffix. When streaming at high rates it's possible that
    // `appendBuffer` already contains text that hasn't been applied yet; using
    // just `editorView.getValue()` would cause us to later append that same
    // buffered text again (duplicating content). Concatenate the buffer to
    // model value so `prevCode` reflects the true forthcoming model state.
    const buffered = this.appendBuffer.length > 0 ? this.appendBuffer.join('') : ''
    const prevCode = (this.appendBuffer.length > 0)
      ? (this.editorView.getValue() + buffered)
      : (this.lastKnownCode ?? this.editorView.getValue())
    if (prevCode === newCode)
      return

    if (newCode.startsWith(prevCode) && prevCode.length < newCode.length) {
      const suffix = newCode.slice(prevCode.length)
      if (suffix)
        this.appendCode(suffix, codeLanguage)
      this.lastKnownCode = newCode
      return
    }

    const prevLineCount = model.getLineCount()
    this.applyMinimalEdit(prevCode, newCode)
    this.lastKnownCode = newCode
    const newLineCount = model.getLineCount()
    this.cachedLineCount = newLineCount
    if (newLineCount !== prevLineCount) {
      const shouldImmediate = this.shouldPerformImmediateReveal()
      if (shouldImmediate)
        this.suppressScrollWatcher(this.scrollWatcherSuppressionMs)
      if (shouldImmediate) {
        this.scheduleImmediateRevealAfterLayout(newLineCount)
      }
      else {
        this.maybeScrollToBottom(newLineCount)
      }
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
        this.rafScheduler.schedule('append', () => this.flushAppendBuffer())
      }
    }
  }

  private applyMinimalEdit(prev: string, next: string) {
    if (!this.editorView)
      return
    const model = this.editorView.getModel()
    if (!model)
      return
    // Avoid expensive minimal edit calculation for extremely large documents
    // or when the size delta is very large; fallback to full setValue.
    const maxChars = minimalEditMaxChars
    const ratio = minimalEditMaxChangeRatio
    const maxLen = Math.max(prev.length, next.length)
    const changeRatio = maxLen > 0 ? Math.abs(next.length - prev.length) / maxLen : 0
    if (prev.length + next.length > maxChars || changeRatio > ratio) {
      const prevLineCount = model.getLineCount()
      model.setValue(next)
      this.lastKnownCode = next
      const newLineCount = model.getLineCount()
      this.cachedLineCount = newLineCount
      if (newLineCount !== prevLineCount) {
        this.maybeScrollToBottom(newLineCount)
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
    if (isReadOnly)
      model.applyEdits(edit)
    else this.editorView.executeEdits('minimal-replace', edit)
  }

  private flushAppendBuffer() {
    if (!this.editorView)
      return
    if (this.appendBuffer.length === 0)
      return
    this.appendBufferScheduled = false
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
    if (isReadOnly) {
      model.applyEdits([{ range, text, forceMoveMarkers: true }])
    }
    else {
      this.editorView.executeEdits('append', [{ range, text, forceMoveMarkers: true }])
    }
    // Keep lastKnownCode in sync with the model after applying buffered appends
    try {
      this.lastKnownCode = model.getValue()
    }
    catch { }
    const newLineCount = model.getLineCount()
    if (lastLine !== newLineCount) {
      this.cachedLineCount = newLineCount
      const shouldImmediate = this.shouldPerformImmediateReveal()
      if (shouldImmediate)
        this.suppressScrollWatcher(this.scrollWatcherSuppressionMs)
      // When appends push the computed height to the max, apply the max
      // immediately so the editor doesn't show an intermediate scrollbar
      // before the debounced height manager settles.
      const computed = this.computedHeight(this.editorView)
      if (computed >= this.maxHeightValue - 1 && this.lastContainer)
        this.lastContainer.style.height = `${this.maxHeightValue}px`
      if (shouldImmediate) {
        try {
          this.forceReveal(newLineCount)
        }
        catch { }
      }
      else {
        this.maybeScrollToBottom(newLineCount)
      }
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

  cleanup() {
    this.rafScheduler.cancel('update')
    this.rafScheduler.cancel('sync-last-known')
    this.rafScheduler.cancel('content-size-change')
    // cancel any pending reveal/scroll tasks to avoid operating on disposed editor
    this.rafScheduler.cancel('maybe-scroll')
    this.rafScheduler.cancel('reveal')
    this.rafScheduler.cancel('immediate-reveal')
    this.rafScheduler.cancel('maybe-resume')
    this.pendingUpdate = null
    this.rafScheduler.cancel('append')
    this.appendBufferScheduled = false
    this.appendBuffer.length = 0

    if (this.revealDebounceId != null) {
      clearTimeout(this.revealDebounceId)
      this.revealDebounceId = null
    }
    if (this.revealIdleTimerId != null) {
      clearTimeout(this.revealIdleTimerId)
      this.revealIdleTimerId = null
    }
    if (this.scrollWatcherSuppressionTimer != null) {
      clearTimeout(this.scrollWatcherSuppressionTimer)
      this.scrollWatcherSuppressionTimer = null
    }

    if (this.editorView) {
      this.editorView.dispose()
      this.editorView = null
    }
    this.lastKnownCode = null
    if (this.lastContainer) {
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
    this.rafScheduler.cancel('update')
    this.pendingUpdate = null
    this.rafScheduler.cancel('sync-last-known')
    // Cancel/cleanup watchers and timers
    if (this.scrollWatcher) {
      try {
        this.scrollWatcher.dispose()
      }
      catch { }
      this.scrollWatcher = null
    }
    if (this.revealDebounceId != null) {
      clearTimeout(this.revealDebounceId)
      this.revealDebounceId = null
    }
    if (this.revealIdleTimerId != null) {
      clearTimeout(this.revealIdleTimerId)
      this.revealIdleTimerId = null
    }
    if (this.scrollWatcherSuppressionTimer != null) {
      clearTimeout(this.scrollWatcherSuppressionTimer)
      this.scrollWatcherSuppressionTimer = null
    }
    this.rafScheduler.cancel('maybe-scroll')
    this.rafScheduler.cancel('reveal')
    this.rafScheduler.cancel('immediate-reveal')
    this.rafScheduler.cancel('maybe-resume')

    this._hasScrollBar = false
    this.shouldAutoScroll = !!this.autoScrollInitial
    this.lastScrollTop = 0

    if (this.editorHeightManager) {
      this.editorHeightManager.dispose()
      this.editorHeightManager = null
    }
  }
}
