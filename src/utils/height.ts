import { log } from './logger'

export interface HeightManagerOptions {
  smooth?: boolean
  transitionMs?: number
  transitionEasing?: string
  debounceMs?: number
  hysteresisPx?: number
}

const DEFAULT_TRANSITION_MS = 120
const DEFAULT_TRANSITION_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'
const DEFAULT_HYSTERESIS_PX = 12
const DEFAULT_DEBOUNCE_MS = 0

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function createHeightManager(
  container: HTMLElement,
  computeNext: () => number | null,
  options: HeightManagerOptions = {},
) {
  const transitionMs = Math.max(0, options.transitionMs ?? DEFAULT_TRANSITION_MS)
  const transitionEasing = options.transitionEasing ?? DEFAULT_TRANSITION_EASING
  const hysteresisPx = Math.max(0, options.hysteresisPx ?? DEFAULT_HYSTERESIS_PX)
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  const transitionEnabled = options.smooth === true
    && transitionMs > 0
    && !prefersReducedMotion()
  const previousTransition = container.style.transition || ''
  const heightTransition = `height ${transitionMs}ms ${transitionEasing}`

  if (transitionEnabled) {
    container.style.transition = previousTransition
      ? `${previousTransition}, ${heightTransition}`
      : heightTransition
  }

  let raf: number | null = null
  let debounceTimer: number | null = null
  let lastApplied = -1
  let suppressed = false

  function apply() {
    const next = computeNext()
    if (next == null) {
      return null
    }
    log('heightManager', 'computeNext ->', { next, lastApplied })
    // Guard against invalid or non-positive heights which can collapse the
    // container. Some downstream callers may compute values incorrectly
    // during transient states; ignore those to keep the editor visible.
    if (!Number.isFinite(next) || next <= 0) {
      log('heightManager', 'invalid next height, ignoring', next)
      return null
    }
    const currentHeight
      = Number.parseFloat(container.style.height || '')
        || container.getBoundingClientRect?.().height
        || 0
    if (
      currentHeight > 0
      && Math.abs(next - currentHeight) <= hysteresisPx
    ) {
      lastApplied = next
      return next
    }
    if (lastApplied !== -1 && Math.abs(next - lastApplied) <= hysteresisPx) {
      return next
    }
    if (next === lastApplied) {
      return next
    }
    suppressed = true
    container.style.height = `${next}px`
    lastApplied = next
    log('heightManager', 'applied height ->', next)
    queueMicrotask(() => {
      suppressed = false
    })
    return next
  }

  function scheduleApply() {
    // Cancel any pending debounce timer and schedule a new one that will
    // requestAnimationFrame and run `apply`. This batches updates that occur
    // within debounceMs to avoid rapid reflows.
    if (debounceTimer != null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (debounceMs === 0) {
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
    }, debounceMs) as unknown) as number
  }

  function update() {
    scheduleApply()
  }

  function updateNow() {
    if (raf != null) {
      cancelAnimationFrame(raf)
      raf = null
    }
    if (debounceTimer != null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    return apply()
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
    if (transitionEnabled) {
      const currentTransition = container.style.transition || ''
      if (currentTransition.includes(heightTransition)) {
        container.style.transition = currentTransition
          .replace(heightTransition, '')
          .replace(/\s*,\s*,\s*/g, ', ')
          .replace(/^\s*,\s*|\s*,\s*$/g, '')
          .trim()
      }
    }
  }
  function isSuppressed() {
    return suppressed
  }
  function getLastApplied() {
    return lastApplied
  }
  function getTransitionMs() {
    return transitionEnabled ? transitionMs : 0
  }
  return { update, updateNow, dispose, isSuppressed, getLastApplied, getTransitionMs }
}
