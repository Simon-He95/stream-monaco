import nodeProcess from 'node:process'

let seq = 0

// Centralized debug determination. Priority:
// 1. browser global `window.__STREAM_MONACO_DEBUG__` if defined
// 2. process.env.NODE_ENV === 'production' disables debug when available
// Default: enable debug during local development
export const DEBUG: boolean = (() => {
  if (typeof window !== 'undefined' && (window as any).__STREAM_MONACO_DEBUG__ !== undefined)
    return Boolean((window as any).__STREAM_MONACO_DEBUG__)
  const proc = nodeProcess as any
  if (proc && proc.env && proc.env.NODE_ENV === 'production')
    return false

  return false
})()

export function log(tag: string, ...args: any[]) {
  if (!DEBUG)
    return
  seq += 1
  const id = `#${seq}`
  const ts = (typeof performance !== 'undefined' && performance.now)
    ? (performance.now()).toFixed(1)
    : Date.now()
  // Use console.warn to comply with ESLint console restrictions.
  console.warn(`${id} [${tag}] @${ts}ms`, ...args)
}

export function error(tag: string, ...args: any[]) {
  if (!DEBUG)
    return
  console.error(`[${tag}]`, ...args)
}
