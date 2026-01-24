export * from './index.base'
export { preloadMonacoWorkers } from './preloadMonacoWorkers'

// Best-effort: install worker hook during module evaluation to avoid the
// "Could not create web worker(s)" fallback when consumers don't explicitly
// call `preloadMonacoWorkers()`.
export { ensureMonacoWorkers } from './ensureMonacoWorkers'
import { ensureMonacoWorkers } from './ensureMonacoWorkers'
ensureMonacoWorkers()
