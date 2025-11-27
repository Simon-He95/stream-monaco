import type { MonacoLanguage, MonacoOptions } from '../type'
import { processedLanguage } from '../code.detect'
import { defaultRevealBatchOnIdleMs, defaultRevealDebounceMs, defaultScrollbar, minimalEditMaxChangeRatio, minimalEditMaxChars, padding } from '../constant'
import { computeMinimalEdit } from '../minimalEdit'
import * as monaco from '../monaco-shim'
import { createHeightManager } from '../utils/height'
import { log } from '../utils/logger'
import { createRafScheduler } from '../utils/raf'
import { createScrollWatcherForEditor } from '../utils/scroll'

export class DiffEditorManager {
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

  private appendBufferDiff: string[] = []
  private appendBufferDiffScheduled = false

  private rafScheduler = createRafScheduler()
  private diffHeightManager: ReturnType<typeof createHeightManager> | null = null

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
  ) { }

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
    })
    monaco.editor.setTheme(currentTheme)

    this.diffEditorView.setModel({ original: this.originalModel, modified: this.modifiedModel })

    this.lastKnownOriginalCode = originalCode
    this.lastKnownModifiedCode = modifiedCode

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
      this.appendToModel(this.originalModel, originalCode.slice(prevO.length))
      this.lastKnownOriginalCode = originalCode
      didImmediate = true
    }

    if (modifiedCode !== prevM && modifiedCode.startsWith(prevM)) {
      const prevLine = this.modifiedModel.getLineCount()
      this.appendToModel(this.modifiedModel, modifiedCode.slice(prevM.length))
      this.lastKnownModifiedCode = modifiedCode
      didImmediate = true
      this.maybeScrollDiffToBottom(this.modifiedModel.getLineCount(), prevLine)
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
      this.appendToModel(this.originalModel, newCode.slice(prev.length))
    }
    else {
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
    const prevLine = this.modifiedModel.getLineCount()
    if (newCode.startsWith(prev) && prev.length < newCode.length) {
      this.appendToModel(this.modifiedModel, newCode.slice(prev.length))
      this.maybeScrollDiffToBottom(this.modifiedModel.getLineCount(), prevLine)
    }
    else {
      this.applyMinimalEditToModel(this.modifiedModel, prev, newCode)
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
    this.appendToModel(this.originalModel, appendText)
    this.lastKnownOriginalCode = this.originalModel.getValue()
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
    this.appendBufferDiff.push(appendText)
    if (!this.appendBufferDiffScheduled) {
      this.appendBufferDiffScheduled = true
      this.rafScheduler.schedule('appendDiff', () => this.flushAppendBufferDiff())
    }
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
    this.appendBufferDiff.length = 0
    this.rafScheduler.cancel('content-size-change-diff')
    this.rafScheduler.cancel('sync-last-known-modified')

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
  }

  safeClean() {
    this.rafScheduler.cancel('diff')
    this.pendingDiffUpdate = null

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

    // If we have buffered appends for the modified side that haven't been
    // flushed yet, prefer the authoritative model value plus any buffered
    // suffix rather than the optimistic `lastKnownModifiedCode` which may
    // already include unflushed suffixes. Concatenating the buffer here
    // ensures we don't treat buffered-but-unapplied content as "missing"
    // and then append it again, which would duplicate text.
    let prevM: string = this.lastKnownModifiedCode!
    const buffered = this.appendBufferDiff.length > 0 ? this.appendBufferDiff.join('') : ''
    if (this.appendBufferDiff.length > 0) {
      try {
        prevM = m.getValue() + buffered
        this.lastKnownModifiedCode = prevM
      }
      catch {
        prevM = (this.lastKnownModifiedCode ?? '') + buffered
      }
    }
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

  private async flushAppendBufferDiff() {
    if (!this.diffEditorView)
      return
    if (this.appendBufferDiff.length === 0)
      return
    this.appendBufferDiffScheduled = false
    const me = this.diffEditorView.getModifiedEditor()
    const model = me.getModel()
    if (!model) {
      this.appendBufferDiff.length = 0
      return
    }
    let parts = this.appendBufferDiff.splice(0)
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
    this.appendBufferDiff.length = 0
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
