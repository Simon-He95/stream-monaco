export interface TimeSource {
  requestAnimationFrame: (cb: FrameRequestCallback) => number
  cancelAnimationFrame: (id: number) => void
}

/**
 * Create a per-instance RAF scheduler that coalesces tasks by "kind" within
 * the same instance. Instances are isolated so different editors won't
 * cancel each other's scheduled work.
 */
export function createRafScheduler(timeSource?: TimeSource) {
  const ids: Record<string, number | null> = {}
  const ts: TimeSource = timeSource ?? {
    requestAnimationFrame: (cb: FrameRequestCallback) => requestAnimationFrame(cb),
    cancelAnimationFrame: (id: number) => cancelAnimationFrame(id),
  }

  function schedule(kind: string, cb: FrameRequestCallback) {
    const existing = ids[kind]
    if (existing != null) {
      ts.cancelAnimationFrame(existing)
    }
    ids[kind] = ts.requestAnimationFrame((t) => {
      ids[kind] = null
      cb(t)
    })
  }

  function cancel(kind: string) {
    const id = ids[kind]
    if (id != null) {
      ts.cancelAnimationFrame(id)
      ids[kind] = null
    }
  }

  return { schedule, cancel }
}
