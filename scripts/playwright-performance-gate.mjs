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
const markdownReportPath = path.join(perfDir, 'stream-monaco-performance-report.md')
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
const requireBaseline = has('--require-baseline')
const headed = has('--headed')
const scenarioFilter = getArg('--scenario', '')
const repeat = Number(getArg('--repeat', '1'))

const SCENARIOS = [
  'editor-cold-first-highlight-default-options',
  'editor-cold-first-highlight',
  'editor-warm-first-highlight',
  'editor-update-highlight',
  'editor-middle-replace-large-doc',
  'editor-stream-burst',
  'diff-cold-first-highlight-default-options',
  'diff-cold-first-highlight',
  'diff-update-highlight',
  'diff-middle-replace-large-doc',
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
  | 'editor-cold-first-highlight-default-options'
  | 'editor-cold-first-highlight'
  | 'editor-warm-first-highlight'
  | 'editor-update-highlight'
  | 'editor-middle-replace-large-doc'
  | 'editor-stream-burst'
  | 'diff-cold-first-highlight-default-options'
  | 'diff-cold-first-highlight'
  | 'diff-update-highlight'
  | 'diff-middle-replace-large-doc'
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

function getVisibleLineWithText(container: HTMLElement, text: string) {
  const lines = Array.from(container.querySelectorAll('.view-line'))
  return lines.find(line => (line.textContent || '').includes(text)) || null
}

function hasMeaningfulTokenization(line: Element | null) {
  if (!line)
    return false
  const tokenClasses = new Set<string>()
  for (const span of Array.from(line.querySelectorAll('span'))) {
    const className = String(span.className || '')
    const hits = className.match(/\\bmtk\\d+\\b/g)
    if (hits) {
      for (const hit of hits)
        tokenClasses.add(hit)
    }
  }
  return tokenClasses.size >= 3
}

async function waitForHighlight(container: HTMLElement, marker?: string, timeoutMs = 8000) {
  return waitUntil(
    () => {
      if (!marker)
        return !!container.querySelector('.view-line span[class*="mtk"]')
      return hasMeaningfulTokenization(getVisibleLineWithText(container, marker))
    },
    timeoutMs,
    marker ? \`highlight marker \${marker}\` : 'highlight tokens',
  )
}

function getLineChangeSignature(diffEditor: any) {
  const changes = diffEditor.getLineChanges?.()
  if (!changes)
    return null
  return JSON.stringify(changes.map((change: any) => [
    change.originalStartLineNumber,
    change.originalEndLineNumber,
    change.modifiedStartLineNumber,
    change.modifiedEndLineNumber,
  ]))
}

function waitForDiffSettled(api: ReturnType<typeof useMonaco>, startedAt = performance.now(), timeoutMs = 1000) {
  const diffEditor = api.getDiffEditorView()
  if (!diffEditor)
    return Promise.resolve(null)
  return new Promise<number | null>((resolve) => {
    let done = false
    let disposable: { dispose?: () => void } | null = null
    let timer: ReturnType<typeof setTimeout>
    let lastSignature: string | null = null
    let stableFrames = 0
    const finish = (fn: () => void) => {
      if (done)
        return
      done = true
      clearTimeout(timer)
      try { disposable?.dispose?.() }
      catch {}
      fn()
    }
    const resolveAfterFrames = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve(performance.now() - startedAt))
      })
    }
    const poll = () => {
      if (done)
        return
      const signature = getLineChangeSignature(diffEditor)
      if (signature) {
        if (signature === lastSignature)
          stableFrames += 1
        else {
          lastSignature = signature
          stableFrames = 0
        }
        if (stableFrames >= 2) {
          finish(resolveAfterFrames)
          return
        }
      }
      requestAnimationFrame(poll)
    }
    timer = setTimeout(() => {
      finish(() => resolve(null))
    }, timeoutMs)
    disposable = diffEditor.onDidUpdateDiff(() => {
      finish(resolveAfterFrames)
    })
    requestAnimationFrame(poll)
  })
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

async function runEditorFirstHighlight(cold: boolean, defaultOptions = false) {
  resetRoot()
  clearHighlighterCache()

  // Keep warm measurement local to this scenario; other scenarios run isolated.
  if (!cold) {
    const primer = createContainer('editor-warm-primer')
    const primerApi = useMonaco(baseOptions({ updateThrottleMs: 0, autoScrollInitial: false }))
    await primerApi.createEditor(
      primer,
      makeTsCode(40, 'SM_WARM_PRIMER'),
      'typescript',
    )
    await waitForHighlight(primer, 'SM_WARM_PRIMER')
    primerApi.cleanupEditor()
    resetRoot()
  }

  const longTasks = observeLongTasks()
  const container = createContainer(cold ? 'editor-cold' : 'editor-warm')
  const api = useMonaco(defaultOptions ? {} : baseOptions({ updateThrottleMs: 0, autoScrollInitial: false }))
  const marker = defaultOptions ? 'SM_DEFAULT_COLD_FIRST' : cold ? 'SM_COLD_FIRST' : 'SM_WARM_FIRST'
  let code = makeTsCode(cold ? 320 : 180, marker)
  if (defaultOptions)
    code += '\\nconsole.log("' + marker + '")'
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

async function runEditorMiddleReplaceLargeDoc() {
  resetRoot()
  const longTasks = observeLongTasks()
  const container = createContainer('editor-middle-replace')
  const api = useMonaco(baseOptions({
    updateThrottleMs: 0,
    revealBatchOnIdleMs: 0,
    autoScrollInitial: false,
    autoScrollOnUpdate: false,
  }))
  const lines = makeTsCode(1400, 'SM_MIDDLE_REPLACE_BASE').split('\\n')
  const targetLineIndex = Math.floor(lines.length / 2)
  let code = lines.join('\\n')
  await api.createEditor(container, code, 'typescript')
  await waitForHighlight(container, 'SM_MIDDLE_REPLACE_BASE')

  const samples: number[] = []
  for (let i = 0; i < 30; i++) {
    const marker = \`SM_MIDDLE_REPLACE_\${i}\`
    lines[targetLineIndex] = \`export function middle_replace_\${i}() { return "\${marker}" }\`
    code = lines.join('\\n')
    const start = performance.now()
    api.updateCode(code, 'typescript')
    await waitUntil(() => api.getEditorView()?.getModel()?.getValue() === code, 5000, 'editor middle replace model update')
    await twoFrames()
    samples.push(performance.now() - start)
  }
  await twoFrames()
  api.cleanupEditor()
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    chars: code.length,
    lines: lines.length,
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
  let finalMarker = 'SM_BURST_BASE'
  for (let i = 0; i < operations; i++) {
    finalMarker = \`SM_BURST_\${i}\`
    code += \`console.log("\${finalMarker}", \${i})\\n\`
    api.updateCode(code, 'typescript')
    await sleep(5)
  }
  await waitUntil(() => api.getEditorView()?.getModel()?.getValue() === code, 10000, 'editor burst final model')
  await waitForHighlight(container, finalMarker, 8000)
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

async function runDiffFirstHighlight(defaultOptions = false) {
  resetRoot()
  clearHighlighterCache()
  const longTasks = observeLongTasks()
  const container = createContainer('diff-cold')
  const api = useMonaco(defaultOptions ? {} : baseOptions({ diffUpdateThrottleMs: 0, renderSideBySide: true, autoScrollInitial: false }))
  const original = makeTsCode(220, defaultOptions ? 'SM_DEFAULT_DIFF_ORIGINAL' : 'SM_DIFF_ORIGINAL')
  const modifiedMarker = defaultOptions ? 'SM_DEFAULT_DIFF_MODIFIED' : 'SM_DIFF_MODIFIED'
  let modified = makeTsCode(220, modifiedMarker) + '\\nexport const changed = 1\\n'
  if (defaultOptions) {
    const modifiedLines = modified.split('\\n')
    for (let i = 20; i < modifiedLines.length; i += 20)
      modifiedLines[i] += ' // ' + modifiedMarker
    modified = modifiedLines.join('\\n')
  }
  const start = performance.now()
  await api.createDiffEditor(container, original, modified, 'typescript')
  await waitForHighlight(container, modifiedMarker)
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
  const diffComputeSamples: number[] = []
  let diffSettleUnavailable = false

  for (let i = 0; i < 60; i++) {
    const marker = \`SM_DIFF_UPDATE_\${i}\`
    modified = modified.replace(/^export const .* = true/m, \`export const \${marker} = true\`)
    const start = performance.now()
    api.updateDiff(original, modified, 'typescript')
    await waitUntil(() => api.getDiffModels().modified?.getValue() === modified, 5000, 'diff modified model update')
    const diffSettled = diffSettleUnavailable ? null : waitForDiffSettled(api, start)
    await waitForHighlight(container, marker, 5000)
    samples.push(performance.now() - start)
    const diffComputeMs = await diffSettled
    if (typeof diffComputeMs === 'number')
      diffComputeSamples.push(diffComputeMs)
    else if (diffSettled)
      diffSettleUnavailable = true
  }
  await twoFrames()
  api.cleanupEditor()
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    diffComputeSummary: summarizeNumbers(diffComputeSamples),
    diffSettleUnavailable,
    longTasks: summarizeLongTasks(longTasks.stop()),
  }
}

async function runDiffMiddleReplaceLargeDoc() {
  resetRoot()
  const longTasks = observeLongTasks()
  const container = createContainer('diff-middle-replace')
  const api = useMonaco(baseOptions({
    diffUpdateThrottleMs: 0,
    renderSideBySide: true,
    revealBatchOnIdleMs: 0,
    autoScrollInitial: false,
    autoScrollOnUpdate: false,
  }))
  const originalLines = makeTsCode(1100, 'SM_DIFF_MIDDLE_REPLACE_O').split('\\n')
  const modifiedLines = makeTsCode(1100, 'SM_DIFF_MIDDLE_REPLACE_BASE').split('\\n')
  const targetLineIndex = Math.floor(modifiedLines.length / 2)
  const original = originalLines.join('\\n')
  let modified = modifiedLines.join('\\n')
  await api.createDiffEditor(container, original, modified, 'typescript')
  await waitForHighlight(container, 'SM_DIFF_MIDDLE_REPLACE_BASE')

  const samples: number[] = []
  const diffComputeSamples: number[] = []
  let diffSettleUnavailable = false
  for (let i = 0; i < 24; i++) {
    const marker = \`SM_DIFF_MIDDLE_REPLACE_\${i}\`
    modifiedLines[targetLineIndex] = \`export function diff_middle_replace_\${i}() { return "\${marker}" }\`
    modified = modifiedLines.join('\\n')
    const start = performance.now()
    api.updateDiff(original, modified, 'typescript')
    await waitUntil(() => api.getDiffModels().modified?.getValue() === modified, 6000, 'diff middle replace model update')
    const diffSettled = diffSettleUnavailable ? null : waitForDiffSettled(api, start)
    await twoFrames()
    samples.push(performance.now() - start)
    const diffComputeMs = await diffSettled
    if (typeof diffComputeMs === 'number')
      diffComputeSamples.push(diffComputeMs)
    else if (diffSettled)
      diffSettleUnavailable = true
  }
  await twoFrames()
  api.cleanupEditor()
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    diffComputeSummary: summarizeNumbers(diffComputeSamples),
    diffSettleUnavailable,
    chars: original.length + modified.length,
    lines: modifiedLines.length,
    longTasks: summarizeLongTasks(longTasks.stop()),
  }
}

async function runDiffStreamBurst() {
  resetRoot()
  const longTasks = observeLongTasks()
  const container = createContainer('diff-burst')
  const api = useMonaco(baseOptions({ diffUpdateThrottleMs: 50, renderSideBySide: true, revealBatchOnIdleMs: 200 }))
  const original = makeTsCode(80, 'SM_DIFF_BURST_O')
  let modified = makeTsCode(80, 'SM_DIFF_BURST_M') + '\\nconsole.log("SM_DIFF_BURST_M")'
  await api.createDiffEditor(container, original, modified, 'typescript')
  await waitForHighlight(container, 'SM_DIFF_BURST_M')
  const start = performance.now()
  const operations = 500
  let finalMarker = 'SM_DIFF_BURST_M'
  for (let i = 0; i < operations; i++) {
    finalMarker = \`SM_DIFF_BURST_\${i}\`
    const text = \`\\nconsole.log("\${finalMarker}", \${i})\`
    modified += text
    api.appendModified(text, 'typescript')
    await sleep(5)
  }
  await waitUntil(() => api.getDiffModels().modified?.getValue() === modified, 12000, 'diff burst final model')
  const diffSettled = waitForDiffSettled(api, performance.now())
  await waitForHighlight(container, finalMarker, 8000)
  await sleep(300)
  const wallMs = performance.now() - start
  const diffComputeMs = await diffSettled
  api.cleanupEditor()
  return {
    operations,
    wallMs,
    samples: [wallMs],
    sampleSummary: summarizeNumbers([wallMs]),
    diffComputeSummary: typeof diffComputeMs === 'number' ? summarizeNumbers([diffComputeMs]) : summarizeNumbers([]),
    diffSettleUnavailable: diffComputeMs == null,
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
    if (name === 'editor-cold-first-highlight-default-options')
      return runEditorFirstHighlight(true, true)
    if (name === 'editor-cold-first-highlight')
      return runEditorFirstHighlight(true)
    if (name === 'editor-warm-first-highlight')
      return runEditorFirstHighlight(false)
    if (name === 'editor-update-highlight')
      return runEditorUpdateHighlight()
    if (name === 'editor-middle-replace-large-doc')
      return runEditorMiddleReplaceLargeDoc()
    if (name === 'editor-stream-burst')
      return runEditorStreamBurst()
    if (name === 'diff-cold-first-highlight-default-options')
      return runDiffFirstHighlight(true)
    if (name === 'diff-cold-first-highlight')
      return runDiffFirstHighlight()
    if (name === 'diff-update-highlight')
      return runDiffUpdateHighlight()
    if (name === 'diff-middle-replace-large-doc')
      return runDiffMiddleReplaceLargeDoc()
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

function stylePerOperation(result) {
  return (
    result.timeline?.UpdateLayoutTree?.perOperation
    || result.timeline?.RecalculateStyles?.perOperation
    || 0
  )
}

function classifyScenario(result, budgetForScenario = {}) {
  const issues = []
  const p95 = result.sampleSummary?.p95 ?? 0
  const max = result.sampleSummary?.max ?? 0
  const wallMs = result.wallMs || result.cdp?.wallMs || 0
  const busy = result.cdp?.mainThreadBusyRatio ?? 0
  const taskMs = result.cdp?.taskDurationMs ?? 0
  const scriptMs = result.cdp?.scriptDurationMs ?? 0
  const layoutCount = result.cdp?.layoutCount ?? 0
  const recalcStyleCount = result.cdp?.recalcStyleCount ?? 0
  const layoutPerOp = result.timeline?.Layout?.perOperation ?? 0
  const stylePerOp = stylePerOperation(result)
  const paintPerOp = result.timeline?.Paint?.perOperation ?? 0
  const longTasks = result.longTasks?.count ?? 0
  const maxLongTaskMs = result.longTasks?.maxMs ?? 0
  const diffComputeP95 = result.diffComputeSummary?.p95 ?? 0

  const addIssue = (condition, issue) => {
    if (condition)
      issues.push(issue)
  }

  addIssue(p95 > (budgetForScenario.sampleP95Ms ?? Infinity), {
    severity: p95 > (budgetForScenario.sampleP95Ms ?? Infinity) * 1.5 ? 'high' : 'medium',
    type: 'latency',
    message: `p95 ${round(p95)}ms exceeds budget ${budgetForScenario.sampleP95Ms}ms`,
  })
  addIssue(max > (budgetForScenario.sampleMaxMs ?? Infinity), {
    severity: 'medium',
    type: 'latency',
    message: `max ${round(max)}ms exceeds budget ${budgetForScenario.sampleMaxMs}ms`,
  })
  addIssue(wallMs > (budgetForScenario.wallMs ?? Infinity), {
    severity: 'high',
    type: 'wall-time',
    message: `wallMs ${round(wallMs)}ms exceeds budget ${budgetForScenario.wallMs}ms`,
  })
  addIssue(longTasks > (budgetForScenario.longTaskCount ?? Infinity), {
    severity: 'high',
    type: 'long-task',
    message: `${longTasks} long tasks, max ${round(maxLongTaskMs)}ms`,
    cause: 'main-thread work is not chunked enough or diff/tokenization/layout is blocking',
  })
  addIssue(maxLongTaskMs > (budgetForScenario.maxLongTaskMs ?? Infinity), {
    severity: 'high',
    type: 'long-task',
    message: `max long task ${round(maxLongTaskMs)}ms exceeds budget ${budgetForScenario.maxLongTaskMs}ms`,
    cause: 'a single update flush is doing too much work before yielding',
  })
  addIssue(busy > (budgetForScenario.mainThreadBusyRatio ?? Infinity), {
    severity: 'high',
    type: 'cpu',
    message: `mainThreadBusyRatio=${busy}`,
    cause: scriptMs > taskMs * 0.6
      ? 'script/tokenization/model-edit dominated'
      : 'browser rendering/layout dominated',
  })
  addIssue(layoutCount > (budgetForScenario.layoutCount ?? Infinity), {
    severity: 'medium',
    type: 'layout',
    message: `LayoutCount=${layoutCount}`,
    cause: 'height sync, scroll/reveal, or DOM measurement is happening too often',
  })
  addIssue(recalcStyleCount > (budgetForScenario.recalcStyleCount ?? Infinity), {
    severity: 'medium',
    type: 'style',
    message: `RecalcStyleCount=${recalcStyleCount}`,
    cause: 'class/style changes or Monaco/diff DOM mutations are causing style recalculation',
  })
  addIssue(layoutPerOp > (budgetForScenario.layoutPerOperation ?? Infinity), {
    severity: 'high',
    type: 'layout',
    message: `Layout.perOperation=${layoutPerOp}`,
    cause: 'height sync, scroll/reveal, or DOM measurement is happening too often',
  })
  addIssue(stylePerOp > (budgetForScenario.recalcStylePerOperation ?? Infinity), {
    severity: 'medium',
    type: 'style',
    message: `StyleRecalc.perOperation=${stylePerOp}`,
    cause: 'class/style changes or Monaco/diff DOM mutations are causing style recalculation',
  })
  addIssue(paintPerOp > (budgetForScenario.paintPerOperation ?? Infinity), {
    severity: 'medium',
    type: 'paint',
    message: `Paint.perOperation=${paintPerOp}`,
    cause: 'decorations, diff overlays, or visible token DOM are repainting too often',
  })

  return {
    status: issues.some(issue => issue.severity === 'high')
      ? 'needs-fix'
      : issues.length ? 'watch' : 'ok',
    dominantCause: pickDominantCause({ scriptMs, layoutPerOp, stylePerOp, paintPerOp, longTasks, diffComputeP95 }),
    issues,
    recommendation: recommendFix(result.name, issues),
    debug: { p95, max, wallMs, busy, taskMs, scriptMs, layoutCount, recalcStyleCount, layoutPerOp, stylePerOp, paintPerOp, diffComputeP95 },
  }
}

function pickDominantCause({ scriptMs, layoutPerOp, stylePerOp, paintPerOp, longTasks, diffComputeP95 }) {
  if (diffComputeP95 > 50)
    return 'diff compute'
  if (longTasks > 0 && scriptMs > 100)
    return 'main-thread script/tokenization'
  if (layoutPerOp > 2)
    return 'layout / height / scroll reveal'
  if (stylePerOp > 4)
    return 'style recalculation'
  if (paintPerOp > 4)
    return 'paint / decoration rendering'
  return 'within-noise-or-mixed'
}

function recommendFix(name, issues) {
  const types = new Set(issues.map(issue => issue.type))

  if (name.includes('cold-first-highlight')) {
    return [
      'Keep create-time language registration limited to the requested language unless languages are explicitly provided.',
      'Use registerMonacoThemes() before first render when an app intentionally wants to preload many languages.',
      'Compare the default-options and narrow-languages cold scenarios before changing hard budgets.',
    ]
  }

  if (name.includes('diff') && types.has('layout')) {
    return [
      'Coalesce diff height sync and layout-to-container scheduling during streaming.',
      'Avoid immediate reveal on every append; prefer idle-batched final reveal while streaming continues.',
      'Use diffComputeSummary to separate Monaco diff cost from layout/paint cost.',
    ]
  }

  if (name.includes('stream') && types.has('long-task')) {
    return [
      'Split large appends into smaller chunks with RAF/yield between chunks.',
      'Prefer appendCode/appendModified for true streaming instead of repeatedly sending full snapshots.',
      'Increase updateThrottleMs/diffUpdateThrottleMs under heavy stream input.',
    ]
  }

  if (name.includes('middle-replace')) {
    return [
      'Inspect minimal edit scan cost before changing layout code.',
      'Keep minimalEditMaxChars and minimalEditMaxChangeRatio guards aligned with large-document replacement results.',
    ]
  }

  if (types.has('style') || types.has('paint')) {
    return [
      'Reduce decoration churn and avoid replacing overlay DOM when the visual state is unchanged.',
      'Avoid forcing theme/diff appearance class updates during every diff update.',
    ]
  }

  return ['No obvious single bottleneck; inspect trace and compare against baseline deltas.']
}

function attachAnalysis(report, budget) {
  const scenarioBudgets = budget.scenarioBudgets || {}
  return {
    ...report,
    results: report.results.map(result => ({
      ...result,
      analysis: classifyScenario(result, scenarioBudgets[result.name]),
    })),
  }
}

function buildMarkdownReport(report) {
  const lines = []
  lines.push('# stream-monaco performance report')
  lines.push('')
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(`Entry: ${report.entry}`)
  lines.push('')

  for (const result of report.results) {
    const analysis = result.analysis
    lines.push(`## ${result.name}`)
    lines.push('')
    lines.push(`Status: **${analysis.status}**`)
    lines.push(`Dominant cause: **${analysis.dominantCause}**`)
    lines.push('')
    lines.push('| metric | value |')
    lines.push('|---|---:|')
    lines.push(`| ops | ${result.operations ?? 1} |`)
    lines.push(`| p95 | ${result.sampleSummary?.p95 ?? 0}ms |`)
    lines.push(`| max | ${result.sampleSummary?.max ?? 0}ms |`)
    lines.push(`| wall | ${result.wallMs || result.cdp?.wallMs || 0}ms |`)
    lines.push(`| long tasks | ${result.longTasks?.count ?? 0} |`)
    lines.push(`| max long task | ${result.longTasks?.maxMs ?? 0}ms |`)
    lines.push(`| busy ratio | ${result.cdp?.mainThreadBusyRatio ?? 0} |`)
    lines.push(`| layout/op | ${result.timeline?.Layout?.perOperation ?? 0} |`)
    lines.push(`| style/op | ${stylePerOperation(result)} |`)
    lines.push(`| paint/op | ${result.timeline?.Paint?.perOperation ?? 0} |`)
    if (result.diffComputeSummary)
      lines.push(`| diff compute p95 | ${result.diffComputeSummary.p95}ms |`)
    if (result.diffSettleUnavailable)
      lines.push('| diff settled signal | unavailable |')
    lines.push('')

    if (analysis.issues.length) {
      lines.push('Issues:')
      for (const issue of analysis.issues) {
        const cause = issue.cause ? ` - ${issue.cause}` : ''
        lines.push(`- [${issue.severity}] ${issue.message}${cause}`)
      }
      lines.push('')
    }

    lines.push('Recommended fixes:')
    for (const item of analysis.recommendation)
      lines.push(`- ${item}`)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
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

function checkBaseline(results, baseline, tolerance, requireAllScenarios = false) {
  const failures = []
  if (!baseline?.results)
    return failures
  const baselineByName = new Map(baseline.results.map(r => [r.name, r]))
  for (const result of results) {
    const prev = baselineByName.get(result.name)
    if (!prev) {
      if (requireAllScenarios)
        failures.push(`${result.name}: missing baseline entry`)
      continue
    }
    const hasSampleSet = (result.sampleSummary?.count || 0) > 1 && (prev.sampleSummary?.count || 0) > 1
    const metrics = [
      ['cdp.mainThreadBusyRatio', result.cdp?.mainThreadBusyRatio, prev.cdp?.mainThreadBusyRatio, 0.08],
      ['cdp.layoutCount', result.cdp?.layoutCount, prev.cdp?.layoutCount, 8],
      ['cdp.recalcStyleCount', result.cdp?.recalcStyleCount, prev.cdp?.recalcStyleCount, 8],
      ['longTasks.count', result.longTasks?.count, prev.longTasks?.count, 1],
      ['timeline.Paint.count', result.timeline?.Paint?.count, prev.timeline?.Paint?.count, 8],
      ['diffComputeSummary.p95', result.diffComputeSummary?.p95, prev.diffComputeSummary?.p95, 12],
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
  const url = new URL('/scripts/.perf-app/index.html', baseUrl).toString()
  const results = []

  try {
    for (const scenario of SCENARIOS) {
      for (let i = 0; i < repeat; i++) {
        const name = repeat > 1 ? `${scenario}#${i + 1}` : scenario
        console.log(`Running ${name} (${entry})`)

        // Isolate Monaco/Shiki globals and CDP metrics between scenario runs.
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
        const page = await context.newPage()
        const client = await context.newCDPSession(page)
        try {
          await page.goto(url, { waitUntil: 'networkidle' })
          const result = await runScenario(page, client, scenario)
          if (repeat > 1)
            result.repeatIndex = i + 1
          results.push(result)
        }
        finally {
          await context.close().catch(() => {})
        }
      }
    }
  }
  finally {
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
  }

  const report = attachAnalysis({
    generatedAt: nowIso(),
    entry,
    scenarios: SCENARIOS,
    repeat,
    results,
  }, budget)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(markdownReportPath, buildMarkdownReport(report))
  printSummary(results)
  console.log(`Performance report written to ${path.relative(root, reportPath)}`)
  console.log(`Markdown report written to ${path.relative(root, markdownReportPath)}`)

  if (updateBaseline) {
    await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Baseline updated at ${path.relative(root, baselinePath)}`)
    return
  }

  const failures = [
    ...(requireBaseline && !baseline?.results
      ? [
          `Missing performance baseline: ${path.relative(root, baselinePath)}`,
          'Run `pnpm perf:baseline` on a known-good commit and commit the generated file.',
        ]
      : []),
    ...checkHardBudgets(results, budget),
    ...checkBaseline(results, baseline, budget.tolerance ?? 0.25, requireBaseline),
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
