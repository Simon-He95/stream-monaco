export const editorWorkerPath = 'monaco-editor/esm/vs/editor/editor.worker.js'

export const workerPathByLabel: Record<string, string> = {
  json: 'monaco-editor/esm/vs/language/json/json.worker.js',
  css: 'monaco-editor/esm/vs/language/css/css.worker.js',
  scss: 'monaco-editor/esm/vs/language/css/css.worker.js',
  less: 'monaco-editor/esm/vs/language/css/css.worker.js',
  html: 'monaco-editor/esm/vs/language/html/html.worker.js',
  handlebars: 'monaco-editor/esm/vs/language/html/html.worker.js',
  razor: 'monaco-editor/esm/vs/language/html/html.worker.js',
  typescript: 'monaco-editor/esm/vs/language/typescript/ts.worker.js',
  javascript: 'monaco-editor/esm/vs/language/typescript/ts.worker.js',
}

export const uniqueWorkerPaths: string[] = Array.from(
  new Set([editorWorkerPath, ...Object.values(workerPathByLabel)]),
)
