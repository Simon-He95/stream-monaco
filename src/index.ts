import type { WatchStopHandle } from './reactivity'
import type { MonacoLanguage, MonacoOptions, MonacoTheme } from './type'

import { detectLanguage, processedLanguage } from './code.detect'
import { defaultLanguages, defaultRevealDebounceMs, defaultThemes, minimalEditMaxChangeRatio, minimalEditMaxChars, padding } from './constant'
import { DiffEditorManager } from './core/DiffEditorManager'
import { EditorManager } from './core/EditorManager'
import { isDark } from './isDark'
import { computeMinimalEdit } from './minimalEdit'
import * as monaco from './monaco-shim'
import { preloadMonacoWorkers } from './preloadMonacoWorkers'
import { computed, watch } from './reactivity'
import { createRafScheduler } from './utils/raf'
import { clearHighlighterCache, getOrCreateHighlighter, registerMonacoThemes, setThemeRegisterPromise } from './utils/registerMonacoThemes'

/**
 * useMonaco 组合式函数
 *
 * 提供 Monaco 编辑器的创建、销毁、内容/主题/语言更新等能力。
 * 支持主题自动切换、语言高亮、代码更新等功能。
 *
 * @param {MonacoOptions} [monacoOptions] - 编辑器初始化配置，支持 Monaco 原生配置及扩展项
 * @param {number | string} [monacoOptions.MAX_HEIGHT] - 编辑器最大高度，可以是数字（像素）或 CSS 字符串（如 '100%', 'calc(100vh - 100px)'）
 * @param {boolean} [monacoOptions.readOnly] - 是否为只读模式
 * @param {MonacoTheme[]} [monacoOptions.themes] - 主题数组，至少包含两个主题：[暗色主题, 亮色主题]
 * @param {MonacoLanguage[]} [monacoOptions.languages] - 支持的编程语言数组
 * @param {string} [monacoOptions.theme] - 初始主题名称
 * @param {boolean} [monacoOptions.isCleanOnBeforeCreate] - 是否在创建前清理之前注册的资源, 默认为 true
 * @param {(monaco: typeof import('monaco-editor')) => monaco.IDisposable[]} [monacoOptions.onBeforeCreate] - 编辑器创建前的钩子函数
 *
 * @returns {{
 *   createEditor: (container: HTMLElement, code: string, language: string) => Promise<monaco.editor.IStandaloneCodeEditor>,
 *   createDiffEditor: (
 *     container: HTMLElement,
 *     originalCode: string,
 *     modifiedCode: string,
 *     language: string,
 *   ) => Promise<monaco.editor.IStandaloneDiffEditor>,
 *   cleanupEditor: () => void,
 *   updateCode: (newCode: string, codeLanguage: string) => void,
 *   appendCode: (appendText: string, codeLanguage?: string) => void,
 *   updateDiff: (
 *     originalCode: string,
 *     modifiedCode: string,
 *     codeLanguage?: string,
 *   ) => void,
 *   updateOriginal: (newCode: string, codeLanguage?: string) => void,
 *   updateModified: (newCode: string, codeLanguage?: string) => void,
 *   appendOriginal: (appendText: string, codeLanguage?: string) => void,
 *   appendModified: (appendText: string, codeLanguage?: string) => void,
 *   setTheme: (theme: MonacoTheme) => Promise<void>,
 *   setLanguage: (language: MonacoLanguage) => void,
 *   getCurrentTheme: () => string,
 *   getEditor: () => typeof monaco.editor,
 *   getEditorView: () => monaco.editor.IStandaloneCodeEditor | null,
 *   getDiffEditorView: () => monaco.editor.IStandaloneDiffEditor | null,
 *   getDiffModels: () => { original: monaco.editor.ITextModel | null, modified: monaco.editor.ITextModel | null },
 *   getCode: () => string | { original: string, modified: string } | null,
 * }} 返回对象包含以下方法和属性：
 *
 * @property {Function} createEditor - 创建并挂载 Monaco 编辑器到指定容器
 * @property {Function} cleanupEditor - 销毁编辑器并清理容器
 * @property {Function} updateCode - 更新编辑器内容和语言，必要时滚动到底部
 * @property {Function} appendCode - 在编辑器末尾追加文本，必要时滚动到底部
 * @property {Function} createDiffEditor - 创建并挂载 Diff 编辑器
 * @property {Function} updateDiff - 更新 Diff 编辑器的 original/modified 内容（RAF 合并、增量更新）
 * @property {Function} updateOriginal - 仅更新 Diff 的 original 内容（增量更新）
 * @property {Function} updateModified - 仅更新 Diff 的 modified 内容（增量更新）
 * @property {Function} appendOriginal - 在 Diff 的 original 末尾追加（显式流式场景）
 * @property {Function} appendModified - 在 Diff 的 modified 末尾追加（显式流式场景）
 * @property {Function} setTheme - 切换编辑器主题，返回 Promise，在主题应用完成时 resolve
 * @property {Function} setLanguage - 切换编辑器语言
 * @property {Function} getCurrentTheme - 获取当前主题名称
 * @property {Function} getEditor - 获取 Monaco 的静态 editor 对象（用于静态方法调用）
 * @property {Function} getEditorView - 获取当前编辑器实例
 * @property {Function} getDiffEditorView - 获取当前 Diff 编辑器实例
 * @property {Function} getDiffModels - 获取 Diff 的 original/modified 两个模型
 * @property {Function} getCode - 获取当前编辑器或 Diff 编辑器中的代码内容
 *
 * @throws {Error} 当主题数组不是数组或长度小于2时抛出错误
 *
 * @example
 * ```typescript
 * import { useMonaco } from 'stream-monaco'
 *
 * const { createEditor, updateCode, setTheme } = useMonaco({
 *   themes: ['vitesse-dark', 'vitesse-light'],
 *   languages: ['javascript', 'typescript'],
 *   readOnly: false
 * })
 *
 * // 创建编辑器
 * const editor = await createEditor(containerRef.value, 'console.log("hello")', 'javascript')
 *
 * // 更新代码
 * updateCode('console.log("world")', 'javascript')
 *
 * // 切换主题
 * setTheme('vitesse-light')
 * ```
 */
function useMonaco(monacoOptions: MonacoOptions = {}) {
  // per-instance disposables (avoid cross-instance interference)
  const disposals: monaco.IDisposable[] = []
  // 清除之前在 onBeforeCreate 中注册的资源
  if (monacoOptions.isCleanOnBeforeCreate ?? true)
    disposals.forEach(d => d.dispose())
  // 释放已处理的引用，避免数组无限增长
  if (monacoOptions.isCleanOnBeforeCreate ?? true)
    disposals.length = 0
  let editorView: monaco.editor.IStandaloneCodeEditor | null = null
  let editorMgr: EditorManager | null = null
  // 新增：Diff Editor 相关引用（由 DiffEditorManager 管理）
  let diffEditorView: monaco.editor.IStandaloneDiffEditor | null = null
  let diffMgr: DiffEditorManager | null = null
  let originalModel: monaco.editor.ITextModel | null = null
  let modifiedModel: monaco.editor.ITextModel | null = null
  let _hasScrollBar = false

  const themes = (monacoOptions.themes && monacoOptions.themes?.length) ? monacoOptions.themes : defaultThemes
  if (!Array.isArray(themes) || themes.length < 2) {
    throw new Error(
      'Monaco themes must be an array with at least two themes: [darkTheme, lightTheme]',
    )
  }
  const languages = monacoOptions.languages ?? defaultLanguages
  const MAX_HEIGHT = monacoOptions.MAX_HEIGHT ?? 500
  const autoScrollOnUpdate = monacoOptions.autoScrollOnUpdate ?? true
  const autoScrollInitial = monacoOptions.autoScrollInitial ?? true
  const autoScrollThresholdPx = monacoOptions.autoScrollThresholdPx ?? 32
  const autoScrollThresholdLines = monacoOptions.autoScrollThresholdLines ?? 2
  const diffAutoScroll = monacoOptions.diffAutoScroll ?? true

  // 处理 MAX_HEIGHT，转换为数值和CSS字符串
  const getMaxHeightValue = (): number => {
    if (typeof MAX_HEIGHT === 'number') {
      return MAX_HEIGHT
    }
    // 如果是字符串，尝试解析数值部分（用于高度比较）
    const match = MAX_HEIGHT.match(/^(\d+(?:\.\d+)?)/)
    return match ? Number.parseFloat(match[1]) : 500 // 默认值
  }

  const getMaxHeightCSS = (): string => {
    if (typeof MAX_HEIGHT === 'number') {
      return `${MAX_HEIGHT}px`
    }
    return MAX_HEIGHT
  }

  const maxHeightValue = getMaxHeightValue()
  const maxHeightCSS = getMaxHeightCSS()
  let lastContainer: HTMLElement | null = null
  let lastKnownCode: string | null = null
  // Allow overriding heuristics and throttling via options
  const minimalEditMaxCharsLocal = (monacoOptions as any).minimalEditMaxChars ?? minimalEditMaxChars
  const minimalEditMaxChangeRatioLocal = (monacoOptions as any).minimalEditMaxChangeRatio ?? minimalEditMaxChangeRatio
  // 时间节流（ms），0 表示仅使用 RAF 合并。
  // 默认为了在高频流式写入场景下减轻 CPU，使用 50ms 的默认节流。
  // 用户可以通过 monacoOptions.updateThrottleMs 覆盖（设为 0 恢复仅 RAF 合并行为）。
  let updateThrottleMs: number = (monacoOptions as any).updateThrottleMs ?? 50
  // 记录上次实际 flush 的时间戳（ms）及可能的延迟 timer
  let lastFlushTime = 0
  let updateThrottleTimer: number | null = null
  // 合并同一帧内的多次 updateCode 调用，降低布局与 DOM 抖动
  let pendingUpdate: { code: string, lang: string } | null = null
  // raf handled by rafScheduler
  // 自动滚动控制：
  // - 当用户向上滚动离开底部时，暂停 revealLine 的自动滚动
  // - 当用户再次滚动回接近底部（阈值：两行高或 32px）时，恢复自动滚动
  let shouldAutoScroll = true
  // cached computed height (min(lineCount*lineHeight + padding, maxHeightValue))
  // make mutable so it can be updated when layout/content changes
  const cachedComputedHeight: number | null = null
  // append buffers to batch multiple small appends into a single edit per RAF
  const appendBuffer: string[] = []
  let appendBufferScheduled = false
  // Diff 自动滚动控制由 DiffEditorManager 负责
  // 记录上一次应用的主题，避免重复 setTheme 引发不必要的工作
  let lastAppliedTheme: string | null = null
  const currentTheme = computed<string>(() =>
    monacoOptions.theme
    ?? (isDark.value
      ? typeof themes[0] === 'string'
        ? themes[0]
        : (themes[0] as any).name
      : typeof themes[1] === 'string'
        ? themes[1]
        : (themes[1] as any).name),
  )
  let themeWatcher: WatchStopHandle | null = null

  // RAF scheduler (injectable time source possible via utils)
  const rafScheduler = createRafScheduler()

  // Internal helper that applies a theme and invokes MonacoOptions.onThemeChange
  // after the theme has been applied. Exposed internally so watchers can call
  // the same logic and callers can await exported setTheme for completion.
  async function setThemeInternal(theme: MonacoTheme, force = false): Promise<void> {
    const themeName = typeof theme === 'string' ? theme : (theme as any).name

    if (!force && themeName === lastAppliedTheme) {
      return
    }

    const _p = setThemeRegisterPromise(registerMonacoThemes(themes, languages))
    if (_p)
      await _p.catch(() => undefined)

    const availableNames = themes.map(t => (typeof t === 'string' ? t : (t as any).name))
    if (!availableNames.includes(themeName)) {
      try {
        const extended = availableNames.concat(themeName)
        const maybeHighlighter = await setThemeRegisterPromise(registerMonacoThemes(extended as any, languages))
        if (maybeHighlighter && typeof maybeHighlighter.setTheme === 'function') {
          try {
            await maybeHighlighter.setTheme(themeName)
          }
          catch { }
        }
      }
      catch {
        console.warn(`Theme "${themeName}" is not registered and automatic registration failed. Available themes: ${availableNames.join(', ')}`)
        return
      }
    }

    try {
      monaco.editor.setTheme(themeName)
      lastAppliedTheme = themeName
    }
    catch {
      try {
        const maybeHighlighter = await registerMonacoThemes(themes, languages)
        monaco.editor.setTheme(themeName)
        lastAppliedTheme = themeName
        if (maybeHighlighter && typeof maybeHighlighter.setTheme === 'function') {
          await maybeHighlighter.setTheme(themeName).catch(() => undefined)
        }
      }
      catch (err2) {
        console.warn(`Failed to set theme "${themeName}":`, err2)
        return
      }
    }

    // call user callback if provided; await to allow callers to observe completion
    try {
      if (typeof monacoOptions.onThemeChange === 'function') {
        await monacoOptions.onThemeChange(themeName as any)
      }
    }
    catch (err) {
      console.warn('onThemeChange callback threw an error:', err)
    }
  }

  // height management is handled within EditorManager/DiffEditorManager

  // 检查是否出现垂直滚动条
  function hasVerticalScrollbar(): boolean {
    if (!editorView)
      return false
    if (_hasScrollBar)
      return true
    const ch = cachedComputedHeight ?? computedHeight(editorView)
    return _hasScrollBar = (editorView.getScrollHeight!() > ch + padding / 2)
  }
  // 在满足条件时滚动到底部，否则尊重用户滚动状态
  // debounce id for reveal (module-scope for top-level helper)
  let revealDebounceId: number | null = null
  const revealDebounceMs = 75
  function maybeScrollToBottom(targetLine?: number) {
    if (autoScrollOnUpdate && shouldAutoScroll && hasVerticalScrollbar()) {
      const model = editorView!.getModel()
      const line = targetLine ?? model?.getLineCount() ?? 1

      if (revealDebounceId != null) {
        clearTimeout(revealDebounceId)
        revealDebounceId = null
      }
      revealDebounceId = (setTimeout(() => {
        revealDebounceId = null
        rafScheduler.schedule('reveal', () => {
          try {
            const ScrollType: any = (monaco as any).ScrollType || (monaco as any).editor?.ScrollType
            if (ScrollType && typeof ScrollType.Smooth !== 'undefined')
              editorView!.revealLineInCenterIfOutsideViewport(line, ScrollType.Smooth)
            else
              editorView!.revealLineInCenterIfOutsideViewport(line)
          }
          catch {
            // ignore reveal errors
          }
        })
      }, revealDebounceMs) as unknown) as number
    }
  }

  async function createEditor(
    container: HTMLElement,
    code: string,
    language: string,
  ) {
    // 使用 EditorManager 重构
    cleanupEditor()
    lastContainer = container

    if (monacoOptions.isCleanOnBeforeCreate ?? true) {
      disposals.forEach(d => d.dispose())
      disposals.length = 0
    }
    if (monacoOptions.onBeforeCreate) {
      const ds = monacoOptions.onBeforeCreate(monaco)
      if (ds)
        disposals.push(...ds)
    }

    await setThemeRegisterPromise(registerMonacoThemes(themes, languages))

    // Determine initial theme: prefer explicit option, otherwise use computed
    const initialThemeName = monacoOptions.theme ?? currentTheme.value
    lastAppliedTheme = initialThemeName

    editorMgr = new EditorManager(
      monacoOptions,
      maxHeightValue,
      maxHeightCSS,
      autoScrollOnUpdate,
      autoScrollInitial,
      autoScrollThresholdPx,
      autoScrollThresholdLines,
      monacoOptions.revealDebounceMs,
    )
    editorView = await editorMgr.createEditor(container, code, language, initialThemeName)

    if (typeof monacoOptions.onThemeChange === 'function') {
      monacoOptions.onThemeChange(initialThemeName as any)
    }
    // Watch theme changes - use internal setter so onThemeChange is invoked
    if (!monacoOptions.theme) {
      themeWatcher = watch(
        () => isDark.value,
        () => {
          const t = currentTheme.value
          if (t !== lastAppliedTheme) {
            void setThemeInternal(t)
          }
        },
        { flush: 'post', immediate: true },
      )
    }

    try {
      if (editorView)
        lastKnownCode = editorView.getValue()
    }
    catch { }

    return editorView
  }
  function computedHeight(editorView: monaco.editor.IStandaloneCodeEditor) {
    const lineCount = editorView!.getModel()?.getLineCount() ?? 1
    const lineHeight = editorView!.getOption(
      monaco.editor.EditorOption.lineHeight,
    )
    const height = Math.min(lineCount * lineHeight + padding, maxHeightValue)
    return height
  }
  // 新增：创建 Diff 编辑器
  async function createDiffEditor(
    container: HTMLElement,
    originalCode: string,
    modifiedCode: string,
    language: string,
  ) {
    cleanupEditor()
    lastContainer = container

    // 在创建编辑器之前执行用户自定义逻辑（按需清理上一次的 disposables）
    if (monacoOptions.isCleanOnBeforeCreate ?? true) {
      disposals.forEach(d => d.dispose())
      disposals.length = 0
    }
    if (monacoOptions.onBeforeCreate) {
      const ds = monacoOptions.onBeforeCreate(monaco)
      if (ds)
        disposals.push(...ds)
    }

    await setThemeRegisterPromise(registerMonacoThemes(themes, languages))

    const initialThemeName = monacoOptions.theme ?? currentTheme.value
    try {
      monaco.editor.setTheme(initialThemeName)
      lastAppliedTheme = initialThemeName
    }
    catch {
      // ignore
    }

    diffMgr = new DiffEditorManager(
      monacoOptions,
      maxHeightValue,
      maxHeightCSS,
      autoScrollOnUpdate,
      autoScrollInitial,
      autoScrollThresholdPx,
      autoScrollThresholdLines,
      diffAutoScroll,
      monacoOptions.revealDebounceMs,
    )
    diffEditorView = await diffMgr.createDiffEditor(container, originalCode, modifiedCode, language, initialThemeName)

    if (typeof monacoOptions.onThemeChange === 'function') {
      monacoOptions.onThemeChange(initialThemeName as any)
    }
    // 主题监听 - use internal setter so onThemeChange is invoked
    if (!monacoOptions.theme) {
      themeWatcher = watch(
        () => isDark.value,
        () => {
          const t = currentTheme.value
          if (t !== lastAppliedTheme) {
            void setThemeInternal(t)
          }
        },
        { flush: 'post', immediate: true },
      )
    }

    // cache models for getters
    const models = diffMgr.getDiffModels()
    originalModel = models.original
    modifiedModel = models.modified

    return diffEditorView
  }

  // onUnmounted(cleanupEditor)

  // Ensure cleanup stops the watcher
  function cleanupEditor() {
    if (editorMgr) {
      editorMgr.cleanup()
      editorMgr = null
    }
    if (diffMgr) {
      diffMgr.cleanup()
      diffMgr = null
    }
    // cancel rafs and pending updates
    rafScheduler.cancel('update')
    pendingUpdate = null
    // cancel any pending append flushes and clear buffers for single editor
    rafScheduler.cancel('append')
    appendBufferScheduled = false
    appendBuffer.length = 0
    // If an EditorManager was active it already disposed the editor instance.
    // Only dispose the module-level editorView when there is no editorMgr to avoid
    // double-dispose races (which can throw in some Monaco builds).
    if (!editorMgr && editorView) {
      editorView.dispose()
      editorView = null
    }
    lastKnownCode = null
    if (lastContainer) {
      lastContainer.innerHTML = ''
      lastContainer = null
    }
    if (themeWatcher) {
      themeWatcher()
      themeWatcher = null
    }

    // 清理可能由 updateCode 节流产生的延迟 timer
    if (updateThrottleTimer != null) {
      clearTimeout(updateThrottleTimer as unknown as number)
      updateThrottleTimer = null
    }

    // height managers are managed by the respective managers

    // Diff 相关释放由 diffMgr 处理，清空本地引用
    diffEditorView = null
    originalModel = null
    modifiedModel = null
  }

  // 将 updateCode 和 appendCode 提升为闭包内函数，便于相互调用且避免 this 绑定问题
  function appendCode(appendText: string, codeLanguage?: string) {
    if (editorMgr) {
      editorMgr.appendCode(appendText, codeLanguage)
    }
    else {
      if (!editorView)
        return
      const model = editorView.getModel()
      if (!model)
        return
      const processedCodeLanguage = codeLanguage
        ? processedLanguage(codeLanguage)
        : model.getLanguageId()
      if (processedCodeLanguage && model.getLanguageId() !== processedCodeLanguage)
        monaco.editor.setModelLanguage(model, processedCodeLanguage)

      // Fast-path: update lastKnownCode immediately when we can to avoid
      // model.getValue() synchronous reads in later flushes
      if (appendText && lastKnownCode != null) {
        lastKnownCode = lastKnownCode + appendText
      }

      // Buffer-only append for fallback path to match EditorManager behavior
      if (appendText) {
        appendBuffer.push(appendText)
        if (!appendBufferScheduled) {
          appendBufferScheduled = true
          rafScheduler.schedule('append', flushAppendBuffer)
        }
      }
    }
  }

  // 计算前后缀公共部分，并构造最小替换编辑（中间段替换）
  function applyMinimalEdit(prev: string, next: string) {
    if (!editorView)
      return
    const model = editorView.getModel()
    if (!model)
      return
    // Avoid expensive minimal edit on very large documents or huge change ratios
    try {
      const maxChars = minimalEditMaxCharsLocal
      const ratio = minimalEditMaxChangeRatioLocal
      const maxLen = Math.max(prev.length, next.length)
      const changeRatio = maxLen > 0 ? Math.abs(next.length - prev.length) / maxLen : 0
      if (prev.length + next.length > maxChars || changeRatio > ratio) {
        const prevLineCount = model.getLineCount()
        model.setValue(next)
        lastKnownCode = next
        const newLineCount = model.getLineCount()
        if (newLineCount !== prevLineCount) {
          maybeScrollToBottom(newLineCount)
        }
        return
      }
    }
    catch { }

    // 完全相同无需处理
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

    const isReadOnly = editorView.getOption(monaco.editor.EditorOption.readOnly)
    const edit = [{ range, text: replaceText, forceMoveMarkers: true }]
    if (isReadOnly)
      model.applyEdits(edit)
    else editorView.executeEdits('minimal-replace', edit)
  }

  // Diff 模型编辑由 DiffEditorManager 负责

  function flushPendingUpdate() {
    // scheduled via rafScheduler
    if (!pendingUpdate)
      return
    // record flush time for throttling decisions
    lastFlushTime = Date.now()
    if (!editorView)
      return
    const model = editorView.getModel()
    if (!model)
      return
    // pull and clear pending atomically
    const { code: newCode, lang: codeLanguage } = pendingUpdate
    pendingUpdate = null

    // avoid repeated processedLanguage() calls
    const processedCodeLanguage = processedLanguage(codeLanguage)

    // If there are pending append fragments buffered (not yet flushed to the
    // model), prefer the authoritative model value instead of the optimistic
    // `lastKnownCode`. Relying on `lastKnownCode` when the append buffer has
    // unflushed data can lead to duplicated tails because `lastKnownCode` may
    // already include the suffix while the model does not.
    let prevCode: string | null = null
    if (appendBuffer.length > 0) {
      try {
        prevCode = model.getValue()
        lastKnownCode = prevCode
      }
      catch {
        prevCode = ''
      }
    }
    else {
      prevCode = lastKnownCode
      if (prevCode == null) {
        try {
          prevCode = model.getValue()
          lastKnownCode = prevCode
        }
        catch {
          prevCode = ''
        }
      }
    }

    // Short-circuit: identical content -> nothing to do
    if (prevCode === newCode)
      return

    const languageId = model.getLanguageId()

    // If language changes, set language and do full setValue (tokenization mismatch otherwise)
    if (languageId !== processedCodeLanguage) {
      if (processedCodeLanguage)
        monaco.editor.setModelLanguage(model, processedCodeLanguage)
      const prevLineCount = model.getLineCount()
      model.setValue(newCode)
      lastKnownCode = newCode
      const newLineCount = model.getLineCount()
      if (newLineCount !== prevLineCount) {
        maybeScrollToBottom(newLineCount)
      }
      return
    }

    // If this is a pure append (streaming) do a fast-append path
    if (newCode.startsWith(prevCode) && prevCode.length < newCode.length) {
      const suffix = newCode.slice(prevCode.length)
      if (suffix) {
        // apply directly into append buffer to batch with other appends
        appendCode(suffix, codeLanguage)
      }
      lastKnownCode = newCode
      return
    }

    // For large documents or huge change ratio fall back to full replace quickly
    try {
      const maxChars = minimalEditMaxCharsLocal
      const ratio = minimalEditMaxChangeRatioLocal
      const maxLen = Math.max(prevCode.length, newCode.length)
      const changeRatio = maxLen > 0 ? Math.abs(newCode.length - prevCode.length) / maxLen : 0
      if (prevCode.length + newCode.length > maxChars || changeRatio > ratio) {
        const prevLineCount = model.getLineCount()
        model.setValue(newCode)
        lastKnownCode = newCode
        const newLineCount = model.getLineCount()
        if (newLineCount !== prevLineCount) {
          maybeScrollToBottom(newLineCount)
        }
        return
      }
    }
    catch {
      // if the heuristic check throws, fall through to minimal edit attempt
    }

    // 最小替换（computeMinimalEdit）在文档不太大且变更比例合理时才执行
    try {
      applyMinimalEdit(prevCode, newCode)
      lastKnownCode = newCode
      const newLineCount = model.getLineCount()
      const prevLineCount = (prevCode ? prevCode.split('\n').length : 0) || model.getLineCount()
      if (newLineCount !== prevLineCount) {
        maybeScrollToBottom(newLineCount)
      }
    }
    catch {
      // fallback to safe full replace on unexpected errors
      try {
        const prevLineCount = model.getLineCount()
        model.setValue(newCode)
        lastKnownCode = newCode
        const newLineCount = model.getLineCount()
        if (newLineCount !== prevLineCount) {
          maybeScrollToBottom(newLineCount)
        }
      }
      catch {
        // swallow to avoid breaking consumers
      }
    }
  }

  // Flush batched appends for the single editor
  function flushAppendBuffer() {
    if (!editorView)
      return
    if (appendBuffer.length === 0)
      return
    appendBufferScheduled = false
    const model = editorView.getModel()
    if (!model) {
      appendBuffer.length = 0
      return
    }
    const text = appendBuffer.join('')
    appendBuffer.length = 0
    try {
      const lastLine = model.getLineCount()
      const lastColumn = model.getLineMaxColumn(lastLine)
      const range = new monaco.Range(lastLine, lastColumn, lastLine, lastColumn)
      const isReadOnly = editorView.getOption(monaco.editor.EditorOption.readOnly)
      if (isReadOnly) {
        model.applyEdits([{ range, text, forceMoveMarkers: true }])
      }
      else {
        editorView.executeEdits('append', [{ range, text, forceMoveMarkers: true }])
      }
      // update lastKnownCode if present
      if (lastKnownCode != null) {
        lastKnownCode = lastKnownCode + text
      }
      // single reveal/scroll call
      try {
        if (lastLine !== model.getLineCount())
          maybeScrollToBottom(model.getLineCount())
      }
      catch {
        // ignore
      }
    }
    catch {
      // swallow errors to avoid breaking batch loop
    }
  }

  function updateCode(newCode: string, codeLanguage: string) {
    if (editorMgr) {
      editorMgr.updateCode(newCode, codeLanguage)
    }
    else {
      pendingUpdate = { code: newCode, lang: codeLanguage }
      // RAF 合并 + 可选时间节流：
      // - 如果 updateThrottleMs === 0，则保持原有行为（每帧 flush）
      // - 否则确保距离上次实际 flush 至少为 updateThrottleMs，否则用 setTimeout 延迟触发
      rafScheduler.schedule('update', () => {
        if (!updateThrottleMs) {
          flushPendingUpdate()
          return
        }
        const now = Date.now()
        const since = now - lastFlushTime
        if (since >= updateThrottleMs) {
          flushPendingUpdate()
          return
        }
        // Already have a pending throttle timer: do nothing
        if (updateThrottleTimer != null)
          return
        const wait = updateThrottleMs - since
        updateThrottleTimer = (setTimeout(() => {
          updateThrottleTimer = null
          // use raf again to preserve batching semantics
          rafScheduler.schedule('update', () => flushPendingUpdate())
        }, wait) as unknown) as number
      })
    }
  }

  // Runtime control: allow changing throttle at runtime
  function setUpdateThrottleMs(ms: number) {
    updateThrottleMs = ms
  }

  function getUpdateThrottleMs() {
    return updateThrottleMs
  }

  // Diff RAF 更新由 DiffEditorManager 负责

  // Diff 追加批处理由 DiffEditorManager 负责

  // 更新 Diff（合并同帧，增量写入）
  function updateDiff(originalCode: string, modifiedCode: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.updateDiff(originalCode, modifiedCode, codeLanguage)
  }

  // 分别更新 original/modified（即时增量）
  function updateOriginal(newCode: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.updateOriginal(newCode, codeLanguage)
  }

  function updateModified(newCode: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.updateModified(newCode, codeLanguage)
  }

  // 显式在 Diff 的 original 末尾追加
  function appendOriginal(appendText: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.appendOriginal(appendText, codeLanguage)
  }

  // 显式在 Diff 的 modified 末尾追加，并在需要时滚动
  function appendModified(appendText: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.appendModified(appendText, codeLanguage)
  }

  return {
    createEditor,
    createDiffEditor,
    cleanupEditor,
    safeClean() {
      // cancel any pending rafs and pending payloads
      rafScheduler.cancel('update')
      pendingUpdate = null
      // diff raf queues are managed by diffMgr

      // 单编辑器由管理器处理临时清理
      if (editorMgr) {
        try {
          editorMgr.safeClean()
        }
        catch { }
      }
      // Diff 编辑器临时清理
      if (diffMgr) {
        try {
          diffMgr.safeClean()
        }
        catch { }
      }
      // reset transient scroll-related state so next stream starts clean
      _hasScrollBar = false
      shouldAutoScroll = !!autoScrollInitial

      // height managers are managed by the respective managers
    },
    updateCode,
    appendCode,
    updateDiff,
    updateOriginal,
    updateModified,
    appendOriginal,
    appendModified,
    setTheme: setThemeInternal,
    setLanguage(language: MonacoLanguage) {
      if (editorMgr) {
        editorMgr.setLanguage(language, languages as any)
        return
      }
      if (diffMgr) {
        diffMgr.setLanguage(language, languages as any)
        return
      }
      if (languages.includes(language)) {
        if (editorView) {
          const model = editorView.getModel()
          if (model && model.getLanguageId() !== language)
            monaco.editor.setModelLanguage(model, language)
        }
        if (originalModel && originalModel.getLanguageId() !== language)
          monaco.editor.setModelLanguage(originalModel, language)
        if (modifiedModel && modifiedModel.getLanguageId() !== language)
          monaco.editor.setModelLanguage(modifiedModel, language)
      }
      else {
        console.warn(`Language "${language}" is not registered. Available languages: ${languages.join(', ')}`)
      }
    },
    getCurrentTheme() {
      return currentTheme.value
    },
    getEditor() {
      return monaco.editor
    },
    getEditorView() {
      return editorView
    },
    // 新增导出：获取 Diff Editor
    getDiffEditorView() {
      return diffEditorView
    },
    // 新增导出：获取 Diff 两侧模型
    getDiffModels() {
      return { original: originalModel, modified: modifiedModel }
    },
    getMonacoInstance() {
      return monaco
    },
    // Runtime throttle control
    setUpdateThrottleMs,
    getUpdateThrottleMs,
    // 获取当前编辑器中的代码
    getCode() {
      // 如果是普通编辑器
      if (editorView) {
        try {
          return editorView.getModel()?.getValue() ?? null
        }
        catch {
          return null
        }
      }
      // 如果是 Diff 编辑器
      if (diffEditorView || (originalModel && modifiedModel)) {
        try {
          const original = originalModel?.getValue() ?? ''
          const modified = modifiedModel?.getValue() ?? ''
          return { original, modified }
        }
        catch {
          return null
        }
      }
      return null
    },
  }
}

export { clearHighlighterCache, defaultRevealDebounceMs, detectLanguage, getOrCreateHighlighter, isDark, preloadMonacoWorkers, registerMonacoThemes, useMonaco }

export * from './type'
