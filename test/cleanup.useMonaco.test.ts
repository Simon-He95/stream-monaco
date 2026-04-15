import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function loadUseMonacoHarness(options: Record<string, any> = {}) {
  vi.resetModules()

  const registerCalls: Array<{
    themes: any
    languages: any
    deferred: ReturnType<typeof deferred>
  }> = []
  const editorManagers: any[] = []
  const diffManagers: any[] = []

  vi.doMock('../src/utils/registerMonacoThemes', () => {
    return {
      registerMonacoThemes: vi.fn((themes: any, languages: any) => {
        const call = {
          themes,
          languages,
          deferred: deferred(),
        }
        registerCalls.push(call)
        return call.deferred.promise
      }),
      clearHighlighterCache: vi.fn(),
      getOrCreateHighlighter: vi.fn(),
    }
  })

  vi.doMock('../src/core/EditorManager', () => {
    return {
      EditorManager: class {
        cleanup = vi.fn()
        safeClean = vi.fn()
        appendCode = vi.fn((appendText: string) => {
          this.code += appendText
        })
        updateCode = vi.fn((code: string) => {
          this.code = code
        })
        setLanguage = vi.fn()
        code = ''
        throttleMs = 50
        editorView = {
          dispose: vi.fn(),
          getModel: vi.fn(() => ({
            getValue: () => this.code,
            getLanguageId: () => 'javascript',
          })),
        }
        createEditor = vi.fn(async (
          _container: HTMLElement,
          code: string,
          _language: string,
          _theme: string,
        ) => {
          this.code = code
          return this.editorView
        })

        constructor(...args: any[]) {
          this.throttleMs = args[8] ?? 50
          editorManagers.push(this)
        }

        getEditorView() {
          return this.editorView
        }

        getCode() {
          return this.code
        }

        setUpdateThrottleMs(ms: number) {
          this.throttleMs = ms
        }

        getUpdateThrottleMs() {
          return this.throttleMs
        }
      },
    }
  })

  vi.doMock('../src/core/DiffEditorManager', () => {
    return {
      DiffEditorManager: class {
        cleanup = vi.fn()
        safeClean = vi.fn()
        notifyThemeChange = vi.fn()
        updateDiff = vi.fn()
        updateOriginal = vi.fn()
        updateModified = vi.fn()
        appendOriginal = vi.fn()
        appendModified = vi.fn()
        refreshDiffPresentation = vi.fn()
        setLanguage = vi.fn()
        diffEditorView = { dispose: vi.fn() }
        models = { original: null, modified: null }
        createDiffEditor = vi.fn(async () => this.diffEditorView)

        constructor() {
          diffManagers.push(this)
        }

        getDiffEditorView() {
          return this.diffEditorView
        }

        getDiffModels() {
          return this.models
        }

        async setDiffModels(models: any) {
          this.models = models
        }
      },
    }
  })

  vi.doMock('../src/monaco-shim', () => {
    const setTheme = vi.fn()
    const setModelLanguage = vi.fn()
    const editor = {
      setTheme,
      setModelLanguage,
      EditorOption: { lineHeight: 16 },
      ScrollType: { Smooth: 1 },
    }
    const languages = {
      getLanguages: () => [{ id: 'javascript' }],
      register: vi.fn(),
    }
    const Range = class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    }
    return {
      default: { editor, languages, Range, ScrollType: { Smooth: 1 } },
      editor,
      languages,
      Range,
      ScrollType: { Smooth: 1 },
    }
  })

  const base = await import('../src/index.base')
  const monaco = await import('../src/monaco-shim')

  const api = base.useMonaco({
    themes: ['vitesse-dark', 'vitesse-light'],
    languages: ['javascript'],
    ...options,
  })

  return {
    api,
    monaco,
    registerCalls,
    editorManagers,
    diffManagers,
  }
}

describe('useMonaco create lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('replays the latest queued update after createEditor commits', async () => {
    const { api, registerCalls, editorManagers } = await loadUseMonacoHarness()
    const container = {} as HTMLElement

    const createPromise = api.createEditor(container, 'initial', 'javascript')
    expect(registerCalls).toHaveLength(1)

    api.updateCode('queued', 'javascript')

    registerCalls[0].deferred.resolve(null)
    await createPromise

    expect(editorManagers).toHaveLength(1)
    expect(editorManagers[0].updateCode).toHaveBeenCalledWith('queued', 'javascript')
  })

  it('rejects superseded createEditor requests and disposes request-local resources', async () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    let beforeCreateCount = 0

    const { api, registerCalls } = await loadUseMonacoHarness({
      onBeforeCreate: () => {
        beforeCreateCount += 1
        return [{ dispose: beforeCreateCount === 1 ? firstDispose : secondDispose }]
      },
    })

    const firstPromise = api.createEditor({} as HTMLElement, 'first', 'javascript')
    expect(registerCalls).toHaveLength(1)

    const secondPromise = api.createEditor({} as HTMLElement, 'second', 'javascript')
    expect(registerCalls).toHaveLength(2)
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).not.toHaveBeenCalled()

    registerCalls[1].deferred.resolve(null)
    await secondPromise

    registerCalls[0].deferred.resolve(null)
    await expect(firstPromise).rejects.toMatchObject({
      message: 'Editor creation was superseded',
      code: 'STREAM_MONACO_CREATE_SUPERSEDED',
    })

    expect(secondDispose).not.toHaveBeenCalled()
  })

  it('cleanupEditor cancels an in-flight create and disposes pending resources', async () => {
    const dispose = vi.fn()
    const { api, registerCalls, editorManagers } = await loadUseMonacoHarness({
      onBeforeCreate: () => [{ dispose }],
    })

    const createPromise = api.createEditor({} as HTMLElement, 'code', 'javascript')
    expect(registerCalls).toHaveLength(1)

    api.cleanupEditor()

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(editorManagers).toHaveLength(0)

    registerCalls[0].deferred.resolve(null)
    await expect(createPromise).rejects.toMatchObject({
      message: 'Editor creation was superseded',
      code: 'STREAM_MONACO_CREATE_SUPERSEDED',
    })
  })

  it('stabilizes createEditor on the latest requested theme during registration', async () => {
    const { api, registerCalls, editorManagers } = await loadUseMonacoHarness()
    const container = {} as HTMLElement

    const createPromise = api.createEditor(container, 'code', 'javascript')
    expect(registerCalls).toHaveLength(1)

    const setThemePromise = api.setTheme('vitesse-light')
    expect(registerCalls).toHaveLength(2)

    registerCalls[0].deferred.resolve(null)
    for (let i = 0; i < 5 && registerCalls.length < 3; i++) {
      await Promise.resolve()
    }

    expect(registerCalls).toHaveLength(3)

    registerCalls[1].deferred.resolve(null)
    registerCalls[2].deferred.resolve(null)

    await Promise.all([createPromise, setThemePromise])

    expect(editorManagers).toHaveLength(1)
    expect(editorManagers[0].createEditor).toHaveBeenCalledWith(
      container,
      'code',
      'javascript',
      'vitesse-light',
    )
  })

  it('safeClean does not cancel an in-flight create and cleanupEditor disposes committed resources', async () => {
    const dispose = vi.fn()
    const { api, registerCalls, editorManagers } = await loadUseMonacoHarness({
      onBeforeCreate: () => [{ dispose }],
    })

    const createPromise = api.createEditor({} as HTMLElement, 'code', 'javascript')
    expect(registerCalls).toHaveLength(1)

    api.safeClean()
    expect(dispose).not.toHaveBeenCalled()

    registerCalls[0].deferred.resolve(null)
    await createPromise

    expect(editorManagers).toHaveLength(1)
    expect(editorManagers[0].safeClean).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()

    api.safeClean()
    expect(editorManagers[0].safeClean).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()

    api.cleanupEditor()
    expect(editorManagers[0].cleanup).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
