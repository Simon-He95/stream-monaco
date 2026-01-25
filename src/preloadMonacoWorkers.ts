import { ensureMonacoWorkers } from './ensureMonacoWorkers'
// Expose a function so consumers can proactively preload worker loaders
// without relying on module evaluation timing.
import { uniqueWorkerPaths } from './preloadMonacoWorkers.shared'

export async function preloadMonacoWorkers(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return

  const unique = uniqueWorkerPaths.map(p => String(new URL(p, import.meta.url)))

  // IMPORTANT: install synchronously (before the first `await`).
  ensureMonacoWorkers()

  try {
    // best-effort fetch to warm caches; do not throw on individual failures
    await Promise.all(
      unique.map(u =>
        fetch(u, { method: 'GET', cache: 'force-cache' }).catch(
          () => undefined,
        ),
      ),
    )
  }
  catch {
    // swallow errors - preloading is best-effort
  }
}
