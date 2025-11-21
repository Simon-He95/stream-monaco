import { log } from './logger'

export function createHeightManager(container: HTMLElement, computeNext: () => number | null) {
  // Debug logging is enabled during development but can be controlled via

  let raf: number | null = null
  let debounceTimer: number | null = null
  let lastApplied = -1
  let suppressed = false
  // larger hysteresis to reduce perceived jitter during incremental growth
  const HYSTERESIS_PX = 12
  // debounce delay to coalesce frequent height changes (ms)
  const DEBOUNCE_MS = 0

  function apply() {
    const next = computeNext()
    if (next == null) {
      return
    }
    log('heightManager', 'computeNext ->', { next, lastApplied })
    // Guard against invalid or non-positive heights which can collapse the
    // container. Some downstream callers may compute values incorrectly
    // during transient states; ignore those to keep the editor visible.
    if (!Number.isFinite(next) || next <= 0) {
      log('heightManager', 'invalid next height, ignoring', next)
      return
    }
    if (lastApplied !== -1 && Math.abs(next - lastApplied) <= HYSTERESIS_PX) {
      return
    }
    if (next === lastApplied) {
      return
    }
    suppressed = true
    container.style.height = `${next}px`
    lastApplied = next
    log('heightManager', 'applied height ->', next)
    queueMicrotask(() => {
      suppressed = false
    })
  }

  function scheduleApply() {
    // Cancel any pending debounce timer and schedule a new one that will
    // requestAnimationFrame and run `apply`. This batches updates that occur
    // within DEBOUNCE_MS to avoid rapid reflows.
    if (debounceTimer != null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (DEBOUNCE_MS === 0) {
      if (raf != null) {
        return
      }
      raf = requestAnimationFrame(() => {
        raf = null
        apply()
      })
      return
    }
    debounceTimer = (setTimeout(() => {
      debounceTimer = null
      if (raf != null) {
        return
      }
      raf = requestAnimationFrame(() => {
        raf = null
        apply()
      })
    }, DEBOUNCE_MS) as unknown) as number
  }

  function update() {
    scheduleApply()
  }

  function dispose() {
    if (raf != null) {
      cancelAnimationFrame(raf)
      raf = null
    }
    if (debounceTimer != null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
  }
  function isSuppressed() {
    return suppressed
  }
  function getLastApplied() {
    return lastApplied
  }
  return { update, dispose, isSuppressed, getLastApplied }
}
