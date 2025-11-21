import { log } from './logger'

export function createScrollWatcherForEditor(
  ed: any,
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
  // Use centralized DEBUG from logger
  const initial = ed.getScrollTop?.() ?? 0
  opts.setLast(initial)
  log('scrollWatcher', 'initial scrollTop=', initial)
  let suppressedExternally = false
  const THRESHOLD_PX = 6
  let domNode: HTMLElement | null = null
  let interactionListener: ((e: Event) => void) | null = null
  const listener = (e: any) => {
    if (suppressedExternally) {
      log('scrollWatcher', 'suppressedExternally, ignoring event')
      return
    }
    const currentTop = e && typeof e.scrollTop === 'number' ? e.scrollTop : ed.getScrollTop?.() ?? 0
    const delta = currentTop - opts.getLast()
    // update last seen position immediately
    opts.setLast(currentTop)
    // ignore very small scroll deltas (usually from layout/height adjustments)
    if (Math.abs(delta) < THRESHOLD_PX) {
      log('scrollWatcher', 'small delta ignored', delta)
      // If the delta is small, check whether the viewport is effectively
      // at the bottom of the scrollable area. In that case we should treat
      // this as a potential resume so streaming auto-scroll can re-enable.
      try {
        const scrollHeight = typeof ed.getScrollHeight === 'function' ? ed.getScrollHeight() : undefined
        const li = typeof (ed as any).getLayoutInfo === 'function' ? (ed as any).getLayoutInfo() : undefined
        const viewportH = li?.height ?? undefined
        if (typeof scrollHeight === 'number' && typeof viewportH === 'number') {
          const distance = scrollHeight - (currentTop + viewportH)
          if (distance <= Math.max(THRESHOLD_PX, 0)) {
            log('scrollWatcher', 'small delta but at bottom, maybe resume', { distance })
            opts.onMaybeResume()
          }
        }
      }
      catch { }
      return
    }
    log('scrollWatcher', 'delta=', delta, 'currentTop=', currentTop)
    if (delta < 0) {
      log('scrollWatcher', 'pause detected delta=', delta)
      opts.onPause()
      return
    }
    log('scrollWatcher', 'maybe resume delta=', delta)
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
      log('scrollWatcher', 'dispose')
    },
    setSuppressed(v: boolean) {
      const newVal = !!v
      if (newVal === suppressedExternally)
        return
      suppressedExternally = newVal
      log('scrollWatcher', 'setSuppressed =>', suppressedExternally)

      // When suppression is enabled, attach lightweight user-interaction
      // listeners so real user input (wheel/pointer/touch) can immediately
      // cancel suppression and mark the watcher as paused. This prevents
      // programmatic suppression from blocking the user's attempt to scroll up.
      try {
        // Try to get the editor DOM node if available
        if (!domNode && typeof (ed as any).getDomNode === 'function') {
          domNode = (ed as any).getDomNode() as HTMLElement | null
        }
        if (suppressedExternally && domNode) {
          if (!interactionListener) {
            interactionListener = () => {
              try {
                log('scrollWatcher', 'user interaction detected while suppressed, cancelling suppression')
                // Treat this as a pause (user took control)
                opts.onPause()
                // clear suppression so subsequent scroll events are observed
                suppressedExternally = false
                // update last known position to current scrollTop
                const cur = ed.getScrollTop?.() ?? 0
                opts.setLast(cur)
                // If the user interaction already scrolled to bottom, treat as resume
                try {
                  const scrollHeight = typeof (ed as any).getScrollHeight === 'function' ? (ed as any).getScrollHeight() : undefined
                  const li = typeof (ed as any).getLayoutInfo === 'function' ? (ed as any).getLayoutInfo() : undefined
                  const viewportH = li?.height ?? undefined
                  if (typeof scrollHeight === 'number' && typeof viewportH === 'number') {
                    const distance = scrollHeight - (cur + viewportH)
                    if (distance <= Math.max(THRESHOLD_PX, 0)) {
                      log('scrollWatcher', 'interaction moved to bottom, maybe resume', { distance })
                      opts.onMaybeResume()
                    }
                  }
                }
                catch { }
                // remove listeners
                if (domNode && interactionListener) {
                  domNode.removeEventListener('wheel', interactionListener, { passive: true } as any)
                  domNode.removeEventListener('pointerdown', interactionListener as any)
                  domNode.removeEventListener('touchstart', interactionListener as any)
                }
                interactionListener = null
              }
              catch { }
            }
            domNode.addEventListener('wheel', interactionListener, { passive: true } as any)
            domNode.addEventListener('pointerdown', interactionListener as any)
            domNode.addEventListener('touchstart', interactionListener as any)
          }
        }
        else {
          if (domNode && interactionListener) {
            domNode.removeEventListener('wheel', interactionListener, { passive: true } as any)
            domNode.removeEventListener('pointerdown', interactionListener as any)
            domNode.removeEventListener('touchstart', interactionListener as any)
            interactionListener = null
          }
        }
      }
      catch { }
    },
  }

  return api
}
