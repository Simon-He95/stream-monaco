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

interface WatchOptions {
  immediate?: boolean
  flush?: 'post' | 'sync'
  createGuardToken?: () => unknown
  guard?: (token: unknown) => boolean
}

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
        if (options.flush === 'post') {
          const token = options.createGuardToken?.()
          queueMicrotask(() => {
            if (options.guard && !options.guard(token))
              return
            cb(newVal, oldVal)
          })
        }
        else {
          cb(newVal, oldVal)
        }
      }
    }
    else if (!Object.is(newVal, oldVal)) {
      if (options.flush === 'post') {
        const token = options.createGuardToken?.()
        queueMicrotask(() => {
          if (options.guard && !options.guard(token))
            return
          cb(newVal, oldVal)
        })
      }
      else {
        cb(newVal, oldVal)
      }
    }
    oldVal = newVal
  })
  return stop
}
