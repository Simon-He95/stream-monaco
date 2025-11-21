import nodeProcess from 'node:process'
import { log } from './logger'

export function createScrollWatcherForEditor(
  ed: { onDidScrollChange?: any, getScrollTop?: () => number },
  opts: {
    onPause: () => void
    onMaybeResume: () => void
    getLast: () => number
    setLast: (v: number) => void
  },
) {
  // Debug logging: enabled by default for local diagnosis but controllable by
  // - a global `window.__STREAM_MONACO_DEBUG__` override (true/false), or
  // - `process.env.NODE_ENV === 'production'` which disables debug logs.
  const DEBUG: boolean = (() => {
    try {
      // Global override in browser (set `window.__STREAM_MONACO_DEBUG__ = false` to disable)
      if (typeof window !== 'undefined' && (window as any).__STREAM_MONACO_DEBUG__ !== undefined)
        return Boolean((window as any).__STREAM_MONACO_DEBUG__)

      // Respect production builds when `process.env.NODE_ENV` is available
      try {
        const proc = nodeProcess as any
        if (proc && proc.env && proc.env.NODE_ENV === 'production')
          return false
      }
      catch { }
    }
    catch { }
    // Default: enable debug during local development
    return true
  })()
  const initial = ed.getScrollTop?.() ?? 0
  opts.setLast(initial)
  if (DEBUG) {
    log('scrollWatcher', 'initial scrollTop=', initial)
  }
  let suppressedExternally = false
  const THRESHOLD_PX = 6
  const listener = (e: any) => {
    if (suppressedExternally) {
      if (DEBUG) {
        log('scrollWatcher', 'suppressedExternally, ignoring event')
      }
      return
    }
    const currentTop = e && typeof e.scrollTop === 'number' ? e.scrollTop : ed.getScrollTop?.() ?? 0
    const delta = currentTop - opts.getLast()
    // update last seen position immediately
    opts.setLast(currentTop)
    // ignore very small scroll deltas (usually from layout/height adjustments)
    if (Math.abs(delta) < THRESHOLD_PX) {
      if (DEBUG) {
        log('scrollWatcher', 'small delta ignored', delta)
      }
      return
    }
    if (DEBUG) {
      log('scrollWatcher', 'delta=', delta, 'currentTop=', currentTop)
    }
    if (delta < 0) {
      if (DEBUG) {
        log('scrollWatcher', 'pause detected delta=', delta)
      }
      opts.onPause()
      return
    }
    if (DEBUG) {
      log('scrollWatcher', 'maybe resume delta=', delta)
    }
    opts.onMaybeResume()
  }

  const disp = ed.onDidScrollChange?.(listener) ?? null

  // Return an object that provides dispose and suppression control. We keep
  // the dispose method for compatibility with monaco.IDisposable.
  const api: any = {
    dispose() {
      try {
        if (disp && typeof disp.dispose === 'function')
          disp.dispose()
        else if (typeof disp === 'function')
          disp()
      }
      catch { }
      if (DEBUG)
        log('scrollWatcher', 'dispose')
    },
    setSuppressed(v: boolean) {
      suppressedExternally = !!v
      if (DEBUG)
        log('scrollWatcher', 'setSuppressed =>', suppressedExternally)
    },
  }

  return api
}
