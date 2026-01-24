function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

function tryDeriveBaseUrlFromVsPath(vsPath: string): string | undefined {
  if (!vsPath)
    return undefined

  // Common: ".../min/vs" or ".../vs"
  const trimmed = vsPath.endsWith('/') ? vsPath.slice(0, -1) : vsPath
  if (trimmed.endsWith('/vs'))
    return normalizeBaseUrl(trimmed.slice(0, -3))

  const vsIndex = trimmed.indexOf('/vs/')
  if (vsIndex > 0)
    return normalizeBaseUrl(trimmed.slice(0, vsIndex))

  return undefined
}

function detectMonacoBaseUrlFromScripts(): string | undefined {
  if (typeof document === 'undefined')
    return undefined

  const scripts = Array.from(document.getElementsByTagName('script'))
  for (const script of scripts) {
    const src = script.getAttribute('src') || ''
    if (!src)
      continue

    const loaderMatch = src.match(/^(.*)\/vs\/loader\.js(?:\\?.*)?$/)
    if (loaderMatch)
      return normalizeBaseUrl(loaderMatch[1])

    const vsIndex = src.indexOf('/vs/')
    if (vsIndex > 0)
      return normalizeBaseUrl(src.slice(0, vsIndex))
  }

  return undefined
}

function detectMonacoBaseUrlFromAmdRequire(): string | undefined {
  // Monaco AMD loader exposes a global `require` with config paths.
  const amdRequire = (globalThis as any).require
  const vsPath = amdRequire?.s?.contexts?._?.config?.paths?.vs
  if (typeof vsPath !== 'string' || !vsPath)
    return undefined

  try {
    return tryDeriveBaseUrlFromVsPath(String(new URL(vsPath, location.href)))
  }
  catch {
    return tryDeriveBaseUrlFromVsPath(vsPath)
  }
}

function detectMonacoBaseUrlFromExistingWorkerUrl(
  getWorkerUrl: (moduleId: string, label: string) => string,
): string | undefined {
  let workerUrl: string | undefined
  try {
    workerUrl = getWorkerUrl('', 'editorWorkerService')
  }
  catch {
    // ignore
  }

  if (!workerUrl) {
    try {
      workerUrl = getWorkerUrl('', 'typescript')
    }
    catch {
      // ignore
    }
  }

  if (!workerUrl)
    return undefined

  try {
    const resolved = new URL(workerUrl, location.href)
    const vsIndex = resolved.pathname.indexOf('/vs/')
    if (vsIndex <= 0)
      return undefined

    return normalizeBaseUrl(
      `${resolved.origin}${resolved.pathname.slice(0, vsIndex)}`,
    )
  }
  catch {
    return undefined
  }
}

function makeWorkerUrl(baseUrl: string): string | undefined {
  if (typeof URL === 'undefined' || typeof Blob === 'undefined')
    return undefined

  const normalized = normalizeBaseUrl(baseUrl)
  const workerMainUrl = `${normalized}vs/base/worker/workerMain.js`
  const source = `self.MonacoEnvironment={baseUrl:${JSON.stringify(normalized)}};importScripts(${JSON.stringify(workerMainUrl)});`

  try {
    return URL.createObjectURL(
      new Blob([source], { type: 'text/javascript' }),
    )
  }
  catch {
    return undefined
  }
}

export function ensureMonacoWorkersLegacy(options?: { baseUrl?: string }): void {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return

  try {
    // eslint-disable-next-line no-restricted-globals
    const existing = (self as any).MonacoEnvironment
    if (existing?.getWorker)
      return

    // If the host already provided a getWorkerUrl but it points at a different
    // origin (common with CDN setups), Monaco's Worker constructor can fail.
    // In that case, we switch to the recommended blob wrapper that uses
    // importScripts(workerMain.js).
    const existingGetWorkerUrl = existing?.getWorkerUrl as
      | undefined
      | ((moduleId: string, label: string) => string)
    if (typeof existingGetWorkerUrl === 'function') {
      const existingBaseUrl = detectMonacoBaseUrlFromExistingWorkerUrl(
        existingGetWorkerUrl,
      )
      if (existingBaseUrl) {
        const workerUrl = makeWorkerUrl(existingBaseUrl)
        if (workerUrl) {
          // eslint-disable-next-line no-restricted-globals
          ;(self as any).MonacoEnvironment = {
            getWorkerUrl() {
              return workerUrl
            },
          }
        }
      }
      return
    }

    const baseUrl =
      options?.baseUrl
      ?? detectMonacoBaseUrlFromScripts()
      ?? detectMonacoBaseUrlFromAmdRequire()
    if (!baseUrl)
      return

    const workerUrl = makeWorkerUrl(baseUrl)
    if (!workerUrl)
      return

    // eslint-disable-next-line no-restricted-globals
    ;(self as any).MonacoEnvironment = {
      getWorkerUrl() {
        return workerUrl
      },
    }
  }
  catch {
    // ignore - best effort
  }
}
