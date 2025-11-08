import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// This file validates the module-level fallback cleanup path in useMonaco:
// it asserts that timers/raf kinds are cancelled and that queued theme
// microtasks become no-ops after cleanup. The Monaco, manager, and RAF layers
// are fully mocked, so the tests do not cover real RAF timing, DOM updates,
// append buffer flushing, or actual Monaco disposal behaviors.

interface MockScheduler {
  callbacks: Map<string, FrameRequestCallback>
  cancel: ReturnType<typeof vi.fn>
}

const rafInstances: MockScheduler[] = []

function createScheduler(): MockScheduler {
  const callbacks = new Map<string, FrameRequestCallback>()
  const cancel = vi.fn((kind: string) => {
    callbacks.delete(kind)
  })
  return {
    callbacks,
    cancel,
    schedule(kind: string, cb: FrameRequestCallback) {
      callbacks.set(kind, cb)
    },
  } as MockScheduler & { schedule: (kind: string, cb: FrameRequestCallback) => void }
}

vi.mock('../src/utils/raf', () => {
  return {
    createRafScheduler: vi.fn(() => {
      const scheduler = createScheduler()
      // expose schedule method on returned object
      const api = {
        schedule(kind: string, cb: FrameRequestCallback) {
          scheduler.callbacks.set(kind, cb)
        },
        cancel: scheduler.cancel,
        callbacks: scheduler.callbacks,
      }
      rafInstances.push(api)
      return api
    }),
  }
})

vi.mock('../src/utils/registerMonacoThemes', () => {
  let currentPromise: Promise<any> | null = null
  return {
    registerMonacoThemes: vi.fn(async () => null),
    clearHighlighterCache: vi.fn(),
    getOrCreateHighlighter: vi.fn(),
    getThemeRegisterPromise: vi.fn(() => currentPromise),
    setThemeRegisterPromise: vi.fn((p: Promise<any> | null) => {
      currentPromise = p
      return currentPromise
    }),
  }
})

function createStubEditor() {
  const model = {
    getValue: vi.fn(() => ''),
    getLineCount: vi.fn(() => 1),
    setValue: vi.fn(),
    getLineMaxColumn: vi.fn(() => 1),
    getLanguageId: vi.fn(() => 'javascript'),
    applyEdits: vi.fn(),
  }
  return {
    dispose: vi.fn(),
    getValue: vi.fn(() => model.getValue()),
    getModel: vi.fn(() => model),
    getOption: vi.fn(() => 16),
    onDidContentSizeChange: vi.fn(),
    onDidChangeModelContent: vi.fn(),
    revealLineInCenterIfOutsideViewport: vi.fn(),
    revealLine: vi.fn(),
    executeEdits: vi.fn(),
    getScrollTop: vi.fn(() => 0),
    getScrollHeight: vi.fn(() => 0),
    getLayoutInfo: vi.fn(() => ({ height: 0 })),
    getValueLength: vi.fn(() => 0),
  }
}

vi.mock('../src/core/EditorManager', () => {
  return {
    EditorManager: class {
      cleanup = vi.fn()
      safeClean = vi.fn()
      appendCode = vi.fn()
      updateCode = vi.fn()
      setLanguage = vi.fn()
      async createEditor() {
        return createStubEditor()
      }
    },
  }
})

vi.mock('../src/core/DiffEditorManager', () => {
  return {
    DiffEditorManager: class {
      cleanup = vi.fn()
      safeClean = vi.fn()
      appendOriginal = vi.fn()
      appendModified = vi.fn()
      updateDiff = vi.fn()
      updateOriginal = vi.fn()
      updateModified = vi.fn()
      setLanguage = vi.fn()
      async createDiffEditor() {
        return {
          dispose: vi.fn(),
          getModifiedEditor: () => createStubEditor(),
          getOriginalEditor: () => createStubEditor(),
          setModel: vi.fn(),
        }
      }
      getDiffModels() {
        return { original: null, modified: null }
      }
    },
  }
})

vi.mock('../src/monaco-shim', () => {
  const setTheme = vi.fn()
  const editor = {
    setTheme,
    create: vi.fn(() => createStubEditor()),
    createDiffEditor: vi.fn(() => ({
      dispose: vi.fn(),
      getModifiedEditor: () => createStubEditor(),
      getOriginalEditor: () => createStubEditor(),
      setModel: vi.fn(),
    })),
    createModel: vi.fn(() => ({
      dispose: vi.fn(),
      getValue: vi.fn(() => ''),
      setValue: vi.fn(),
      getLineCount: vi.fn(() => 1),
      getLanguageId: vi.fn(() => 'javascript'),
    })),
    setModelLanguage: vi.fn(),
    EditorOption: { lineHeight: 16 },
    ScrollType: { Smooth: 1 },
  }
  const languages = {
    getLanguages: () => [{ id: 'javascript' }],
    register: vi.fn(),
  }
  const Range = class { constructor(
    public lineNumber: number,
    public column: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {} }
  const monaco = { editor, languages, Range, ScrollType: { Smooth: 1 } }
  return { default: monaco, editor, languages, Range, ScrollType: { Smooth: 1 } }
})

function getScheduler() {
  const inst = rafInstances.at(-1)
  if (!inst)
    throw new Error('No raf scheduler captured')
  return inst
}

async function createMonacoAPI(options: Record<string, any> = {}) {
  const mod = await import('../src/index')
  return mod.useMonaco({
    themes: ['vitesse-dark', 'vitesse-light'],
    languages: ['javascript'],
    ...options,
  })
}

function flushRaf(kind: string) {
  const inst = getScheduler()
  const cb = inst.callbacks.get(kind)
  if (cb)
    cb(0 as any)
}

function createContainer(): HTMLElement {
  return {
    style: { overflow: '', maxHeight: '' },
    innerHTML: '',
  } as unknown as HTMLElement
}

describe('useMonaco fallback cleanup', () => {
  beforeEach(() => {
    rafInstances.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rafInstances.length = 0
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('safeClean clears pending fallback timers and reveal rafs', async () => {
    const api = await createMonacoAPI({ updateThrottleMs: 50 })
    api.updateCode('console.log(1)', 'javascript')
    flushRaf('update')
    api.updateCode('console.log(2)', 'javascript')
    flushRaf('update')
    expect(vi.getTimerCount()).toBe(1)

    api.safeClean()

    const scheduler = getScheduler()
    expect(scheduler.cancel).toHaveBeenCalledWith('reveal')
    expect(scheduler.cancel).toHaveBeenCalledWith('append')
    expect(scheduler.cancel).toHaveBeenCalledWith('update')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleanupEditor cancels fallback reveal rafs and throttled flushes', async () => {
    const api = await createMonacoAPI({ updateThrottleMs: 50 })
    api.updateCode('console.log(1)', 'javascript')
    flushRaf('update')
    api.updateCode('console.log(2)', 'javascript')
    flushRaf('update')
    expect(vi.getTimerCount()).toBe(1)

    api.cleanupEditor()

    const scheduler = getScheduler()
    expect(scheduler.cancel).toHaveBeenCalledWith('reveal')
    expect(scheduler.cancel).toHaveBeenCalledWith('append')
    expect(scheduler.cancel).toHaveBeenCalledWith('update')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queued theme microtasks no-op after cleanupEditor', async () => {
    vi.useRealTimers()
    const microtasks: Array<() => void> = []
    const queueSpy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb: () => void) => {
      microtasks.push(cb)
    })
    try {
      const api = await createMonacoAPI()
      const container = createContainer()
      await api.createEditor(container, '', 'javascript')
      // flush immediate watcher microtasks scheduled during create
      while (microtasks.length)
        microtasks.shift()?.()

      const monaco = await import('../src/monaco-shim')
      const setThemeSpy = monaco.editor.setTheme as ReturnType<typeof vi.fn>
      const baselineCalls = setThemeSpy.mock.calls.length

      const { isDark } = await import('../src/isDark')
      isDark.value = true
      expect(microtasks.length).toBeGreaterThan(0)

      api.cleanupEditor()

      while (microtasks.length)
        microtasks.shift()?.()

      expect(setThemeSpy.mock.calls.length).toBe(baselineCalls)
    }
    finally {
      queueSpy.mockRestore()
    }
  })
})
