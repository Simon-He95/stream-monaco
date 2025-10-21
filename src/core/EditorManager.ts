import type { MonacoLanguage, MonacoOptions } from '../type'
import { processedLanguage } from '../code.detect'
import { defaultRevealBatchOnIdleMs, defaultRevealDebounceMs, defaultScrollbar, minimalEditMaxChangeRatio, minimalEditMaxChars, padding } from '../constant'
import { computeMinimalEdit } from '../minimalEdit'
import * as monaco from '../monaco-shim'
import { createHeightManager } from '../utils/height'
import { createRafScheduler } from '../utils/raf'
import { createScrollWatcherForEditor } from '../utils/scroll'

export class EditorManager {
  private editorView: monaco.editor.IStandaloneCodeEditor | null = null
  private lastContainer: HTMLElement | null = null
  private lastKnownCode: string | null = null
  private pendingUpdate: { code: string, lang: string } | null = null
  private _hasScrollBar = false

  private shouldAutoScroll = true
  private scrollWatcher: monaco.IDisposable | null = null
  private lastScrollTop = 0

  private cachedScrollHeight: number | null = null
  private cachedLineHeight: number | null = null
  private cachedComputedHeight: number | null = null
  private cachedLineCount: number | null = null
  private lastKnownCodeDirty = false

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
  private revealStrategyOption?: 'bottom' | 'centerIfOutside' | 'center'
  private revealBatchOnIdleMsOption?: number

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
    return height
  }

  private maybeScrollToBottom(targetLine?: number) {
    // Defer measurement and reveal work to the raf scheduler so we avoid forcing sync layout
    // during hot update paths. This coalesces multiple calls into one frame.
    this.rafScheduler.schedule('maybe-scroll', () => {
      if (!(this.autoScrollOnUpdate && this.shouldAutoScroll && this.hasVerticalScrollbar())) {
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
        this.revealIdleTimerId = (setTimeout(() => {
          this.revealIdleTimerId = null
          this.performReveal(line)
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
        this.performReveal(line)
      }, ms) as unknown) as number
    })
  }

  private performReveal(line: number) {
    this.rafScheduler.schedule('reveal', () => {
      const strategy = this.revealStrategyOption ?? this.options.revealStrategy ?? 'centerIfOutside'
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

  async createEditor(
    container: HTMLElement,
    code: string,
    language: string,
    currentTheme: string,
  ) {
    this.cleanup()
    this.lastContainer = container

    container.style.overflow = 'auto'
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
    this.editorHeightManager = createHeightManager(container, () => this.computedHeight(this.editorView!))
    this.editorHeightManager.update()

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
          this.measureViewport()
          this.cachedLineCount = this.editorView?.getModel()?.getLineCount() ?? this.cachedLineCount
          if (this.editorHeightManager?.isSuppressed())
            return
          this.editorHeightManager?.update()
        }
        catch { }
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
    try {
      const model = this.editorView.getModel()
      if (model) {
        this.lastKnownCode = model.getValue()
        this.cachedLineCount = model.getLineCount() ?? this.cachedLineCount
      }
    }
    catch { }
    finally {
      this.lastKnownCodeDirty = false
    }
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
        this.maybeScrollToBottom(newLineCount)
      }
      return
    }

    // If we have pending append buffer entries that haven't been flushed to the
    // underlying model yet, prefer reading the authoritative model value rather
    // than the optimistic `lastKnownCode` which may already include unflushed
    // suffixes. Using the model avoids making append/minimal-edit decisions
    // based on a state that hasn't been applied yet (which can cause
    // duplicated tails).
    const prevCode = (this.appendBuffer.length > 0)
      ? this.editorView.getValue()
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
      this.maybeScrollToBottom(newLineCount)
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
    try {
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
    }
    catch { }

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
    const newLineCount = model.getLineCount()
    if (lastLine !== newLineCount) {
      this.cachedLineCount = newLineCount
      this.maybeScrollToBottom(newLineCount)
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
    this.pendingUpdate = null
    this.rafScheduler.cancel('append')
    this.appendBufferScheduled = false
    this.appendBuffer.length = 0

    if (this.editorView) {
      this.editorView.dispose()
      this.editorView = null
    }
    this.lastKnownCode = null
    if (this.lastContainer) {
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

    if (this.scrollWatcher) {
      this.scrollWatcher.dispose()
      this.scrollWatcher = null
    }
    if (this.revealDebounceId != null) {
      clearTimeout(this.revealDebounceId)
      this.revealDebounceId = null
    }

    this._hasScrollBar = false
    this.shouldAutoScroll = !!this.autoScrollInitial
    this.lastScrollTop = 0

    if (this.editorHeightManager) {
      this.editorHeightManager.dispose()
      this.editorHeightManager = null
    }
  }
}
