import type {
  DiffModelPair,
  DiffModelTransitionOptions,
  MonacoLanguage,
  MonacoOptions,
  MonacoTheme,
  UseMonacoReturn,
} from './type'

import { detectLanguage } from './code.detect'
import {
  defaultLanguages,
  defaultRevealDebounceMs,
  defaultThemes,
} from './constant'
import { DiffEditorManager } from './core/DiffEditorManager'
import { EditorManager } from './core/EditorManager'
import * as monaco from './monaco-shim'
import { computed } from './reactivity'
import {
  clearHighlighterCache,
  getOrCreateHighlighter,
  registerMonacoThemes,
} from './utils/registerMonacoThemes'

// Monaco theme is effectively global within a runtime (monaco.editor.setTheme).
// When many code blocks mount/virtualize concurrently, some editors may be
// created after a theme switch and miss the per-instance setTheme call.
// Keep a module-level "last requested theme" so late-created editors can
// initialize with the latest theme instead of falling back to themes[0].
let globalRequestedThemeName: string | null = null
let globalThemeRequestSeq = 0
// Best-effort tracking of what this library last applied via monaco.editor.setTheme.
// This must be module-level because Monaco theme is global, while useMonaco() is per-instance.
let globalAppliedThemeName: string | null = null

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
 *   setDiffModels: (models: DiffModelPair, options?: DiffModelTransitionOptions) => Promise<void>,
 *   setTheme: (theme: MonacoTheme) => Promise<void>,
 *   refreshDiffPresentation: () => void,
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
 * @property {Function} setDiffModels - 切换为一对新的 Diff models；当内容未变化时自动走保留视图状态的无抖动路径
 * @property {Function} setTheme - 切换编辑器主题，返回 Promise，在主题应用完成时 resolve
 * @property {Function} refreshDiffPresentation - 在不 remount 的情况下，重算 diff chrome / unchanged overlay 的表现层
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
function useMonaco(monacoOptions: MonacoOptions = {}): UseMonacoReturn {
  // per-instance disposables (avoid cross-instance interference)
  const disposals: monaco.IDisposable[] = []
  const pendingCreateDisposables = new Map<number, monaco.IDisposable[]>()
  let editorView: monaco.editor.IStandaloneCodeEditor | null = null
  let editorMgr: EditorManager | null = null
  let diffEditorView: monaco.editor.IStandaloneDiffEditor | null = null
  let diffMgr: DiffEditorManager | null = null
  let originalModel: monaco.editor.ITextModel | null = null
  let modifiedModel: monaco.editor.ITextModel | null = null

  const themes
    = monacoOptions.themes && monacoOptions.themes?.length
      ? monacoOptions.themes
      : defaultThemes
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
  let createRequestSeq = 0
  let activeCreateRequestId: number | null = null
  let activeCreateKind: 'editor' | 'diff' | null = null
  let queuedEditorUpdateDuringCreate: {
    requestId: number
    code: string
    lang: string
  } | null = null
  const currentTheme = computed<string>(
    () =>
      monacoOptions.theme
      ?? (typeof themes[0] === 'string' ? themes[0] : (themes[0] as any).name),
  )
  // Track the latest theme requested via setTheme(). This prevents the
  // initialization path (which otherwise falls back to `themes[0]`) from
  // overwriting a theme chosen before createEditor/createDiffEditor runs.
  let requestedThemeName: string | null
    = monacoOptions.theme ?? globalRequestedThemeName ?? currentTheme.value

  // Internal helper that applies a theme and invokes MonacoOptions.onThemeChange
  // after the theme has been applied. Exposed internally so watchers can call
  // the same logic and callers can await exported setTheme for completion.
  async function tryLoadAndSetShikiTheme(highlighter: any, themeName: string) {
    if (!highlighter || typeof highlighter.setTheme !== 'function')
      return

    try {
      await highlighter.setTheme(themeName)
    }
    catch (err: any) {
      const message = err?.message ? String(err.message) : String(err)
      // Shiki throws: "Theme <name> not found, you may need to load it first"
      // If the highlighter supports incremental loading, attempt it once.
      const lower = message.toLowerCase()
      const looksLikeMissingThemeError
        = lower.includes('theme') && lower.includes('not found')
      if (
        typeof highlighter.loadTheme === 'function'
        && looksLikeMissingThemeError
      ) {
        await highlighter.loadTheme(themeName)
        await highlighter.setTheme(themeName)
        return
      }
      throw err
    }
  }

  async function setThemeInternal(
    theme: MonacoTheme,
    force = false,
  ): Promise<void> {
    const themeName = typeof theme === 'string' ? theme : (theme as any).name

    globalThemeRequestSeq += 1
    const token = globalThemeRequestSeq

    // Persist the user's intent so editor initialization won't override it.
    requestedThemeName = themeName
    globalRequestedThemeName = themeName

    // Monaco theme is global. Per-instance globalAppliedThemeName can become stale
    // when another useMonaco() instance changes the theme.
    if (!force && themeName === globalAppliedThemeName) {
      return
    }

    // Last-write-wins: if another setTheme() call happened after this one
    // started, abort before doing any further work.
    if (token !== globalThemeRequestSeq) {
      return
    }

    await registerMonacoThemes(themes, languages).catch(() => undefined)

    if (token !== globalThemeRequestSeq) {
      return
    }

    const availableNames = themes.map(t =>
      typeof t === 'string' ? t : (t as any).name,
    )
    if (!availableNames.includes(themeName)) {
      try {
        const extended = availableNames.concat(themeName)
        const maybeHighlighter = await registerMonacoThemes(
          extended as any,
          languages,
        )
        await tryLoadAndSetShikiTheme(maybeHighlighter, themeName).catch(
          () => undefined,
        )
      }
      catch {
        console.warn(
          `Theme "${themeName}" is not registered and automatic registration failed. Available themes: ${availableNames.join(
            ', ',
          )}`,
        )
        return
      }
    }

    if (token !== globalThemeRequestSeq) {
      return
    }

    try {
      monaco.editor.setTheme(themeName)
      globalAppliedThemeName = themeName
      monacoOptions.theme = themeName as any
    }
    catch {
      try {
        const maybeHighlighter = await registerMonacoThemes(themes, languages)
        if (token !== globalThemeRequestSeq) {
          return
        }
        monaco.editor.setTheme(themeName)
        globalAppliedThemeName = themeName
        monacoOptions.theme = themeName as any
        await tryLoadAndSetShikiTheme(maybeHighlighter, themeName).catch(
          () => undefined,
        )
      }
      catch (err2) {
        console.warn(`Failed to set theme "${themeName}":`, err2)
        return
      }
    }

    if (token !== globalThemeRequestSeq) {
      return
    }

    try {
      diffMgr?.notifyThemeChange(themeName as any)
    }
    catch (err) {
      console.warn('diff theme sync threw an error:', err)
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

  async function ensureThemeRegistered(themeName: string) {
    const availableNames = themes.map(t =>
      typeof t === 'string' ? t : (t as any).name,
    )
    const list = availableNames.includes(themeName)
      ? themes
      : (themes.concat(themeName) as any)
    await registerMonacoThemes(list as any, languages)
  }

  function resolveRequestedThemeName() {
    return (
      requestedThemeName
      ?? globalRequestedThemeName
      ?? monacoOptions.theme
      ?? currentTheme.value
    )
  }

  function commitAppliedTheme(themeName: string) {
    requestedThemeName = themeName
    globalRequestedThemeName = themeName
    globalAppliedThemeName = themeName
    monacoOptions.theme = themeName as any
  }

  async function notifyThemeApplied(themeName: string) {
    if (typeof monacoOptions.onThemeChange !== 'function')
      return
    try {
      await monacoOptions.onThemeChange(themeName as any)
    }
    catch (err) {
      console.warn('onThemeChange callback threw an error:', err)
    }
  }

  function disposeDisposables(
    items: monaco.IDisposable[] | null | undefined,
  ) {
    if (!items?.length)
      return
    for (const item of items) {
      try {
        item.dispose()
      }
      catch {}
    }
  }

  function takePendingCreateDisposables(requestId: number) {
    const items = pendingCreateDisposables.get(requestId) ?? []
    pendingCreateDisposables.delete(requestId)
    return items
  }

  function disposeAllPendingCreateDisposables() {
    for (const requestId of Array.from(pendingCreateDisposables.keys())) {
      disposeDisposables(takePendingCreateDisposables(requestId))
    }
  }

  function cleanupInstances() {
    if (editorMgr) {
      editorMgr.cleanup()
      editorMgr = null
    }
    else if (editorView) {
      try {
        editorView.dispose()
      }
      catch {}
    }

    if (diffMgr) {
      diffMgr.cleanup()
      diffMgr = null
    }
    else {
      try {
        diffEditorView?.dispose()
      }
      catch {}
      try {
        originalModel?.dispose()
      }
      catch {}
      try {
        modifiedModel?.dispose()
      }
      catch {}
    }

    editorView = null
    diffEditorView = null
    originalModel = null
    modifiedModel = null
  }

  function createSupersededError() {
    const err = new Error('Editor creation was superseded')
    ;(err as any).name = 'AbortError'
    ;(err as any).code = 'STREAM_MONACO_CREATE_SUPERSEDED'
    return err
  }

  function isCreateActive(
    requestId: number,
    kind: 'editor' | 'diff',
  ) {
    return (
      activeCreateRequestId === requestId
      && activeCreateKind === kind
    )
  }

  function assertCreateStillActive(
    requestId: number,
    kind: 'editor' | 'diff',
  ) {
    if (!isCreateActive(requestId, kind)) {
      throw createSupersededError()
    }
  }

  function cancelPendingCreates() {
    activeCreateRequestId = null
    activeCreateKind = null
    queuedEditorUpdateDuringCreate = null
    disposeAllPendingCreateDisposables()
  }

  async function resolveCreateThemeName(
    requestId: number,
    kind: 'editor' | 'diff',
  ) {
    let themeName = resolveRequestedThemeName()
    while (true) {
      assertCreateStillActive(requestId, kind)
      await ensureThemeRegistered(themeName)
      assertCreateStillActive(requestId, kind)
      const latestThemeName = resolveRequestedThemeName()
      if (latestThemeName === themeName)
        return themeName
      themeName = latestThemeName
    }
  }

  async function createEditor(
    container: HTMLElement,
    code: string,
    language: string,
  ) {
    cancelPendingCreates()
    cleanupInstances()

    const requestId = ++createRequestSeq
    activeCreateRequestId = requestId
    activeCreateKind = 'editor'

    if (monacoOptions.isCleanOnBeforeCreate ?? true) {
      disposeDisposables(disposals.splice(0))
    }

    const requestDisposables = monacoOptions.onBeforeCreate?.(monaco) ?? []
    if (requestDisposables.length) {
      pendingCreateDisposables.set(requestId, requestDisposables)
    }

    let nextEditorMgr: EditorManager | null = null

    try {
      const initialThemeName = await resolveCreateThemeName(requestId, 'editor')
      nextEditorMgr = new EditorManager(
        monacoOptions,
        maxHeightValue,
        maxHeightCSS,
        autoScrollOnUpdate,
        autoScrollInitial,
        autoScrollThresholdPx,
        autoScrollThresholdLines,
        monacoOptions.revealDebounceMs,
        monacoOptions.updateThrottleMs,
      )
      const nextEditorView = await nextEditorMgr.createEditor(
        container,
        code,
        language,
        initialThemeName,
      )

      assertCreateStillActive(requestId, 'editor')

      editorMgr = nextEditorMgr
      editorView = nextEditorView
      diffMgr = null
      diffEditorView = null
      originalModel = null
      modifiedModel = null
      commitAppliedTheme(initialThemeName)

      const committedDisposables = takePendingCreateDisposables(requestId)
      if (committedDisposables.length) {
        disposals.push(...committedDisposables)
      }

      activeCreateRequestId = null
      activeCreateKind = null

      const queuedUpdate = queuedEditorUpdateDuringCreate
      if (queuedUpdate?.requestId === requestId) {
        queuedEditorUpdateDuringCreate = null
        editorMgr.updateCode(queuedUpdate.code, queuedUpdate.lang)
      }

      await notifyThemeApplied(initialThemeName)
      return nextEditorView
    }
    catch (error) {
      if (nextEditorMgr) {
        try {
          nextEditorMgr.cleanup()
        }
        catch {}
      }
      disposeDisposables(takePendingCreateDisposables(requestId))
      if (activeCreateRequestId === requestId) {
        activeCreateRequestId = null
        activeCreateKind = null
        queuedEditorUpdateDuringCreate = null
      }
      throw error
    }
  }

  async function createDiffEditor(
    container: HTMLElement,
    originalCode: string,
    modifiedCode: string,
    language: string,
  ) {
    cancelPendingCreates()
    cleanupInstances()

    const requestId = ++createRequestSeq
    activeCreateRequestId = requestId
    activeCreateKind = 'diff'

    if (monacoOptions.isCleanOnBeforeCreate ?? true) {
      disposeDisposables(disposals.splice(0))
    }

    const requestDisposables = monacoOptions.onBeforeCreate?.(monaco) ?? []
    if (requestDisposables.length) {
      pendingCreateDisposables.set(requestId, requestDisposables)
    }

    let nextDiffMgr: DiffEditorManager | null = null

    try {
      const initialThemeName = await resolveCreateThemeName(requestId, 'diff')
      nextDiffMgr = new DiffEditorManager(
        monacoOptions,
        maxHeightValue,
        maxHeightCSS,
        autoScrollOnUpdate,
        autoScrollInitial,
        autoScrollThresholdPx,
        autoScrollThresholdLines,
        diffAutoScroll,
        monacoOptions.revealDebounceMs,
        monacoOptions.diffUpdateThrottleMs,
      )
      const nextDiffEditorView = await nextDiffMgr.createDiffEditor(
        container,
        originalCode,
        modifiedCode,
        language,
        initialThemeName,
      )

      assertCreateStillActive(requestId, 'diff')

      diffMgr = nextDiffMgr
      diffEditorView = nextDiffEditorView
      editorMgr = null
      editorView = null
      const models = diffMgr.getDiffModels()
      originalModel = models.original
      modifiedModel = models.modified
      commitAppliedTheme(initialThemeName)

      const committedDisposables = takePendingCreateDisposables(requestId)
      if (committedDisposables.length) {
        disposals.push(...committedDisposables)
      }

      activeCreateRequestId = null
      activeCreateKind = null

      await notifyThemeApplied(initialThemeName)
      return nextDiffEditorView
    }
    catch (error) {
      if (nextDiffMgr) {
        try {
          nextDiffMgr.cleanup()
        }
        catch {}
      }
      disposeDisposables(takePendingCreateDisposables(requestId))
      if (activeCreateRequestId === requestId) {
        activeCreateRequestId = null
        activeCreateKind = null
      }
      throw error
    }
  }

  function cleanupEditor() {
    cancelPendingCreates()
    cleanupInstances()
    disposeDisposables(disposals.splice(0))
  }

  function appendCode(appendText: string, codeLanguage?: string) {
    if (editorMgr) {
      editorMgr.appendCode(appendText, codeLanguage)
    }
  }

  function updateCode(newCode: string, codeLanguage: string) {
    if (editorMgr) {
      editorMgr.updateCode(newCode, codeLanguage)
      return
    }
    if (activeCreateRequestId != null && activeCreateKind === 'editor') {
      queuedEditorUpdateDuringCreate = {
        requestId: activeCreateRequestId,
        code: newCode,
        lang: codeLanguage,
      }
    }
  }

  function setUpdateThrottleMs(ms: number) {
    monacoOptions.updateThrottleMs = ms
    editorMgr?.setUpdateThrottleMs(ms)
  }

  function getUpdateThrottleMs() {
    return editorMgr?.getUpdateThrottleMs() ?? monacoOptions.updateThrottleMs ?? 50
  }

  function updateDiff(
    originalCode: string,
    modifiedCode: string,
    codeLanguage?: string,
  ) {
    if (diffMgr)
      diffMgr.updateDiff(originalCode, modifiedCode, codeLanguage)
  }

  function updateOriginal(newCode: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.updateOriginal(newCode, codeLanguage)
  }

  function updateModified(newCode: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.updateModified(newCode, codeLanguage)
  }

  function appendOriginal(appendText: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.appendOriginal(appendText, codeLanguage)
  }

  function appendModified(appendText: string, codeLanguage?: string) {
    if (diffMgr)
      diffMgr.appendModified(appendText, codeLanguage)
  }

  async function setDiffModels(
    models: DiffModelPair,
    options?: DiffModelTransitionOptions,
  ) {
    if (!diffMgr)
      return
    await diffMgr.setDiffModels(models, options)
    const activeModels = diffMgr.getDiffModels()
    originalModel = activeModels.original
    modifiedModel = activeModels.modified
  }

  function refreshDiffPresentation() {
    if (diffMgr)
      diffMgr.refreshDiffPresentation()
  }

  return {
    createEditor,
    createDiffEditor,
    cleanupEditor,
    safeClean() {
      if (editorMgr) {
        try {
          editorMgr.safeClean()
        }
        catch {}
      }
      if (diffMgr) {
        try {
          diffMgr.safeClean()
        }
        catch {}
      }
    },
    updateCode,
    appendCode,
    updateDiff,
    updateOriginal,
    updateModified,
    appendOriginal,
    appendModified,
    setDiffModels,
    setTheme: setThemeInternal,
    refreshDiffPresentation,
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
        console.warn(
          `Language "${language}" is not registered. Available languages: ${languages.join(
            ', ',
          )}`,
        )
      }
    },
    getCurrentTheme() {
      return (
        globalAppliedThemeName
        ?? requestedThemeName
        ?? globalRequestedThemeName
        ?? currentTheme.value
      )
    },
    getEditor() {
      return monaco.editor
    },
    getEditorView() {
      return editorMgr?.getEditorView() ?? editorView
    },
    getDiffEditorView() {
      return diffMgr?.getDiffEditorView() ?? diffEditorView
    },
    getDiffModels() {
      if (diffMgr)
        return diffMgr.getDiffModels()
      return { original: originalModel, modified: modifiedModel }
    },
    getMonacoInstance() {
      return monaco
    },
    setUpdateThrottleMs,
    getUpdateThrottleMs,
    getCode() {
      if (editorMgr)
        return editorMgr.getCode()
      if (editorView) {
        try {
          return editorView.getModel()?.getValue() ?? null
        }
        catch {
          return null
        }
      }
      const diffModels = diffMgr?.getDiffModels() ?? {
        original: originalModel,
        modified: modifiedModel,
      }
      if (diffEditorView || (diffModels.original && diffModels.modified)) {
        try {
          return {
            original: diffModels.original?.getValue() ?? '',
            modified: diffModels.modified?.getValue() ?? '',
          }
        }
        catch {
          return null
        }
      }
      return null
    },
  }
}

export {
  clearHighlighterCache,
  defaultRevealDebounceMs,
  detectLanguage,
  getOrCreateHighlighter,
  registerMonacoThemes,
  useMonaco,
}

export * from './type'
