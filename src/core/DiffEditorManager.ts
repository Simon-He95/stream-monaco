import type { MonacoLanguage, MonacoOptions } from '../type'
import { processedLanguage } from '../code.detect'
import { defaultRevealBatchOnIdleMs, defaultRevealDebounceMs, defaultScrollbar, minimalEditMaxChangeRatio, minimalEditMaxChars, padding } from '../constant'
import { computeMinimalEdit } from '../minimalEdit'
import * as monaco from '../monaco-shim'
import { createHeightManager } from '../utils/height'
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
  // debounce id for reveal to coalesce rapid calls (ms)
  private revealDebounceIdDiff: number | null = null
  private readonly revealDebounceMs = defaultRevealDebounceMs
  // idle timer for final batch reveal
  private revealIdleTimerIdDiff: number | null = null
  private revealStrategyOption?: 'bottom' | 'centerIfOutside' | 'center'
  private revealBatchOnIdleMsOption?: number

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
      if (!this.diffEditorView)
        return
      if (!(this.diffAutoScroll && this.autoScrollOnUpdate && this.shouldAutoScrollDiff && this.hasVerticalScrollbarModified()))
        return
      const me = this.diffEditorView.getModifiedEditor()
      const model = me.getModel()
      const currentLine = model?.getLineCount() ?? 1
      const line = targetLine ?? currentLine

      const prevLine = (typeof prevLineOverride === 'number')
        ? prevLineOverride
        : (this.lastKnownModifiedLineCount ?? -1)
      if (prevLine !== -1 && prevLine === currentLine && line === currentLine)
        return

      if (this.lastRevealLineDiff !== null && this.lastRevealLineDiff === line)
        return

      const batchMs = this.revealBatchOnIdleMsOption ?? this.options.revealBatchOnIdleMs ?? defaultRevealBatchOnIdleMs
      if (typeof batchMs === 'number' && batchMs > 0) {
        if (this.revealIdleTimerIdDiff != null) {
          clearTimeout(this.revealIdleTimerIdDiff)
        }
        this.revealIdleTimerIdDiff = (setTimeout(() => {
          this.revealIdleTimerIdDiff = null
          this.performRevealDiff(line)
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
        this.performRevealDiff(line)
      }, ms) as unknown) as number

      this.lastKnownModifiedLineCount = currentLine
    })
  }

  private performRevealDiff(line: number) {
    this.rafScheduler.schedule('revealDiff', () => {
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

    container.style.overflow = 'auto'
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

    this.maybeScrollDiffToBottom(this.modifiedModel.getLineCount(), this.lastKnownModifiedLineCount ?? undefined)

    if (this.diffHeightManager) {
      this.diffHeightManager.dispose()
      this.diffHeightManager = null
    }
    this.diffHeightManager = createHeightManager(container, () => this.computedHeight())
    this.diffHeightManager.update()

    const me = this.diffEditorView.getModifiedEditor()
    this.cachedScrollHeightDiff = me.getScrollHeight?.() ?? null
    this.cachedLineHeightDiff = me.getOption?.(monaco.editor.EditorOption.lineHeight) ?? null
    this.cachedComputedHeightDiff = this.computedHeight()

    const oEditor = this.diffEditorView.getOriginalEditor()
    const mEditor = this.diffEditorView.getModifiedEditor()
    oEditor.onDidContentSizeChange?.(() => {
      this._hasScrollBar = false
      this.rafScheduler.schedule('content-size-change-diff', () => {
        try {
          this.cachedScrollHeightDiff = oEditor.getScrollHeight?.() ?? this.cachedScrollHeightDiff
          this.cachedLineHeightDiff = oEditor.getOption?.(monaco.editor.EditorOption.lineHeight) ?? this.cachedLineHeightDiff
          this.cachedComputedHeightDiff = this.computedHeight()
          if (this.diffHeightManager?.isSuppressed())
            return
          this.diffHeightManager?.update()
        }
        catch { }
      })
    })
    mEditor.onDidContentSizeChange?.(() => {
      this._hasScrollBar = false
      this.rafScheduler.schedule('content-size-change-diff', () => {
        try {
          this.cachedScrollHeightDiff = mEditor.getScrollHeight?.() ?? this.cachedScrollHeightDiff
          this.cachedLineHeightDiff = mEditor.getOption?.(monaco.editor.EditorOption.lineHeight) ?? this.cachedLineHeightDiff
          this.cachedComputedHeightDiff = this.computedHeight()
          if (this.diffHeightManager?.isSuppressed())
            return
          this.diffHeightManager?.update()
        }
        catch { }
      })
    })

    // defer getValue reads for modified model to once-per-frame
    mEditor.onDidChangeModelContent(() => {
      this.lastKnownModifiedDirty = true
      this.rafScheduler.schedule('sync-last-known-modified', () => this.syncLastKnownModified())
    })

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
    if (newCode.startsWith(prev) && prev.length < newCode.length) {
      const prevLine = this.modifiedModel.getLineCount()
      this.appendToModel(this.modifiedModel, newCode.slice(prev.length))
      this.maybeScrollDiffToBottom(this.modifiedModel.getLineCount(), prevLine)
    }
    else {
      this.applyMinimalEditToModel(this.modifiedModel, prev, newCode)
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
    try {
      this.lastKnownOriginalCode = this.originalModel.getValue()
    }
    catch { }
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
    catch { }
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
    // flushed yet, prefer the authoritative model value rather than the
    // optimistic `lastKnownModifiedCode` which may already include unflushed
    // suffixes. This avoids appending duplicate tails when we decide the
    // new `modified` is an append of the previous content.
    let prevM: string = this.lastKnownModifiedCode!
    if (this.appendBufferDiff.length > 0) {
      try {
        prevM = m.getValue()
        this.lastKnownModifiedCode = prevM
      }
      catch {
        prevM = this.lastKnownModifiedCode ?? ''
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
        this.maybeScrollDiffToBottom(newMLineCount, prevMLineCount)
      }
    }
  }

  private flushAppendBufferDiff() {
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
    const text = this.appendBufferDiff.join('')
    this.appendBufferDiff.length = 0
    try {
      const prevLine = model.getLineCount()
      const lastColumn = model.getLineMaxColumn(prevLine)
      const range = new monaco.Range(prevLine, lastColumn, prevLine, lastColumn)
      model.applyEdits([{ range, text, forceMoveMarkers: true }])
      // update lastKnownModifiedCode lazily based on model value to avoid drift
      try {
        this.lastKnownModifiedCode = model.getValue()
      }
      catch { }

      const newLine = model.getLineCount()
      // schedule a short RAF task to allow the editor to update layout/scroll heights
      // before we check for vertical scrollbar and potentially auto-scroll.
      this.maybeScrollDiffToBottom(newLine, prevLine)
      // keep internal line count cache in sync
      this.lastKnownModifiedLineCount = newLine
    }
    catch { }
  }

  private applyMinimalEditToModel(model: monaco.editor.ITextModel, prev: string, next: string) {
    try {
      const maxChars = minimalEditMaxChars
      const ratio = minimalEditMaxChangeRatio
      const maxLen = Math.max(prev.length, next.length)
      const changeRatio = maxLen > 0 ? Math.abs(next.length - prev.length) / maxLen : 0
      if (prev.length + next.length > maxChars || changeRatio > ratio) {
        model.setValue(next)
        try {
          if (model === this.modifiedModel) {
            this.lastKnownModifiedLineCount = model.getLineCount()
          }
        }
        catch { }
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
    model.applyEdits([{ range, text: replaceText, forceMoveMarkers: true }])
    try {
      if (model === this.modifiedModel) {
        this.lastKnownModifiedLineCount = model.getLineCount()
      }
    }
    catch { }
  }

  private appendToModel(model: monaco.editor.ITextModel, appendText: string) {
    if (!appendText)
      return
    const lastLine = model.getLineCount()
    const lastColumn = model.getLineMaxColumn(lastLine)
    const range = new monaco.Range(lastLine, lastColumn, lastLine, lastColumn)
    model.applyEdits([{ range, text: appendText, forceMoveMarkers: true }])
    try {
      if (model === this.modifiedModel) {
        this.lastKnownModifiedLineCount = model.getLineCount()
      }
    }
    catch { }
  }
}
