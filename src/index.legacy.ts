export * from './index.base'
export { preloadMonacoWorkers } from './preloadMonacoWorkers.legacy'

// Best-effort: install worker hook during module evaluation to avoid the
// "Could not create web worker(s)" fallback when consumers don't explicitly
// call `preloadMonacoWorkers()`.
export { ensureMonacoWorkersLegacy } from './ensureMonacoWorkers.legacy'
import { ensureMonacoWorkersLegacy } from './ensureMonacoWorkers.legacy'
ensureMonacoWorkersLegacy()
