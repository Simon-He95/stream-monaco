// Best-effort: install worker hook during module evaluation to avoid the
// "Could not create web worker(s)" fallback when consumers don't explicitly
// call `preloadMonacoWorkers()`.
import { ensureMonacoWorkers } from './ensureMonacoWorkers'

export { ensureMonacoWorkers } from './ensureMonacoWorkers'
export * from './index.base'

export { preloadMonacoWorkers } from './preloadMonacoWorkers'

ensureMonacoWorkers()
