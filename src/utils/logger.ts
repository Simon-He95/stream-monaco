import nodeProcess from 'node:process'

let seq = 0

// Centralized debug determination. Priority:
// 1. browser global `window.__STREAM_MONACO_DEBUG__` if defined
// 2. process.env.NODE_ENV === 'production' disables debug when available
// Default: enable debug during local development
export const DEBUG: boolean = (() => {
  try {
    if (typeof window !== 'undefined' && (window as any).__STREAM_MONACO_DEBUG__ !== undefined)
      return Boolean((window as any).__STREAM_MONACO_DEBUG__)
    try {
      const proc = nodeProcess as any
      if (proc && proc.env && proc.env.NODE_ENV === 'production')
        return false
    }
    catch { }
  }
  catch { }
  return true
})()

export function log(tag: string, ...args: any[]) {
  if (!DEBUG)
    return
  try {
    seq += 1
    const id = `#${seq}`
    const ts = (typeof performance !== 'undefined' && performance.now)
      ? (performance.now()).toFixed(1)
      : Date.now()
    // Use console.warn to comply with ESLint console restrictions.
    console.warn(`${id} [${tag}] @${ts}ms`, ...args)
  }
  catch (err) {
    try {
      console.warn('[logger] fallback', tag, ...args, err)
    }
    catch {
      // swallow any logging errors
    }
  }
}

export function error(tag: string, ...args: any[]) {
  if (!DEBUG)
    return
  try {
    console.error(`[${tag}]`, ...args)
  }
  catch (err) {
    try {
      console.error('[logger] fallback error', tag, ...args, err)
    }
    catch {
      // swallow
    }
  }
}
