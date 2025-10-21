// Thin adapter over alien-signals to provide Vue-like APIs used internally.
import { computed as aComputed, effect as aEffect, signal as aSignal } from 'alien-signals'

export type WatchStopHandle = () => void

export interface Ref<T> { value: T }

export function ref<T>(initial: T): Ref<T> {
  const s = aSignal<T>(initial)
  return Object.defineProperty({} as Ref<T>, 'value', {
    get() { return s() },
    set(v: T) { s(v) },
    enumerable: true,
    configurable: false,
  })
}

export function computed<T>(getter: () => T): Ref<T> {
  const c = aComputed<T>(() => getter())
  return Object.defineProperty({} as Ref<T>, 'value', {
    get() { return c() },
    set(_: T) { /* readonly */ },
    enumerable: true,
    configurable: false,
  })
}

interface WatchOptions { immediate?: boolean, flush?: 'post' | 'sync' }

export function watch<T>(
  source: () => T,
  cb: (newVal: T, oldVal: T | undefined) => void,
  options: WatchOptions = {},
): WatchStopHandle {
  let initialized = false
  let oldVal: T | undefined
  const stop = aEffect(() => {
    const newVal = source()
    if (!initialized) {
      initialized = true
      if (options.immediate) {
        const capturedOldVal = oldVal
        if (options.flush === 'post')
          queueMicrotask(() => cb(newVal, capturedOldVal))
        else
          cb(newVal, capturedOldVal)
      }
      oldVal = newVal
    }
    else if (!Object.is(newVal, oldVal)) {
      const capturedOldVal = oldVal
      if (options.flush === 'post')
        queueMicrotask(() => cb(newVal, capturedOldVal))
      else
        cb(newVal, capturedOldVal)
      oldVal = newVal
    }
    else {
      // Even when values are equal, we need to update oldVal in case it's the same object reference
      oldVal = newVal
    }
  })
  return stop
}
