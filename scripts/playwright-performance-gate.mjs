#!/usr/bin/env node

import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const perfDir = path.join(root, '.perf')
const perfAppDir = path.join(root, 'scripts/.perf-app')
const reportPath = path.join(perfDir, 'stream-monaco-performance-report.json')
const baselinePath = path.join(root, 'scripts/performance-baseline.json')
const budgetPath = path.join(root, 'scripts/performance-budget.json')

const args = process.argv.slice(2)
const has = name => args.includes(name)
const getArg = (name, fallback) => {
  const prefix = `${name}=`
  const hit = args.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const entry = getArg('--entry', 'dist')
const updateBaseline = has('--update-baseline')
const reportOnly = has('--report-only')
const headed = has('--headed')
const scenarioFilter = getArg('--scenario', '')
const repeat = Number(getArg('--repeat', '1'))

const SCENARIOS = [
  'editor-cold-first-highlight',
  'editor-warm-first-highlight',
  'editor-update-highlight',
  'editor-stream-burst',
  'diff-cold-first-highlight',
  'diff-update-highlight',
  'diff-stream-burst',
].filter(name => !scenarioFilter || name === scenarioFilter)

function nowIso() {
  return new Date().toISOString()
}

function metricMap(cdpMetrics) {
  return Object.fromEntries(cdpMetrics.metrics.map(m => [m.name, m.value]))
}

function diffMetricMap(before, after) {
  const out = {}
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const name of names) {
    const a = after[name]
    const b = before[name]
    if (typeof a === 'number' && typeof b === 'number')
      out[name] = a - b
  }
  return out
}

function summarizeSamples(samples = []) {
  const sorted = samples.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length)
    return { count: 0, min: 0, p50: 0, p75: 0, p95: 0, p99: 0, max: 0, avg: 0 }
  const pick = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: round(sorted[0]),
    p50: round(pick(0.5)),
    p75: round(pick(0.75)),
    p95: round(pick(0.95)),
    p99: round(pick(0.99)),
    max: round(sorted[sorted.length - 1]),
    avg: round(sum / sorted.length),
  }
}

function round(n, digits = 2) {
  if (!Number.isFinite(n))
    return n
  const p = 10 ** digits
  return Math.round(n * p) / p
}

function summarizeTimeline(events, operationCount) {
  const names = new Set([
    'Layout',
    'UpdateLayoutTree',
    'RecalculateStyles',
    'Paint',
    'CompositeLayers',
    'FunctionCall',
    'EvaluateScript',
  ])
  const summary = {}
  for (const name of names) {
    summary[name] = { count: 0, durationMs: 0, perOperation: 0 }
  }
  for (const ev of events) {
    if (!names.has(ev.name))
      continue
    if (ev.ph !== 'X' && ev.ph !== 'I')
      continue
    const item = summary[ev.name]
    item.count += 1
    item.durationMs += typeof ev.dur === 'number' ? ev.dur / 1000 : 0
  }
  for (const name of names) {
    summary[name].durationMs = round(summary[name].durationMs)
    summary[name].perOperation = operationCount ? round(summary[name].count / operationCount, 4) : 0
  }
  return summary
}

async function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  }
  catch {
    return fallback
  }
}

async function writePerfApp() {
  await mkdir(perfAppDir, { recursive: true })
  const importPath = entry === 'src' ? '/src/index.ts' : '/dist/index.js'
  await writeFile(path.join(perfAppDir, 'index.html'), `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>stream-monaco performance gate</title>
  <style>
    html, body { margin: 0; padding: 0; background: #111; }
    body { font: 12px system-ui, sans-serif; }
    #root { padding: 12px; }
    .case { width: 980px; height: auto; max-height: 720px; margin: 0 0 12px; border: 1px solid #333; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/scripts/.perf-app/main.ts"></script>
</body>
</html>
`)
  await writeFile(path.join(perfAppDir, 'main.ts'), `
import { clearHighlighterCache, useMonaco } from '${importPath}'

type ScenarioName =
  | 'editor-cold-first-highlight'
  | 'editor-warm-first-highlight'
  | 'editor-update-highlight'
  | 'editor-stream-burst'
  | 'diff-cold-first-highlight'
  | 'diff-update-highlight'
  | 'diff-stream-burst'

declare global {
  interface Window {
    __SM_PERF__: { runScenario: (name: ScenarioName) => Promise<any> }
  }
}

const root = document.getElementById('root')!

function resetRoot() {
  root.innerHTML = ''
}

function createContainer(id: string) {
  const el = document.createElement('div')
  el.id = id
  el.className = 'case'
  root.appendChild(el)
  return el
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function nextFrame() {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

async function twoFrames() {
  await nextFrame()
  await nextFrame()
}

function makeTsCode(lines: number, marker = 'SM_MARK') {
  const out: string[] = [
    \`export const \${marker} = true\`,
    'interface User { id: number; name: string; active: boolean }',
  ]
  for (let i = 0; i < lines; i++) {
    out.push(\`export function fn_\${i}(u: User) { return u.active ? u.name + "\${i}" : String(u.id) }\`)
  }
  return out.join('\\n')
}

function waitUntil(predicate: () => boolean, timeoutMs = 8000, label = 'condition') {
  const start = performance.now()
  return new Promise<number>((resolve, reject) => {
    const tick = () => {
      let ok = false
      try { ok = predicate() }
      catch {}
      if (ok) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)))
        return
      }
      if (performance.now() - start > timeoutMs) {
        reject(new Error(\`Timed out waiting for \${label} after \${timeoutMs}ms\`))
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

function hasTokenSpans(container: HTMLElement) {
  return !!container.querySelector('.view-line span[class*="mtk"]')
}

function visibleTextIncludes(container: HTMLElement, text: string) {
  return (container.textContent || '').includes(text)
}

async function waitForHighlight(container: HTMLElement, marker?: string, timeoutMs = 8000) {
  return waitUntil(
    () => hasTokenSpans(container) && (!marker || visibleTextIncludes(container, marker)),
    timeoutMs,
    marker ? \`highlight marker \${marker}\` : 'highlight tokens',
  )
}

function observeLongTasks() {
  const entries: any[] = []
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      entries.push(...list.getEntries().map(e => ({
        name: e.name,
        startTime: e.startTime,
        duration: e.duration,
      })))
    })
    observer.observe({ type: 'longtask' as any, buffered: true })
  }
  catch {}
  return {
    stop() {
      try { observer?.disconnect() }
      catch {}
      return entries
    },
  }
}

function summarizeLongTasks(entries: any[]) {
  const durations = entries.map(e => e.duration).filter(Number.isFinite)
  const max = durations.length ? Math.max(...durations) : 0
  const total = durations.reduce((a, b) => a + b, 0)
  return {
    count: durations.length,
    maxMs: Math.round(max * 100) / 100,
    totalMs: Math.round(total * 100) / 100,
  }
}

function baseOptions(extra: any = {}) {
  return {
    MAX_HEIGHT: 640,
    readOnly: true,
    automaticLayout: false,
    minimap: { enabled: false },
    scrollbar: { alwaysConsumeMouseWheel: false },
    languages: ['typescript', 'javascript', 'json', 'diff'],
    themes: ['vitesse-dark', 'vitesse-light'],
    theme: 'vitesse-dark',
    autoScrollOnUpdate: true,
    autoScrollInitial: true,
    ...extra,
  }
}

async function runEditorFirstHighlight(cold: boolean) {
  resetRoot()
  if (cold)
    clearHighlighterCache()
  const longTasks = observeLongTasks()
  const container = createContainer(cold ? 'editor-cold' : 'editor-warm')
  const api = useMonaco(baseOptions({ updateThrottleMs: 0, autoScrollInitial: false }))
  const marker = cold ? 'SM_COLD_FIRST' : 'SM_WARM_FIRST'
  const code = makeTsCode(cold ? 320 : 180, marker)
  const start = performance.now()
  await api.createEditor(container, code, 'typescript')
  await waitForHighlight(container, marker)
  const duration = performance.now() - start
  const model = api.getEditorView()?.getModel()
  const lineCount = model?.getLineCount?.() ?? code.split('\\n').length
  await twoFrames()
  api.cleanupEditor()
  return {
    operations: 1,
    samples: [duration],
    sampleSummary: summarizeNumbers([duration]),
    chars: code.length,
    lines: lineCount,
    longTasks: summarizeLongTasks(longTasks.stop()),
  }
}

async function runEditorUpdateHighlight() {
  resetRoot()
  const longTasks = observeLongTasks()
  const container = createContainer('editor-update')
  const api = useMonaco(baseOptions({
    updateThrottleMs: 0,
    revealBatchOnIdleMs: 0,
    autoScrollInitial: false,
    autoScrollOnUpdate: false,
  }))
  let code = makeTsCode(160, 'SM_UPDATE_BASE')
  await api.createEditor(container, code, 'typescript')
  await waitForHighlight(container, 'SM_UPDATE_BASE')
  const samples: number[] = []

  for (let i = 0; i < 80; i++) {
    const marker = \`SM_UPDATE_\${i}\`
    code = code.replace(/^export const .* = true/m, \`export const \${marker} = true\`)
    const start = performance.now()
    api.updateCode(code, 'typescript')
    await waitUntil(() => api.getEditorView()?.getModel()?.getValue() === code, 4000, 'editor model update')
    await waitForHighlight(container, marker, 4000)
    samples.push(performance.now() - start)
  }
  await twoFrames()
  api.cleanupEditor()
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    longTasks: summarizeLongTasks(longTasks.stop()),
  }
}

async function runEditorStreamBurst() {
  resetRoot()
  const longTasks = observeLongTasks()
  const container = createContainer('editor-burst')
  const api = useMonaco(baseOptions({ updateThrottleMs: 50, revealBatchOnIdleMs: 200 }))
  let code = 'export const SM_BURST_BASE = true\\n'
  await api.createEditor(container, code, 'typescript')
  await waitForHighlight(container, 'SM_BURST_BASE')
  const start = performance.now()
  const operations = 500
  for (let i = 0; i < operations; i++) {
    code += \`console.log("SM_BURST_\${i}", \${i})\\n\`
    api.updateCode(code, 'typescript')
    await sleep(5)
  }
  await waitUntil(() => api.getEditorView()?.getModel()?.getValue() === code, 10000, 'editor burst final model')
  await waitForHighlight(container, 'SM_BURST_499', 4000)
  await sleep(250)
  const wallMs = performance.now() - start
  api.cleanupEditor()
  return {
    operations,
    wallMs,
    samples: [wallMs],
    sampleSummary: summarizeNumbers([wallMs]),
    finalChars: code.length,
    longTasks: summarizeLongTasks(longTasks.stop()),
  }
}

async function runDiffFirstHighlight() {
  resetRoot()
  clearHighlighterCache()
  const longTasks = observeLongTasks()
  const container = createContainer('diff-cold')
  const api = useMonaco(baseOptions({ diffUpdateThrottleMs: 0, renderSideBySide: true, autoScrollInitial: false }))
  const original = makeTsCode(220, 'SM_DIFF_ORIGINAL')
  const modified = makeTsCode(220, 'SM_DIFF_MODIFIED') + '\\nexport const changed = 1\\n'
  const start = performance.now()
  await api.createDiffEditor(container, original, modified, 'typescript')
  await waitForHighlight(container, 'SM_DIFF_MODIFIED')
  const duration = performance.now() - start
  await twoFrames()
  api.cleanupEditor()
  return {
    operations: 1,
    samples: [duration],
    sampleSummary: summarizeNumbers([duration]),
    chars: original.length + modified.length,
    longTasks: summarizeLongTasks(longTasks.stop()),
  }
}

async function runDiffUpdateHighlight() {
  resetRoot()
  const longTasks = observeLongTasks()
  const container = createContainer('diff-update')
  const api = useMonaco(baseOptions({
    diffUpdateThrottleMs: 0,
    renderSideBySide: true,
    revealBatchOnIdleMs: 0,
    autoScrollInitial: false,
    autoScrollOnUpdate: false,
  }))
  const original = makeTsCode(140, 'SM_DIFF_UPDATE_BASE_O')
  let modified = makeTsCode(140, 'SM_DIFF_UPDATE_BASE_M')
  await api.createDiffEditor(container, original, modified, 'typescript')
  await waitForHighlight(container, 'SM_DIFF_UPDATE_BASE_M')
  const samples: number[] = []

  for (let i = 0; i < 60; i++) {
    const marker = \`SM_DIFF_UPDATE_\${i}\`
    modified = modified.replace(/^export const .* = true/m, \`export const \${marker} = true\`)
    const start = performance.now()
    api.updateDiff(original, modified, 'typescript')
    await waitUntil(() => api.getDiffModels().modified?.getValue() === modified, 5000, 'diff modified model update')
    await waitForHighlight(container, marker, 5000)
    samples.push(performance.now() - start)
  }
  await twoFrames()
  api.cleanupEditor()
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    longTasks: summarizeLongTasks(longTasks.stop()),
  }
}

async function runDiffStreamBurst() {
  resetRoot()
  const longTasks = observeLongTasks()
  const container = createContainer('diff-burst')
  const api = useMonaco(baseOptions({ diffUpdateThrottleMs: 50, renderSideBySide: true, revealBatchOnIdleMs: 200 }))
  const original = makeTsCode(80, 'SM_DIFF_BURST_O')
  let modified = makeTsCode(80, 'SM_DIFF_BURST_M')
  await api.createDiffEditor(container, original, modified, 'typescript')
  await waitForHighlight(container, 'SM_DIFF_BURST_M')
  const start = performance.now()
  const operations = 500
  for (let i = 0; i < operations; i++) {
    const text = \`\\nconsole.log("SM_DIFF_BURST_\${i}", \${i})\`
    modified += text
    api.appendModified(text, 'typescript')
    await sleep(5)
  }
  await waitUntil(() => api.getDiffModels().modified?.getValue() === modified, 12000, 'diff burst final model')
  await waitForHighlight(container, 'SM_DIFF_BURST_499', 4000)
  await sleep(300)
  const wallMs = performance.now() - start
  api.cleanupEditor()
  return {
    operations,
    wallMs,
    samples: [wallMs],
    sampleSummary: summarizeNumbers([wallMs]),
    finalChars: modified.length,
    longTasks: summarizeLongTasks(longTasks.stop()),
  }
}

function summarizeNumbers(samples: number[]) {
  const sorted = samples.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length)
    return { count: 0, min: 0, p50: 0, p75: 0, p95: 0, p99: 0, max: 0, avg: 0 }
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const r = (n: number) => Math.round(n * 100) / 100
  return { count: sorted.length, min: r(sorted[0]), p50: r(pick(0.5)), p75: r(pick(0.75)), p95: r(pick(0.95)), p99: r(pick(0.99)), max: r(sorted[sorted.length - 1]), avg: r(avg) }
}

window.__SM_PERF__ = {
  async runScenario(name: ScenarioName) {
    if (name === 'editor-cold-first-highlight')
      return runEditorFirstHighlight(true)
    if (name === 'editor-warm-first-highlight')
      return runEditorFirstHighlight(false)
    if (name === 'editor-update-highlight')
      return runEditorUpdateHighlight()
    if (name === 'editor-stream-burst')
      return runEditorStreamBurst()
    if (name === 'diff-cold-first-highlight')
      return runDiffFirstHighlight()
    if (name === 'diff-update-highlight')
      return runDiffUpdateHighlight()
    if (name === 'diff-stream-burst')
      return runDiffStreamBurst()
    throw new Error(\`Unknown scenario \${name}\`)
  },
}

export {}
`)
}

async function startVite() {
  const server = await createServer({
    root,
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
    },
    optimizeDeps: {
      include: [
        'monaco-editor',
        'monaco-editor/esm/vs/editor/editor.api',
        '@shikijs/monaco',
        'shiki',
        'alien-signals',
      ],
    },
  })
  await server.listen()
  const baseUrl = server.resolvedUrls?.local?.[0]
  if (!baseUrl)
    throw new Error('Unable to resolve Vite local URL')
  return { server, baseUrl }
}

async function runWithTrace(client, fn) {
  const events = []
  const onData = payload => {
    if (Array.isArray(payload.value))
      events.push(...payload.value)
  }
  client.on('Tracing.dataCollected', onData)
  const complete = new Promise(resolve => client.once('Tracing.tracingComplete', resolve))
  await client.send('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing,v8.execute',
    options: 'sampling-frequency=10000',
  })
  let result
  try {
    result = await fn()
  }
  finally {
    await client.send('Tracing.end')
    await complete
    client.off?.('Tracing.dataCollected', onData)
  }
  return { result, events }
}

async function runScenario(page, client, name) {
  await client.send('Performance.enable')
  const before = metricMap(await client.send('Performance.getMetrics'))
  const wallStart = Date.now()
  const { result, events } = await runWithTrace(client, () =>
    page.evaluate(scenarioName => window.__SM_PERF__.runScenario(scenarioName), name),
  )
  const wallMs = Date.now() - wallStart
  const after = metricMap(await client.send('Performance.getMetrics'))
  const delta = diffMetricMap(before, after)
  const operations = result.operations || 1
  const timeline = summarizeTimeline(events, operations)
  const cdp = {
    wallMs,
    taskDurationMs: round((delta.TaskDuration || 0) * 1000),
    scriptDurationMs: round((delta.ScriptDuration || 0) * 1000),
    layoutDurationMs: round((delta.LayoutDuration || 0) * 1000),
    recalcStyleDurationMs: round((delta.RecalcStyleDuration || 0) * 1000),
    layoutCount: round(delta.LayoutCount || 0, 0),
    recalcStyleCount: round(delta.RecalcStyleCount || 0, 0),
    jsHeapUsedDeltaMB: round((delta.JSHeapUsedSize || 0) / 1024 / 1024),
    mainThreadBusyRatio: wallMs > 0 ? round(((delta.TaskDuration || 0) * 1000) / wallMs, 4) : 0,
  }
  return {
    name,
    entry,
    ...result,
    sampleSummary: result.sampleSummary || summarizeSamples(result.samples),
    cdp,
    timeline,
  }
}

function compareValue(failures, name, metric, actual, limit, unit = '') {
  if (typeof limit !== 'number' || !Number.isFinite(limit))
    return
  if (typeof actual !== 'number' || !Number.isFinite(actual))
    return
  if (actual > limit)
    failures.push(`${name}: ${metric}=${round(actual)}${unit} > budget ${limit}${unit}`)
}

function checkHardBudgets(results, budget) {
  const failures = []
  const scenarioBudgets = budget.scenarioBudgets || {}
  for (const result of results) {
    const b = scenarioBudgets[result.name]
    if (!b)
      continue
    compareValue(failures, result.name, 'sampleSummary.p95', result.sampleSummary?.p95, b.sampleP95Ms, 'ms')
    compareValue(failures, result.name, 'sampleSummary.max', result.sampleSummary?.max, b.sampleMaxMs, 'ms')
    compareValue(failures, result.name, 'wallMs', result.wallMs || result.cdp?.wallMs, b.wallMs, 'ms')
    compareValue(failures, result.name, 'longTaskCount', result.longTasks?.count, b.longTaskCount)
    compareValue(failures, result.name, 'maxLongTaskMs', result.longTasks?.maxMs, b.maxLongTaskMs, 'ms')
    compareValue(failures, result.name, 'mainThreadBusyRatio', result.cdp?.mainThreadBusyRatio, b.mainThreadBusyRatio)
    compareValue(failures, result.name, 'layoutCount', result.cdp?.layoutCount, b.layoutCount)
    compareValue(failures, result.name, 'recalcStyleCount', result.cdp?.recalcStyleCount, b.recalcStyleCount)
    compareValue(failures, result.name, 'Layout.perOperation', result.timeline?.Layout?.perOperation, b.layoutPerOperation)
    const recalcPerOp = result.timeline?.RecalculateStyles?.perOperation || result.timeline?.UpdateLayoutTree?.perOperation
    compareValue(failures, result.name, 'StyleRecalc.perOperation', recalcPerOp, b.recalcStylePerOperation)
    compareValue(failures, result.name, 'Paint.perOperation', result.timeline?.Paint?.perOperation, b.paintPerOperation)
  }
  return failures
}

function checkBaseline(results, baseline, tolerance) {
  const failures = []
  if (!baseline?.results)
    return failures
  const baselineByName = new Map(baseline.results.map(r => [r.name, r]))
  for (const result of results) {
    const prev = baselineByName.get(result.name)
    if (!prev)
      continue
    const hasSampleSet = (result.sampleSummary?.count || 0) > 1 && (prev.sampleSummary?.count || 0) > 1
    const metrics = [
      ['cdp.mainThreadBusyRatio', result.cdp?.mainThreadBusyRatio, prev.cdp?.mainThreadBusyRatio, 0.08],
      ['cdp.layoutCount', result.cdp?.layoutCount, prev.cdp?.layoutCount, 8],
      ['cdp.recalcStyleCount', result.cdp?.recalcStyleCount, prev.cdp?.recalcStyleCount, 8],
      ['longTasks.count', result.longTasks?.count, prev.longTasks?.count, 1],
      ['timeline.Paint.count', result.timeline?.Paint?.count, prev.timeline?.Paint?.count, 8],
    ]
    if (hasSampleSet) {
      metrics.push(
        ['sampleSummary.p95', result.sampleSummary?.p95, prev.sampleSummary?.p95, 12],
        ['sampleSummary.max', result.sampleSummary?.max, prev.sampleSummary?.max, 20],
      )
    }
    for (const [metric, actual, old, floor] of metrics) {
      if (typeof actual !== 'number' || typeof old !== 'number' || !Number.isFinite(actual) || !Number.isFinite(old))
        continue
      const limit = old * (1 + tolerance) + floor
      if (actual > limit)
        failures.push(`${result.name}: ${metric}=${round(actual)} regressed from baseline ${round(old)}; limit ${round(limit)}`)
    }
  }
  return failures
}

function printSummary(results) {
  const rows = results.map(r => ({
    scenario: r.name,
    ops: r.operations,
    p95: r.sampleSummary?.p95,
    max: r.sampleSummary?.max,
    wallMs: r.wallMs || r.cdp?.wallMs,
    longTasks: r.longTasks?.count,
    maxLongTask: r.longTasks?.maxMs,
    busy: r.cdp?.mainThreadBusyRatio,
    layout: r.cdp?.layoutCount,
    style: r.cdp?.recalcStyleCount,
    paintPerOp: r.timeline?.Paint?.perOperation,
  }))
  console.table(rows)
}

async function main() {
  await mkdir(perfDir, { recursive: true })
  await rm(perfAppDir, { recursive: true, force: true })
  await writePerfApp()
  const budget = await readJsonIfExists(budgetPath, { tolerance: 0.25, scenarioBudgets: {} })
  const baseline = await readJsonIfExists(baselinePath, null)
  const { server, baseUrl } = await startVite()
  const browser = await chromium.launch({
    headless: !headed,
    args: [
      '--js-flags=--expose-gc',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const client = await context.newCDPSession(page)
  const url = new URL('/scripts/.perf-app/index.html', baseUrl).toString()
  const results = []

  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    for (const scenario of SCENARIOS) {
      for (let i = 0; i < repeat; i++) {
        const name = repeat > 1 ? `${scenario}#${i + 1}` : scenario
        console.log(`Running ${name} (${entry})`)
        const result = await runScenario(page, client, scenario)
        if (repeat > 1)
          result.repeatIndex = i + 1
        results.push(result)
      }
    }
  }
  finally {
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
  }

  const report = {
    generatedAt: nowIso(),
    entry,
    scenarios: SCENARIOS,
    repeat,
    results,
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  printSummary(results)
  console.log(`Performance report written to ${path.relative(root, reportPath)}`)

  if (updateBaseline) {
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Baseline updated at ${path.relative(root, baselinePath)}`)
    return
  }

  const failures = [
    ...checkHardBudgets(results, budget),
    ...checkBaseline(results, baseline, budget.tolerance ?? 0.25),
  ]
  if (failures.length) {
    console.error('\nPerformance gate failed:')
    for (const failure of failures)
      console.error(`- ${failure}`)
    if (!reportOnly)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
