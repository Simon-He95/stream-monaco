// Expose a function so consumers can proactively preload worker loaders
// without relying on module evaluation timing.
import { editorWorkerPath, uniqueWorkerPaths, workerPathByLabel } from './preloadMonacoWorkers.shared'

export async function preloadMonacoWorkers(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return

  const workerUrlByLabel: Record<string, URL> = Object.fromEntries(
    Object.entries(workerPathByLabel).map(([label, path]) => [
      label,
      new URL(path, import.meta.url),
    ]),
  )
  const workerUrlEditor = new URL(editorWorkerPath, import.meta.url)
  const unique = uniqueWorkerPaths.map(p => String(new URL(p, import.meta.url)))

  // IMPORTANT: set MonacoEnvironment synchronously (before the first `await`).
  // Many consumers call `preloadMonacoWorkers()` without awaiting it. If we
  // only set MonacoEnvironment after async prefetching, Monaco may attempt to
  // create workers before the hook is installed, which can lead to blank /
  // non-rendering editors (especially for DiffEditor).
  try {
    // eslint-disable-next-line no-restricted-globals
    const existing = (self as any).MonacoEnvironment
    // Respect consumer configuration (e.g. monaco-editor-webpack-plugin).
    if (!existing?.getWorker && !existing?.getWorkerUrl) {
      // eslint-disable-next-line no-restricted-globals
      ;(self as any).MonacoEnvironment = {
        getWorker(_: any, label: string) {
          const url = workerUrlByLabel[label] ?? workerUrlEditor
          return new Worker(url, { type: 'module' })
        },
      }
    }
  }
  catch {
    // ignore - best effort
  }

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
