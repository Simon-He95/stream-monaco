import { editorWorkerPath, workerPathByLabel } from './preloadMonacoWorkers.shared'

export function ensureMonacoWorkers(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return

  // IMPORTANT: install synchronously. Many consumers import and immediately
  // create editors without awaiting any async setup.
  try {
    // eslint-disable-next-line no-restricted-globals
    const existing = (self as any).MonacoEnvironment
    // Respect consumer configuration (e.g. monaco-editor-webpack-plugin).
    if (existing?.getWorker || existing?.getWorkerUrl)
      return

    const workerUrlByLabel: Record<string, URL> = Object.fromEntries(
      Object.entries(workerPathByLabel).map(([label, path]) => [
        label,
        new URL(path, import.meta.url),
      ]),
    )
    const workerUrlEditor = new URL(editorWorkerPath, import.meta.url)

    // eslint-disable-next-line no-restricted-globals
    ;(self as any).MonacoEnvironment = {
      getWorker(_: any, label: string) {
        const url = workerUrlByLabel[label] ?? workerUrlEditor
        return new Worker(url, { type: 'module' })
      },
    }
  }
  catch {
    // ignore - best effort
  }
}
