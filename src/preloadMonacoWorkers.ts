// Expose a function so consumers can proactively preload worker loaders
// without relying on module evaluation timing.
export async function preloadMonacoWorkers(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return

  // Recreate the same URLs as used by MonacoEnvironment
  const workerUrlJson = new URL(
    'monaco-editor/esm/vs/language/json/json.worker.js',
    import.meta.url,
  )
  const workerUrlCss = new URL(
    'monaco-editor/esm/vs/language/css/css.worker.js',
    import.meta.url,
  )
  const workerUrlHtml = new URL(
    'monaco-editor/esm/vs/language/html/html.worker.js',
    import.meta.url,
  )
  const workerUrlTs = new URL(
    'monaco-editor/esm/vs/language/typescript/ts.worker.js',
    import.meta.url,
  )
  const workerUrlEditor = new URL(
    'monaco-editor/esm/vs/editor/editor.worker.js',
    import.meta.url,
  )

  const unique = Array.from(
    new Set([
      String(workerUrlJson),
      String(workerUrlCss),
      String(workerUrlHtml),
      String(workerUrlTs),
      String(workerUrlEditor),
    ]),
  )

  const workerUrlByLabel: Record<string, URL> = {
    json: workerUrlJson,
    css: workerUrlCss,
    scss: workerUrlCss,
    less: workerUrlCss,
    html: workerUrlHtml,
    handlebars: workerUrlHtml,
    razor: workerUrlHtml,
    typescript: workerUrlTs,
    javascript: workerUrlTs,
  }

  // IMPORTANT: set MonacoEnvironment synchronously (before the first `await`).
  // Many consumers call `preloadMonacoWorkers()` without awaiting it. If we
  // only set MonacoEnvironment after async prefetching, Monaco may attempt to
  // create workers before the hook is installed, which can lead to blank /
  // non-rendering editors (especially for DiffEditor).
  try {
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
