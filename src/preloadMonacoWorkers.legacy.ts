import { workerPathByLabel } from './preloadMonacoWorkers.shared'

// Webpack 4 (Vue CLI 4) cannot parse `import.meta.url`. This legacy build
// assumes the host app configures Monaco workers (e.g. via
// monaco-editor-webpack-plugin or a manual MonacoEnvironment.getWorkerUrl).
export async function preloadMonacoWorkers(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return

  // eslint-disable-next-line no-restricted-globals
  const env = (self as any).MonacoEnvironment as
    | undefined
    | { getWorkerUrl?: (moduleId: string, label: string) => string }

  const getWorkerUrl = env?.getWorkerUrl
  if (typeof getWorkerUrl !== 'function')
    return

  // Monaco usually asks for `editorWorkerService` as the default label when no
  // specialized worker exists.
  const labelsToWarm = Array.from(
    new Set([...Object.keys(workerPathByLabel), 'editorWorkerService']),
  )
  const urls = labelsToWarm
    .map((label) => {
      try {
        return getWorkerUrl('', label)
      }
      catch {
        return undefined
      }
    })
    .filter(Boolean)

  const unique = Array.from(new Set(urls.filter(Boolean).map(String)))

  try {
    await Promise.all(
      unique.map(u =>
        fetch(u, { method: 'GET', cache: 'force-cache' }).catch(() => undefined),
      ),
    )
  }
  catch {
    // swallow errors - preloading is best-effort
  }
}
