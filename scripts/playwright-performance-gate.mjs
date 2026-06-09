#!/usr/bin/env node

import process from 'node:process'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const nodeMajor = Number(process.versions.node.split('.')[0])
const nodeMinor = Number(process.versions.node.split('.')[1] || '0')
// Vite 7 requires Node >=20.19.0 || >=22.12.0
const nodeVersionOk = (nodeMajor === 20 && nodeMinor >= 19) || (nodeMajor === 22 && nodeMinor >= 12) || nodeMajor > 22
if (!nodeVersionOk)
  throw new Error(`perf gate requires Node >=20.19.0 or >=22.12.0 for Vite 7, current ${process.version}`)

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const perfDir = path.join(root, '.perf')
const perfAppDir = path.join(root, 'scripts/.perf-app')
const reportPath = path.join(perfDir, 'stream-monaco-performance-report.json')
const markdownReportPath = path.join(perfDir, 'stream-monaco-performance-report.md')
let baselinePath = path.join(root, 'scripts/performance-baseline.json')
const budgetPath = path.join(root, 'scripts/performance-budget.json')

const args = process.argv.slice(2)
const has = name => args.includes(name)
const getArg = (name, fallback) => {
  const prefix = `${name}=`
  const hit = args.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const entry = getArg('--entry', 'dist')
const validEntries = new Set(['dist', 'src'])
if (!validEntries.has(entry)) {
  console.error(`Invalid --entry=${entry}. Expected one of: ${Array.from(validEntries).join(', ')}`)
  process.exit(1)
}

const updateBaseline = has('--update-baseline')
const reportOnly = has('--report-only')
const requireBaseline = has('--require-baseline')
const skipBaseline = has('--skip-baseline')
const allowPartialBaseline = has('--allow-partial-baseline')
const headed = has('--headed')
const scenarioFilter = getArg('--scenario', '')
const repeatArgRaw = getArg('--repeat', '1')
const repeatArg = Number(repeatArgRaw)
const repeatExplicit = args.some(a => a.startsWith('--repeat='))
if (repeatExplicit && (!Number.isFinite(repeatArg) || repeatArg < 1 || !Number.isInteger(repeatArg))) {
  console.error(`Invalid --repeat=${repeatArgRaw}. Expected a positive integer.`)
  process.exit(1)
}
const repeat = Number.isFinite(repeatArg) && repeatArg >= 1
  ? Math.floor(repeatArg)
  : 1

if (skipBaseline && (updateBaseline || requireBaseline)) {
  console.error('--skip-baseline cannot be combined with --update-baseline or --require-baseline')
  process.exit(1)
}

if (updateBaseline && scenarioFilter && !allowPartialBaseline) {
  console.error('Refusing to update a partial baseline. Remove --scenario, or pass --allow-partial-baseline intentionally.')
  process.exit(1)
}

// Baseline comparison is intentionally opt-in and must be same-environment.
// The package/CI `perf:gate` script runs hard-budget checks with --skip-baseline
// so a local macOS/arm64 baseline cannot break an ubuntu/x64 CI runner.
// Use `pnpm perf:gate:baseline` only when `scripts/performance-baseline.json`
// was generated on the same runner image/runtime. With --require-baseline,
// an environment mismatch remains a hard failure by design.
if (skipBaseline)
  baselinePath = path.join(perfDir, '__stream-monaco-baseline-disabled__.json')

// Compare only stable runtime dimensions. Exact Node patch/minor versions are
// too brittle when setup-node uses a floating LTS channel. Do not include the
// lockfile hash here: dependency updates are exactly the PRs where we still want
// to detect performance regressions against the committed baseline.
const comparableBaselineEnvironmentKeys = ['platform', 'arch', 'nodeMajor', 'playwright', 'chromium']

const ALL_SCENARIOS = [
  'editor-cold-first-highlight-default-options',
  'editor-cold-first-highlight',
  'editor-warm-first-highlight',
  'editor-update-highlight',
  'editor-middle-replace-large-doc',
  'editor-stream-full-update-burst',
  'editor-stream-append-burst',
  'diff-cold-first-highlight-default-options',
  'diff-cold-first-highlight',
  'diff-cold-first-highlight-no-unchanged-regions',
  'diff-update-highlight',
  'diff-middle-replace-large-doc',
  'diff-stream-full-update-burst',
  'diff-stream-append-burst',
]
const SCENARIOS = ALL_SCENARIOS.filter(name => !scenarioFilter || name === scenarioFilter)

if (!SCENARIOS.length) {
  throw new Error(`Unknown performance scenario "${scenarioFilter}". Available scenarios: ${ALL_SCENARIOS.join(', ')}`)
}

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

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length)
    return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}

function round(n, digits = 2) {
  if (!Number.isFinite(n))
    return n
  const p = 10 ** digits
  return Math.round(n * p) / p
}

async function gitOutput(args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root })
    return stdout.trim() || null
  }
  catch {
    return null
  }
}

async function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(await readFile(file)).digest('hex')
  }
  catch {
    return null
  }
}

async function readPackageVersion(packageName) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8'))
    return packageJson.version ?? null
  }
  catch {
    return null
  }
}

async function buildEnvironment(chromiumVersion) {
  return {
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    nodeMajor,
    playwright: await readPackageVersion('playwright'),
    chromium: chromiumVersion,
    cpuModel: os.cpus()[0]?.model ?? null,
    osRelease: os.release(),
    commit: await gitOutput(['rev-parse', 'HEAD']),
    lockfileHash: await hashFile(path.join(root, 'pnpm-lock.yaml')),
  }
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
  catch (err) {
    if (err?.code === 'ENOENT')
      return fallback
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to read JSON ${path.relative(root, file)}: ${message}`)
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
  | 'editor-stream-full-update-burst'
  | 'editor-stream-append-burst'
  | 'diff-cold-first-highlight-default-options'
  | 'diff-cold-first-highlight'
  | 'diff-cold-first-highlight-no-unchanged-regions'
  | 'diff-update-highlight'
  | 'diff-middle-replace-large-doc'
  | 'diff-stream-full-update-burst'
  | 'diff-stream-append-burst'

declare global {
  interface Window {
    __SM_PERF__: {
      prepareScenario: (name: ScenarioName) => Promise<void>
      runScenario: (name: ScenarioName) => Promise<any>
    }
    __STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__?: boolean
    __STREAM_MONACO_PERF__?: {
      recordTokenize: (event: {
        language: string
        durationMs: number
        lineLength: number
        lineSample: string
        tokenCount: number
        failed: boolean
      }) => void
      recordGrammarTokenize: (event: {
        language: string
        durationMs: number
        lineLength: number
        lineSample: string
        stoppedEarly: boolean
        tokenCount: number
      }) => void
      recordThemeRegistration: (event: {
        durationMs: number
        ensureHighlighterMs: number
        patchMonacoMs: number
        themes: number
        languages: number
        patchedMonaco: boolean
      }) => void
    }
  }
}

const root = document.getElementById('root')!
let editorWarmFirstHighlightPrepared = false

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

function cleanupPerfEditor(api: ReturnType<typeof useMonaco>) {
  api.cleanupEditor()
  for (const model of api.getMonacoInstance().editor.getModels())
    model.dispose()
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

function getModelVersion(model: any) {
  return model?.getAlternativeVersionId?.() ?? 0
}

function getModelValueLength(model: any) {
  const getValueLength = model?.getValueLength
  if (typeof getValueLength === 'function')
    return getValueLength.call(model)
  return model?.getValue?.().length ?? 0
}

function waitForModelUpdate(
  getModel: () => any,
  previousVersion: number,
  expectedLength: number,
  timeoutMs: number,
  label: string,
) {
  return waitUntil(() => {
    const model = getModel()
    return !!(
      model
      && getModelVersion(model) !== previousVersion
      && getModelValueLength(model) === expectedLength
    )
  }, timeoutMs, label)
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

function roundDuration(value: number | null) {
  if (value == null)
    return null
  return Math.round(value * 100) / 100
}

function waitForFirstTokenDom(container: HTMLElement, timeoutMs = 8000) {
  return waitUntil(
    () => !!container.querySelector('.view-line span[class*="mtk"]'),
    timeoutMs,
    'first token DOM',
  )
}

function getTokenDomSummary(container: HTMLElement) {
  const tokenSpans = Array.from(container.querySelectorAll('.view-line span[class*="mtk"]'))
  const tokenClasses = new Set<string>()
  for (const span of tokenSpans) {
    const className = String(span.className || '')
    const hits = className.match(/\\bmtk\\d+\\b/g)
    if (!hits)
      continue
    for (const hit of hits)
      tokenClasses.add(hit)
  }
  return {
    viewLines: container.querySelectorAll('.view-line').length,
    tokenSpans: tokenSpans.length,
    tokenClasses: tokenClasses.size,
  }
}

function countElements(node: Node, selector: string) {
  if (node.nodeType !== Node.ELEMENT_NODE)
    return 0
  const element = node as Element
  return (element.matches(selector) ? 1 : 0) + element.querySelectorAll(selector).length
}

function createDomMutationStats() {
  return {
    records: 0,
    childListRecords: 0,
    attributeRecords: 0,
    characterDataRecords: 0,
    addedNodes: 0,
    removedNodes: 0,
    addedElements: 0,
    tokenSpanAdds: 0,
    viewLineAdds: 0,
  }
}

function observeDomMutations(container: HTMLElement) {
  let stats = createDomMutationStats()
  let observer: MutationObserver
  const applyRecord = (record: MutationRecord) => {
    stats.records += 1
    if (record.type === 'childList') {
      stats.childListRecords += 1
      stats.addedNodes += record.addedNodes.length
      stats.removedNodes += record.removedNodes.length
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE)
          stats.addedElements += 1
        stats.tokenSpanAdds += countElements(node, '.view-line span[class*="mtk"]')
        stats.viewLineAdds += countElements(node, '.view-line')
      }
      return
    }
    if (record.type === 'attributes') {
      stats.attributeRecords += 1
      return
    }
    if (record.type === 'characterData')
      stats.characterDataRecords += 1
  }
  const flushRecords = () => {
    for (const record of observer.takeRecords())
      applyRecord(record)
  }
  const take = () => {
    flushRecords()
    const out = stats
    stats = createDomMutationStats()
    return out
  }
  observer = new MutationObserver(records => {
    for (const record of records)
      applyRecord(record)
  })
  observer.observe(container, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
    characterData: true,
  })
  return {
    take,
    stop() {
      const out = take()
      observer.disconnect()
      return out
    },
  }
}

function observeTokenization() {
  const samples: {
    language: string
    durationMs: number
    lineLength: number
    lineSample: string
    tokenCount: number
    failed: boolean
  }[] = []
  const grammarSamples: {
    language: string
    durationMs: number
    lineLength: number
    lineSample: string
    stoppedEarly: boolean
    tokenCount: number
  }[] = []
  const themeRegistrations: {
    durationMs: number
    ensureHighlighterMs: number
    patchMonacoMs: number
    themes: number
    languages: number
    patchedMonaco: boolean
  }[] = []
  window.__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__ = true
  window.__STREAM_MONACO_PERF__ = {
    recordTokenize(event) {
      samples.push(event)
    },
    recordGrammarTokenize(event) {
      grammarSamples.push(event)
    },
    recordThemeRegistration(event) {
      themeRegistrations.push(event)
    },
  }
  return {
    stop() {
      delete window.__STREAM_MONACO_PERF__
      delete window.__STREAM_MONACO_ENABLE_INTERNAL_PERF_HOOKS__
      return {
        tokenization: summarizeTokenization(samples),
        grammarTokenization: summarizeGrammarTokenization(grammarSamples),
        themeRegistration: summarizeThemeRegistrations(themeRegistrations),
      }
    },
  }
}

function summarizeTokenization(samples: {
  language: string
  durationMs: number
  lineLength: number
  lineSample: string
  tokenCount: number
  failed: boolean
}[]) {
  const durations = samples.map(sample => sample.durationMs)
  const byLanguage: Record<string, { count: number, totalMs: number, maxMs: number, chars: number }> = {}
  for (const sample of samples) {
    const item = byLanguage[sample.language] || { count: 0, totalMs: 0, maxMs: 0, chars: 0 }
    item.count += 1
    item.totalMs += sample.durationMs
    item.maxMs = Math.max(item.maxMs, sample.durationMs)
    item.chars += sample.lineLength
    byLanguage[sample.language] = item
  }
  for (const item of Object.values(byLanguage)) {
    item.totalMs = roundDuration(item.totalMs) ?? 0
    item.maxMs = roundDuration(item.maxMs) ?? 0
  }
  const slowest = samples
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(sample => ({
      language: sample.language,
      durationMs: roundDuration(sample.durationMs),
      lineLength: sample.lineLength,
      tokenCount: sample.tokenCount,
      failed: sample.failed,
      lineSample: sample.lineSample,
    }))
  return {
    ...summarizeNumbers(durations),
    totalMs: roundDuration(durations.reduce((sum, value) => sum + value, 0)) ?? 0,
    chars: samples.reduce((sum, sample) => sum + sample.lineLength, 0),
    slowCountOver16Ms: samples.filter(sample => sample.durationMs > 16).length,
    slowest,
    byLanguage,
  }
}

function summarizeGrammarTokenization(samples: {
  language: string
  durationMs: number
  lineLength: number
  lineSample: string
  stoppedEarly: boolean
  tokenCount: number
}[]) {
  const durations = samples.map(sample => sample.durationMs)
  const slowest = samples
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(sample => ({
      language: sample.language,
      durationMs: roundDuration(sample.durationMs),
      lineLength: sample.lineLength,
      tokenCount: sample.tokenCount,
      stoppedEarly: sample.stoppedEarly,
      lineSample: sample.lineSample,
    }))
  return {
    ...summarizeNumbers(durations),
    totalMs: roundDuration(durations.reduce((sum, value) => sum + value, 0)) ?? 0,
    chars: samples.reduce((sum, sample) => sum + sample.lineLength, 0),
    slowCountOver16Ms: samples.filter(sample => sample.durationMs > 16).length,
    stoppedEarlyCount: samples.filter(sample => sample.stoppedEarly).length,
    slowest,
  }
}

function summarizeThemeRegistrations(samples: {
  durationMs: number
  ensureHighlighterMs: number
  patchMonacoMs: number
  themes: number
  languages: number
  patchedMonaco: boolean
}[]) {
  return {
    count: samples.length,
    totalMs: roundDuration(samples.reduce((sum, sample) => sum + sample.durationMs, 0)) ?? 0,
    ensureHighlighterMs: roundDuration(samples.reduce((sum, sample) => sum + sample.ensureHighlighterMs, 0)) ?? 0,
    patchMonacoMs: roundDuration(samples.reduce((sum, sample) => sum + sample.patchMonacoMs, 0)) ?? 0,
    patchedCount: samples.filter(sample => sample.patchedMonaco).length,
    entries: samples.map(sample => ({
      durationMs: roundDuration(sample.durationMs),
      ensureHighlighterMs: roundDuration(sample.ensureHighlighterMs),
      patchMonacoMs: roundDuration(sample.patchMonacoMs),
      themes: sample.themes,
      languages: sample.languages,
      patchedMonaco: sample.patchedMonaco,
    })),
  }
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

const diffDecorationSelector = [
  '.line-insert',
  '.line-delete',
  '.char-insert',
  '.char-delete',
  '.inline-deleted-text',
  '.inline-deleted-margin-view-zone',
  '.gutter-insert',
  '.gutter-delete',
  '.stream-monaco-fallback-line-insert',
  '.stream-monaco-fallback-line-delete',
  '.stream-monaco-fallback-inline-delete-zone',
  '.stream-monaco-fallback-inline-delete-margin',
].join(',')

function hasDiffDecorations(container: HTMLElement) {
  return !!container.querySelector(diffDecorationSelector)
}

async function waitForDiffUpdate(
  api: ReturnType<typeof useMonaco>,
  container: HTMLElement,
  previousModifiedVersion: number,
  expectedModifiedLength: number,
  startedAt = performance.now(),
  timeoutMs = 8000,
) {
  if (!api.getDiffEditorView())
    throw new Error('Diff editor was not created')

  await waitUntil(() => {
    const modifiedModel = api.getDiffModels().modified
    return !!(
      modifiedModel
      && getModelVersion(modifiedModel) !== previousModifiedVersion
      && getModelValueLength(modifiedModel) === expectedModifiedLength
    )
  }, timeoutMs, 'diff final modified model')

  await waitUntil(() => hasDiffDecorations(container), timeoutMs, 'diff decorations')
  await twoFrames()
  return performance.now() - startedAt
}

function observeLongTasks() {
  const start = performance.now()
  const entries: any[] = []
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      entries.push(
        ...list.getEntries()
          .filter(e => e.startTime >= start)
          .map(e => ({
            name: e.name,
            startTime: e.startTime,
            duration: e.duration,
          })),
      )
    })
    observer.observe({ type: 'longtask' as any })
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

function addPhaseSample(samples: Record<string, number[]>, name: string, value: number) {
  ;(samples[name] ||= []).push(value)
}

function summarizePhaseSamples(samples: Record<string, number[]>) {
  return Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [name, summarizeNumbers(values)]),
  )
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
  if (cold)
    clearHighlighterCache()
  else if (!editorWarmFirstHighlightPrepared)
    await prepareEditorWarmFirstHighlight()

  const longTasks = observeLongTasks()
  const container = createContainer(cold ? 'editor-cold' : 'editor-warm')
  const api = useMonaco(defaultOptions
    ? {}
    : baseOptions({
        updateThrottleMs: 0,
        autoScrollInitial: false,
      }))
  const marker = defaultOptions ? 'SM_DEFAULT_COLD_FIRST' : cold ? 'SM_COLD_FIRST' : 'SM_WARM_FIRST'
  let code = makeTsCode(cold ? 320 : 180, marker)
  if (defaultOptions)
    code += '\\nconsole.log("' + marker + '")'
  const tokenization = observeTokenization()
  const domMutations = observeDomMutations(container)
  const start = performance.now()
  await api.createEditor(container, code, 'typescript')
  const createdAt = performance.now()
  const createDomMutations = domMutations.take()
  await waitForFirstTokenDom(container)
  const firstTokenDomAt = performance.now()
  const firstTokenDomMutations = domMutations.take()
  await waitForHighlight(container, marker)
  const highlightedAt = performance.now()
  const highlightDomMutations = domMutations.stop()
  const perfSummary = tokenization.stop()
  const duration = highlightedAt - start
  const model = api.getEditorView()?.getModel()
  const lineCount = model?.getLineCount?.() ?? code.split('\\n').length
  const tokenDom = getTokenDomSummary(container)
  await twoFrames()
  const longTaskSummary = summarizeLongTasks(longTasks.stop())
  cleanupPerfEditor(api)
  return {
    operations: 1,
    samples: [duration],
    sampleSummary: summarizeNumbers([duration]),
    phases: {
      themeRegistrationMs: perfSummary.themeRegistration.totalMs,
      editorCreateAndSetupMs: roundDuration((createdAt - start) - perfSummary.themeRegistration.totalMs),
      createMs: roundDuration(createdAt - start),
      firstTokenDomAfterCreateMs: roundDuration(firstTokenDomAt - createdAt),
      highlightAfterFirstTokenDomMs: roundDuration(highlightedAt - firstTokenDomAt),
      highlightAfterCreateMs: roundDuration(highlightedAt - createdAt),
      totalMs: roundDuration(duration),
    },
    tokenization: perfSummary.tokenization,
    grammarTokenization: perfSummary.grammarTokenization,
    themeRegistration: perfSummary.themeRegistration,
    tokenDom,
    domMutations: {
      create: createDomMutations,
      firstTokenDomAfterCreate: firstTokenDomMutations,
      highlightAfterFirstTokenDom: highlightDomMutations,
    },
    chars: code.length,
    lines: lineCount,
    longTasks: longTaskSummary,
  }
}

async function prepareEditorWarmFirstHighlight() {
  resetRoot()
  clearHighlighterCache()
  const primer = createContainer('editor-warm-primer')
  const primerApi = useMonaco(baseOptions({ updateThrottleMs: 0, autoScrollInitial: false }))
  await primerApi.createEditor(
    primer,
    makeTsCode(40, 'SM_WARM_PRIMER'),
    'typescript',
  )
  await waitForHighlight(primer, 'SM_WARM_PRIMER')
  cleanupPerfEditor(primerApi)
  resetRoot()
  editorWarmFirstHighlightPrepared = true
}

async function runEditorUpdateHighlight() {
  resetRoot()
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
  const longTasks = observeLongTasks()
  const samples: number[] = []
  const phaseSamples: Record<string, number[]> = {}

  for (let i = 0; i < 80; i++) {
    const marker = \`SM_UPDATE_\${i}\`
    code = code.replace(/^export const .* = true/m, \`export const \${marker} = true\`)
    const previousVersion = getModelVersion(api.getEditorView()?.getModel())
    const start = performance.now()
    api.updateCode(code, 'typescript')
    const updateCalledAt = performance.now()
    await waitForModelUpdate(
      () => api.getEditorView()?.getModel(),
      previousVersion,
      code.length,
      4000,
      'editor model update',
    )
    const modelReadyAt = performance.now()
    await waitForHighlight(container, marker, 4000)
    const doneAt = performance.now()
    samples.push(doneAt - start)
    addPhaseSample(phaseSamples, 'updateCallMs', updateCalledAt - start)
    addPhaseSample(phaseSamples, 'modelReadyMs', modelReadyAt - updateCalledAt)
    addPhaseSample(phaseSamples, 'highlightReadyMs', doneAt - modelReadyAt)
    addPhaseSample(phaseSamples, 'totalMs', doneAt - start)
  }
  await twoFrames()
  const longTaskSummary = summarizeLongTasks(longTasks.stop())
  cleanupPerfEditor(api)
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    phaseSummary: summarizePhaseSamples(phaseSamples),
    longTasks: longTaskSummary,
  }
}

async function runEditorMiddleReplaceLargeDoc() {
  resetRoot()
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
  const longTasks = observeLongTasks()

  const samples: number[] = []
  const phaseSamples: Record<string, number[]> = {}
  for (let i = 0; i < 30; i++) {
    const marker = \`SM_MIDDLE_REPLACE_\${i}\`
    lines[targetLineIndex] = \`export function middle_replace_\${i}() { return "\${marker}" }\`
    code = lines.join('\\n')
    const previousVersion = getModelVersion(api.getEditorView()?.getModel())
    const start = performance.now()
    api.updateCode(code, 'typescript')
    const updateCalledAt = performance.now()
    await waitForModelUpdate(
      () => api.getEditorView()?.getModel(),
      previousVersion,
      code.length,
      5000,
      'editor middle replace model update',
    )
    const modelReadyAt = performance.now()
    await twoFrames()
    const doneAt = performance.now()
    samples.push(doneAt - start)
    addPhaseSample(phaseSamples, 'updateCallMs', updateCalledAt - start)
    addPhaseSample(phaseSamples, 'modelReadyMs', modelReadyAt - updateCalledAt)
    addPhaseSample(phaseSamples, 'settleMs', doneAt - modelReadyAt)
    addPhaseSample(phaseSamples, 'totalMs', doneAt - start)
  }
  await twoFrames()
  const longTaskSummary = summarizeLongTasks(longTasks.stop())
  cleanupPerfEditor(api)
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    phaseSummary: summarizePhaseSamples(phaseSamples),
    chars: code.length,
    lines: lines.length,
    longTasks: longTaskSummary,
  }
}

async function runEditorStreamBurst(mode: 'full-update' | 'append') {
  resetRoot()
  const container = createContainer(\`editor-burst-\${mode}\`)
  const api = useMonaco(baseOptions({ updateThrottleMs: 50, revealBatchOnIdleMs: 200 }))
  let code = 'export const SM_BURST_BASE = true\\n'
  await api.createEditor(container, code, 'typescript')
  await waitForHighlight(container, 'SM_BURST_BASE')
  const longTasks = observeLongTasks()
  const start = performance.now()
  const operations = 500
  const perOperationSleepMs = 5
  let finalMarker = 'SM_BURST_BASE'
  const streamHighlightSamples: number[] = []
  for (let i = 0; i < operations; i++) {
    finalMarker = \`SM_BURST_\${i}\`
    const text = \`console.log("\${finalMarker}", \${i})\\n\`
    code += text
    const updateStart = performance.now()
    if (mode === 'append')
      api.appendCode(text, 'typescript')
    else
      api.updateCode(code, 'typescript')
    // Sample per-update highlight latency every 20th update
    if (i % 20 === 0 && i > 0) {
      const marker = \`SM_BURST_\${i}\`
      await waitForHighlight(container, marker, 4000)
      streamHighlightSamples.push(performance.now() - updateStart)
    }
    await sleep(perOperationSleepMs)
  }
  const emitLoopDoneAt = performance.now()
  await waitUntil(() => getModelValueLength(api.getEditorView()?.getModel()) === code.length, 10000, 'editor burst final model')
  const modelReadyAt = performance.now()
  await waitForHighlight(container, finalMarker, 8000)
  const highlightReadyAt = performance.now()
  const settleMs = 250
  await sleep(settleMs)
  const settledAt = performance.now()
  const wallMs = settledAt - start
  const longTaskSummary = summarizeLongTasks(longTasks.stop())
  cleanupPerfEditor(api)
  return {
    mode,
    operations,
    wallMs,
    intentionalSleepMs: operations * perOperationSleepMs + settleMs,
    activeExcludedMs: settleMs,
    phases: {
      emitLoopMs: Math.round((emitLoopDoneAt - start) * 100) / 100,
      finalModelWaitMs: Math.round((modelReadyAt - emitLoopDoneAt) * 100) / 100,
      highlightWaitMs: Math.round((highlightReadyAt - modelReadyAt) * 100) / 100,
      settleMs: Math.round((settledAt - highlightReadyAt) * 100) / 100,
      totalMs: Math.round(wallMs * 100) / 100,
    },
    samples: [wallMs],
    sampleSummary: summarizeNumbers([wallMs]),
    streamUpdateHighlightSummary: summarizeNumbers(streamHighlightSamples),
    finalChars: code.length,
    longTasks: longTaskSummary,
  }
}

async function runDiffFirstHighlight(defaultOptions = false, extraOptions: any = {}) {
  resetRoot()
  clearHighlighterCache()
  const longTasks = observeLongTasks()
  const container = createContainer('diff-cold')
  const api = useMonaco(defaultOptions ? {} : baseOptions({
    diffUpdateThrottleMs: 0,
    renderSideBySide: true,
    autoScrollInitial: false,
    ...extraOptions,
  }))
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
  const createdAt = performance.now()
  await waitForHighlight(container, modifiedMarker)
  const highlightedAt = performance.now()
  const duration = highlightedAt - start
  await twoFrames()
  const longTaskSummary = summarizeLongTasks(longTasks.stop())
  cleanupPerfEditor(api)
  return {
    operations: 1,
    samples: [duration],
    sampleSummary: summarizeNumbers([duration]),
    phases: {
      createMs: Math.round((createdAt - start) * 100) / 100,
      highlightAfterCreateMs: Math.round((highlightedAt - createdAt) * 100) / 100,
      totalMs: Math.round(duration * 100) / 100,
    },
    options: defaultOptions ? 'default' : extraOptions,
    chars: original.length + modified.length,
    longTasks: longTaskSummary,
  }
}

async function runDiffUpdateHighlight() {
  resetRoot()
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
  const longTasks = observeLongTasks()
  const samples: number[] = []
  const phaseSamples: Record<string, number[]> = {}
  const diffComputeSamples: number[] = []

  for (let i = 0; i < 60; i++) {
    const marker = \`SM_DIFF_UPDATE_\${i}\`
    modified = modified.replace(/^export const .* = true/m, \`export const \${marker} = true\`)
    const previousVersion = getModelVersion(api.getDiffModels().modified)
    const start = performance.now()
    const diffUpdated = waitForDiffUpdate(api, container, previousVersion, modified.length, start)
    api.updateDiff(original, modified, 'typescript')
    const updateCalledAt = performance.now()
    await waitForModelUpdate(
      () => api.getDiffModels().modified,
      previousVersion,
      modified.length,
      5000,
      'diff modified model update',
    )
    const modelReadyAt = performance.now()
    await waitForHighlight(container, marker, 5000)
    const highlightedAt = performance.now()
    const diffComputeMs = await diffUpdated
    const doneAt = performance.now()
    samples.push(doneAt - start)
    addPhaseSample(phaseSamples, 'updateCallMs', updateCalledAt - start)
    addPhaseSample(phaseSamples, 'modelReadyMs', modelReadyAt - updateCalledAt)
    addPhaseSample(phaseSamples, 'highlightReadyMs', highlightedAt - modelReadyAt)
    addPhaseSample(phaseSamples, 'diffSettledMs', doneAt - highlightedAt)
    addPhaseSample(phaseSamples, 'totalMs', doneAt - start)
    diffComputeSamples.push(diffComputeMs)
  }
  await twoFrames()
  const longTaskSummary = summarizeLongTasks(longTasks.stop())
  cleanupPerfEditor(api)
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    phaseSummary: summarizePhaseSamples(phaseSamples),
    diffComputeSummary: summarizeNumbers(diffComputeSamples),
    longTasks: longTaskSummary,
  }
}

async function runDiffMiddleReplaceLargeDoc() {
  resetRoot()
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
  const longTasks = observeLongTasks()

  const samples: number[] = []
  const phaseSamples: Record<string, number[]> = {}
  const diffComputeSamples: number[] = []
  for (let i = 0; i < 24; i++) {
    const marker = \`SM_DIFF_MIDDLE_REPLACE_\${i}\`
    modifiedLines[targetLineIndex] = \`export function diff_middle_replace_\${i}() { return "\${marker}" }\`
    modified = modifiedLines.join('\\n')
    const previousVersion = getModelVersion(api.getDiffModels().modified)
    const start = performance.now()
    const diffUpdated = waitForDiffUpdate(api, container, previousVersion, modified.length, start)
    api.updateDiff(original, modified, 'typescript')
    const updateCalledAt = performance.now()
    await waitForModelUpdate(
      () => api.getDiffModels().modified,
      previousVersion,
      modified.length,
      6000,
      'diff middle replace model update',
    )
    const modelReadyAt = performance.now()
    await twoFrames()
    const settledFramesAt = performance.now()
    const diffComputeMs = await diffUpdated
    const doneAt = performance.now()
    samples.push(doneAt - start)
    addPhaseSample(phaseSamples, 'updateCallMs', updateCalledAt - start)
    addPhaseSample(phaseSamples, 'modelReadyMs', modelReadyAt - updateCalledAt)
    addPhaseSample(phaseSamples, 'frameSettleMs', settledFramesAt - modelReadyAt)
    addPhaseSample(phaseSamples, 'diffSettledMs', doneAt - settledFramesAt)
    addPhaseSample(phaseSamples, 'totalMs', doneAt - start)
    diffComputeSamples.push(diffComputeMs)
  }
  await twoFrames()
  const longTaskSummary = summarizeLongTasks(longTasks.stop())
  cleanupPerfEditor(api)
  return {
    operations: samples.length,
    samples,
    sampleSummary: summarizeNumbers(samples),
    phaseSummary: summarizePhaseSamples(phaseSamples),
    diffComputeSummary: summarizeNumbers(diffComputeSamples),
    chars: original.length + modified.length,
    lines: modifiedLines.length,
    longTasks: longTaskSummary,
  }
}

async function runDiffStreamBurst(mode: 'full-update' | 'append') {
  resetRoot()
  const container = createContainer(\`diff-burst-\${mode}\`)
  const api = useMonaco(baseOptions({ diffUpdateThrottleMs: 50, renderSideBySide: true, revealBatchOnIdleMs: 200 }))
  const original = makeTsCode(80, 'SM_DIFF_BURST_O')
  let modified = makeTsCode(80, 'SM_DIFF_BURST_M') + '\\nconsole.log("SM_DIFF_BURST_M")'
  await api.createDiffEditor(container, original, modified, 'typescript')
  await waitForHighlight(container, 'SM_DIFF_BURST_M')
  const longTasks = observeLongTasks()
  const operations = 500
  const perOperationSleepMs = 5
  const streamTexts = Array.from({ length: operations }, (_, i) => \`\\nconsole.log("SM_DIFF_BURST_\${i}", \${i})\`)
  const finalModifiedLength = modified.length + streamTexts.reduce((sum, text) => sum + text.length, 0)
  const previousVersion = getModelVersion(api.getDiffModels().modified)
  const start = performance.now()
  const diffUpdated = waitForDiffUpdate(api, container, previousVersion, finalModifiedLength, start, 15000)
  const streamHighlightSamples: number[] = []
  for (let i = 0; i < operations; i++) {
    const text = streamTexts[i]
    modified += text
    const updateStart = performance.now()
    if (mode === 'append')
      api.appendModified(text, 'typescript')
    else
      api.updateDiff(original, modified, 'typescript')
    // Sample per-update highlight latency every 20th update
    if (i % 20 === 0 && i > 0) {
      const marker = \`SM_DIFF_BURST_\${i}\`
      await waitForHighlight(container, marker, 4000)
      streamHighlightSamples.push(performance.now() - updateStart)
    }
    await sleep(perOperationSleepMs)
  }
  const emitLoopDoneAt = performance.now()
  await waitUntil(() => getModelValueLength(api.getDiffModels().modified) === modified.length, 12000, 'diff burst final model')
  const modelReadyAt = performance.now()
  const finalMarker = \`SM_DIFF_BURST_\${operations - 1}\`
  await waitForHighlight(container, finalMarker, 8000)
  const highlightReadyAt = performance.now()
  const diffComputeMs = await diffUpdated
  const diffSettledAt = performance.now()
  const settleMs = 300
  await sleep(settleMs)
  const settledAt = performance.now()
  const wallMs = settledAt - start
  const longTaskSummary = summarizeLongTasks(longTasks.stop())
  cleanupPerfEditor(api)
  return {
    mode,
    operations,
    wallMs,
    intentionalSleepMs: operations * perOperationSleepMs + settleMs,
    activeExcludedMs: settleMs,
    phases: {
      emitLoopMs: Math.round((emitLoopDoneAt - start) * 100) / 100,
      finalModelWaitMs: Math.round((modelReadyAt - emitLoopDoneAt) * 100) / 100,
      highlightWaitMs: Math.round((highlightReadyAt - modelReadyAt) * 100) / 100,
      diffSettledMs: Math.round((diffSettledAt - highlightReadyAt) * 100) / 100,
      settleMs: Math.round((settledAt - diffSettledAt) * 100) / 100,
      totalMs: Math.round(wallMs * 100) / 100,
    },
    samples: [wallMs],
    sampleSummary: summarizeNumbers([wallMs]),
    diffComputeSummary: summarizeNumbers([diffComputeMs]),
    streamUpdateHighlightSummary: summarizeNumbers(streamHighlightSamples),
    finalChars: modified.length,
    longTasks: longTaskSummary,
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
  async prepareScenario(name: ScenarioName) {
    if (name === 'editor-warm-first-highlight')
      await prepareEditorWarmFirstHighlight()
  },

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
    if (name === 'editor-stream-full-update-burst')
      return runEditorStreamBurst('full-update')
    if (name === 'editor-stream-append-burst')
      return runEditorStreamBurst('append')
    if (name === 'diff-cold-first-highlight-default-options')
      return runDiffFirstHighlight(true)
    if (name === 'diff-cold-first-highlight')
      return runDiffFirstHighlight()
    if (name === 'diff-cold-first-highlight-no-unchanged-regions')
      return runDiffFirstHighlight(false, { diffHideUnchangedRegions: false })
    if (name === 'diff-update-highlight')
      return runDiffUpdateHighlight()
    if (name === 'diff-middle-replace-large-doc')
      return runDiffMiddleReplaceLargeDoc()
    if (name === 'diff-stream-full-update-burst')
      return runDiffStreamBurst('full-update')
    if (name === 'diff-stream-append-burst')
      return runDiffStreamBurst('append')
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
  await page.evaluate(scenarioName =>
    window.__SM_PERF__.prepareScenario(scenarioName),
  name)
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
  const taskDurationMs = round((delta.TaskDuration || 0) * 1000)
  const intentionalSleepMs = result.intentionalSleepMs || 0
  const activeExcludedMs = result.activeExcludedMs || 0
  const activeWallMs = intentionalSleepMs > 0
    ? Math.max(1, wallMs - intentionalSleepMs)
    : 0
  const cdp = {
    wallMs,
    taskDurationMs,
    scriptDurationMs: round((delta.ScriptDuration || 0) * 1000),
    layoutDurationMs: round((delta.LayoutDuration || 0) * 1000),
    recalcStyleDurationMs: round((delta.RecalcStyleDuration || 0) * 1000),
    layoutCount: round(delta.LayoutCount || 0, 0),
    recalcStyleCount: round(delta.RecalcStyleCount || 0, 0),
    jsHeapUsedDeltaMB: round((delta.JSHeapUsedSize || 0) / 1024 / 1024),
    mainThreadBusyRatio: wallMs > 0 ? round(taskDurationMs / wallMs, 4) : 0,
    ...(intentionalSleepMs > 0
      ? {
          intentionalSleepMs,
          activeExcludedMs,
          activeWallMs: round(activeWallMs),
          activeBusyRatio: round(taskDurationMs / activeWallMs, 4),
        }
      : {}),
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
  const candidates = [
    result.timeline?.UpdateLayoutTree?.perOperation,
    result.timeline?.RecalculateStyles?.perOperation,
  ].filter(v => typeof v === 'number' && Number.isFinite(v))
  return candidates.length ? Math.max(...candidates) : 0
}

function classifyScenario(result, budgetForScenario = {}, globalBudget = {}) {
  const issues = []
  const p95 = result.sampleSummary?.p95 ?? 0
  const max = result.sampleSummary?.max ?? 0
  const wallMs = result.wallMs || result.cdp?.wallMs || 0
  const busy = result.cdp?.activeBusyRatio ?? result.cdp?.mainThreadBusyRatio ?? 0
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
  const tokenizationMs = result.tokenization?.totalMs ?? 0
  const streamHighlightP95 = result.streamUpdateHighlightSummary?.p95 ?? 0
  const streamHighlightMax = result.streamUpdateHighlightSummary?.max ?? 0

  // Merge global warning/fail budgets with scenario-specific overrides.
  const failBudget = { ...(globalBudget.failBudget || {}), ...budgetForScenario }
  const warningBudget = { ...(globalBudget.warningBudget || {}), ...budgetForScenario }

  const addIssue = (condition, issue) => {
    if (condition)
      issues.push(issue)
  }
  let cpuCause = 'browser rendering/layout dominated'
  if (tokenizationMs > scriptMs * 0.4)
    cpuCause = 'tokenization dominated'
  else if (scriptMs > taskMs * 0.6)
    cpuCause = 'script/tokenization/model-edit dominated'

  addIssue(p95 > (failBudget.sampleP95Ms ?? Infinity), {
    severity: p95 > (failBudget.sampleP95Ms ?? Infinity) * 1.5 ? 'high' : 'medium',
    type: 'latency',
    message: `p95 ${round(p95)}ms exceeds budget ${failBudget.sampleP95Ms}ms`,
  })
  addIssue(max > (failBudget.sampleMaxMs ?? Infinity), {
    severity: 'medium',
    type: 'latency',
    message: `max ${round(max)}ms exceeds budget ${failBudget.sampleMaxMs}ms`,
  })
  addIssue(wallMs > (failBudget.wallMs ?? Infinity), {
    severity: 'high',
    type: 'wall-time',
    message: `wallMs ${round(wallMs)}ms exceeds budget ${failBudget.wallMs}ms`,
  })
  addIssue(longTasks > (failBudget.longTaskCount ?? Infinity), {
    severity: 'high',
    type: 'long-task',
    message: `${longTasks} long tasks, max ${round(maxLongTaskMs)}ms`,
    cause: 'main-thread work is not chunked enough or diff/tokenization/layout is blocking',
  })
  addIssue(maxLongTaskMs > (failBudget.maxLongTaskMs ?? Infinity), {
    severity: 'high',
    type: 'long-task',
    message: `max long task ${round(maxLongTaskMs)}ms exceeds budget ${failBudget.maxLongTaskMs}ms`,
    cause: 'a single update flush is doing too much work before yielding',
  })
  const failBusyBudget = failBudget.activeBusyRatio ?? failBudget.mainThreadBusyRatio
  const warnBusyBudget = warningBudget.activeBusyRatio ?? warningBudget.mainThreadBusyRatio
  addIssue(typeof failBusyBudget === 'number' && busy > failBusyBudget, {
    severity: 'high',
    type: 'cpu',
    message: `busyRatio=${busy} > fail budget ${failBusyBudget}`,
    cause: cpuCause,
  })
  addIssue(typeof warnBusyBudget === 'number' && busy > warnBusyBudget && busy <= (failBusyBudget ?? Infinity), {
    severity: 'medium',
    type: 'cpu',
    message: `busyRatio=${busy} exceeds warning ${warnBusyBudget} (fail=${failBusyBudget})`,
    cause: cpuCause,
  })
  addIssue(streamHighlightP95 > (failBudget.streamUpdateHighlightP95Ms ?? Infinity), {
    severity: 'high',
    type: 'stream-highlight-latency',
    message: `stream per-update highlight p95 ${round(streamHighlightP95)}ms exceeds budget ${failBudget.streamUpdateHighlightP95Ms}ms`,
    cause: 'per-append tokenization/layout is not yielding enough between streaming updates',
  })
  addIssue(streamHighlightMax > (failBudget.streamUpdateHighlightMaxMs ?? Infinity), {
    severity: 'high',
    type: 'stream-highlight-latency',
    message: `stream per-update highlight max ${round(streamHighlightMax)}ms exceeds budget ${failBudget.streamUpdateHighlightMaxMs}ms`,
    cause: 'worst-case append is blocking rendering too long',
  })
  addIssue(layoutCount > (failBudget.layoutCount ?? Infinity), {
    severity: 'medium',
    type: 'layout',
    message: `LayoutCount=${layoutCount}`,
    cause: 'height sync, scroll/reveal, or DOM measurement is happening too often',
  })
  addIssue(recalcStyleCount > (failBudget.recalcStyleCount ?? Infinity), {
    severity: 'medium',
    type: 'style',
    message: `RecalcStyleCount=${recalcStyleCount}`,
    cause: 'class/style changes or Monaco/diff DOM mutations are causing style recalculation',
  })
  addIssue(layoutPerOp > (failBudget.layoutPerOperation ?? Infinity), {
    severity: 'high',
    type: 'layout',
    message: `Layout.perOperation=${layoutPerOp}`,
    cause: 'height sync, scroll/reveal, or DOM measurement is happening too often',
  })
  addIssue(stylePerOp > (failBudget.recalcStylePerOperation ?? Infinity), {
    severity: 'medium',
    type: 'style',
    message: `StyleRecalc.perOperation=${stylePerOp}`,
    cause: 'class/style changes or Monaco/diff DOM mutations are causing style recalculation',
  })
  addIssue(paintPerOp > (failBudget.paintPerOperation ?? Infinity), {
    severity: 'medium',
    type: 'paint',
    message: `Paint.perOperation=${paintPerOp}`,
    cause: 'decorations, diff overlays, or visible token DOM are repainting too often',
  })

  return {
    status: issues.some(issue => issue.severity === 'high')
      ? 'needs-fix'
      : issues.length ? 'watch' : 'ok',
    dominantCause: pickDominantCause({ scriptMs, tokenizationMs, layoutPerOp, stylePerOp, paintPerOp, longTasks, diffComputeP95 }),
    issues,
    recommendation: recommendFix(result.name, issues),
    debug: { p95, max, wallMs, busy, taskMs, scriptMs, tokenizationMs, layoutCount, recalcStyleCount, layoutPerOp, stylePerOp, paintPerOp, diffComputeP95 },
  }
}

function pickDominantCause({ scriptMs, tokenizationMs, layoutPerOp, stylePerOp, paintPerOp, longTasks, diffComputeP95 }) {
  if (diffComputeP95 > 50)
    return 'diff compute'
  if (tokenizationMs > 40 && tokenizationMs > scriptMs * 0.4)
    return 'tokenization CPU'
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
      'Use tokenization/themeRegistration phases to separate Shiki startup from visible token DOM before changing hard budgets.',
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
  const results = report.results.map(result => ({
    ...result,
    analysis: classifyScenario(result, scenarioBudgets[result.name], budget),
  }))
  return {
    ...report,
    results,
    diagnosis: buildDiagnosis(results),
  }
}

function buildDiagnosis(results) {
  const findings = []
  for (const result of results) {
    const action = result.analysis?.recommendation?.[0]
    for (const issue of result.analysis?.issues ?? []) {
      findings.push({
        severity: issue.severity === 'high' ? 'error' : 'warn',
        scenario: result.name,
        title: issue.type,
        detail: issue.message,
        cause: issue.cause,
        action,
      })
    }
  }
  return findings
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
    lines.push(`| task duration | ${result.cdp?.taskDurationMs ?? 0}ms |`)
    lines.push(`| script duration | ${result.cdp?.scriptDurationMs ?? 0}ms |`)
    lines.push(`| long tasks | ${result.longTasks?.count ?? 0} |`)
    lines.push(`| max long task | ${result.longTasks?.maxMs ?? 0}ms |`)
    lines.push(`| busy ratio | ${result.cdp?.mainThreadBusyRatio ?? 0} |`)
    if (result.cdp?.activeBusyRatio != null) {
      lines.push(`| active busy ratio | ${result.cdp.activeBusyRatio} |`)
      lines.push(`| active wall | ${result.cdp.activeWallMs}ms |`)
      lines.push(`| active excluded | ${result.cdp.activeExcludedMs}ms |`)
    }
    lines.push(`| layout/op | ${result.timeline?.Layout?.perOperation ?? 0} |`)
    lines.push(`| style/op | ${stylePerOperation(result)} |`)
    lines.push(`| paint/op | ${result.timeline?.Paint?.perOperation ?? 0} |`)
    if (result.diffComputeSummary)
      lines.push(`| diff compute p95 | ${result.diffComputeSummary.p95}ms |`)
    if (result.diffSettleUnavailable)
      lines.push('| diff settled signal | unavailable |')
    lines.push('')

    if (result.phases) {
      lines.push('Phases:')
      for (const [name, value] of Object.entries(result.phases)) {
        const formatted = typeof value === 'number' ? `${value}ms` : String(value)
        lines.push(`- ${name}: ${formatted}`)
      }
      lines.push('')
    }

    if (result.streamUpdateHighlightSummary && result.streamUpdateHighlightSummary.count > 0) {
      lines.push('Stream per-update highlight latency:')
      lines.push(`- samples: ${result.streamUpdateHighlightSummary.count}`)
      lines.push(`- p95: ${result.streamUpdateHighlightSummary.p95}ms`)
      lines.push(`- max: ${result.streamUpdateHighlightSummary.max}ms`)
      lines.push('')
    }

    if (result.tokenization) {
      lines.push('Tokenization:')
      lines.push(`- calls: ${result.tokenization.count}`)
      lines.push(`- total: ${result.tokenization.totalMs}ms`)
      lines.push(`- p95: ${result.tokenization.p95}ms`)
      lines.push(`- max: ${result.tokenization.max}ms`)
      lines.push(`- chars: ${result.tokenization.chars}`)
      lines.push(`- slow >16ms: ${result.tokenization.slowCountOver16Ms ?? 0}`)
      for (const sample of result.tokenization.slowest ?? [])
        lines.push(`- slowest: ${sample.durationMs}ms, len=${sample.lineLength}, tokens=${sample.tokenCount}, failed=${sample.failed}, sample=\`${sample.lineSample}\``)
      lines.push('')
    }

    if (result.grammarTokenization) {
      lines.push('Grammar tokenization:')
      lines.push(`- calls: ${result.grammarTokenization.count}`)
      lines.push(`- total: ${result.grammarTokenization.totalMs}ms`)
      lines.push(`- p95: ${result.grammarTokenization.p95}ms`)
      lines.push(`- max: ${result.grammarTokenization.max}ms`)
      lines.push(`- stoppedEarly: ${result.grammarTokenization.stoppedEarlyCount ?? 0}`)
      for (const sample of result.grammarTokenization.slowest ?? [])
        lines.push(`- slowest: ${sample.durationMs}ms, len=${sample.lineLength}, tokens=${sample.tokenCount}, stoppedEarly=${sample.stoppedEarly}, sample=\`${sample.lineSample}\``)
      lines.push('')
    }

    if (result.themeRegistration) {
      lines.push('Theme registration:')
      lines.push(`- calls: ${result.themeRegistration.count}`)
      lines.push(`- total: ${result.themeRegistration.totalMs}ms`)
      lines.push(`- ensureHighlighter: ${result.themeRegistration.ensureHighlighterMs}ms`)
      lines.push(`- patchMonaco: ${result.themeRegistration.patchMonacoMs}ms`)
      lines.push(`- patchedCount: ${result.themeRegistration.patchedCount}`)
      lines.push('')
    }

    if (result.tokenDom) {
      lines.push('Token DOM:')
      lines.push(`- viewLines: ${result.tokenDom.viewLines}`)
      lines.push(`- tokenSpans: ${result.tokenDom.tokenSpans}`)
      lines.push(`- tokenClasses: ${result.tokenDom.tokenClasses}`)
      lines.push('')
    }

    if (result.domMutations) {
      lines.push('DOM mutations:')
      for (const [phaseName, stats] of Object.entries(result.domMutations)) {
        lines.push(`- ${phaseName}: records=${stats.records}, addedNodes=${stats.addedNodes}, tokenSpanAdds=${stats.tokenSpanAdds}, viewLineAdds=${stats.viewLineAdds}`)
      }
      lines.push('')
    }

    if (result.phaseSummary) {
      lines.push('Phase p95:')
      for (const [name, summary] of Object.entries(result.phaseSummary))
        lines.push(`- ${name}: ${summary.p95}ms`)
      lines.push('')
    }

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
    const b = { ...(budget.failBudget || {}), ...(scenarioBudgets[result.name] || {}) }
    if (!b)
      continue
    compareValue(failures, result.name, 'sampleSummary.p95', result.sampleSummary?.p95, b.sampleP95Ms, 'ms')
    compareValue(failures, result.name, 'sampleSummary.max', result.sampleSummary?.max, b.sampleMaxMs, 'ms')
    compareValue(failures, result.name, 'wallMs', result.wallMs || result.cdp?.wallMs, b.wallMs, 'ms')
    compareValue(failures, result.name, 'longTaskCount', result.longTasks?.count, b.longTaskCount)
    compareValue(failures, result.name, 'maxLongTaskMs', result.longTasks?.maxMs, b.maxLongTaskMs, 'ms')
    compareValue(failures, result.name, 'mainThreadBusyRatio', result.cdp?.mainThreadBusyRatio, b.mainThreadBusyRatio)
    compareValue(failures, result.name, 'activeBusyRatio', result.cdp?.activeBusyRatio, b.activeBusyRatio)
    compareValue(failures, result.name, 'streamHighlightP95Ms', result.streamUpdateHighlightSummary?.p95, b.streamUpdateHighlightP95Ms, 'ms')
    compareValue(failures, result.name, 'streamHighlightMaxMs', result.streamUpdateHighlightSummary?.max, b.streamUpdateHighlightMaxMs, 'ms')
    compareValue(failures, result.name, 'layoutCount', result.cdp?.layoutCount, b.layoutCount)
    compareValue(failures, result.name, 'recalcStyleCount', result.cdp?.recalcStyleCount, b.recalcStyleCount)
    compareValue(failures, result.name, 'Layout.perOperation', result.timeline?.Layout?.perOperation, b.layoutPerOperation)
    const recalcPerOpCandidates = [
      result.timeline?.RecalculateStyles?.perOperation,
      result.timeline?.UpdateLayoutTree?.perOperation,
    ].filter(v => typeof v === 'number' && Number.isFinite(v))
    const recalcPerOp = recalcPerOpCandidates.length ? Math.max(...recalcPerOpCandidates) : undefined
    compareValue(failures, result.name, 'StyleRecalc.perOperation', recalcPerOp, b.recalcStylePerOperation)
    compareValue(failures, result.name, 'Paint.perOperation', result.timeline?.Paint?.perOperation, b.paintPerOperation)
  }
  return failures
}

function checkBaseline(results, baseline, tolerance, environment, options = {}) {
  const failures = []
  if (!baseline?.results)
    return failures

  const mismatches = getBaselineEnvironmentMismatches(baseline.environment, environment)
  if (mismatches.length) {
    const message = formatBaselineEnvironmentMismatch(mismatches)
    if (options.requireBaseline) {
      failures.push(message)
    }
    else {
      console.warn(message)
    }
    return failures
  }

  const baselineByName = new Map(baseline.results.map(r => [r.name, r]))
  for (const result of results) {
    const prev = baselineByName.get(result.name)
    if (!prev) {
      if (options.requireAllScenarios)
        failures.push(`${result.name}: missing baseline entry`)
      continue
    }
    const hasSampleSet = (result.sampleSummary?.count || 0) > 1 && (prev.sampleSummary?.count || 0) > 1
    const metrics = [
      ['cdp.mainThreadBusyRatio', result.cdp?.mainThreadBusyRatio, prev.cdp?.mainThreadBusyRatio, 0.08],
      ['cdp.activeBusyRatio', result.cdp?.activeBusyRatio, prev.cdp?.activeBusyRatio, 0.1],
      ['cdp.layoutCount', result.cdp?.layoutCount, prev.cdp?.layoutCount, 8],
      ['cdp.recalcStyleCount', result.cdp?.recalcStyleCount, prev.cdp?.recalcStyleCount, 8],
      ['longTasks.count', result.longTasks?.count, prev.longTasks?.count, 2],
      ['timeline.Paint.count', result.timeline?.Paint?.count, prev.timeline?.Paint?.count, 8],
    ]
    if ((result.diffComputeSummary?.count || 0) > 0 && (prev.diffComputeSummary?.count || 0) > 0)
      metrics.push(['diffComputeSummary.p95', result.diffComputeSummary?.p95, prev.diffComputeSummary?.p95, 12])
    if (hasSampleSet) {
      metrics.push(
        ['sampleSummary.p95', result.sampleSummary?.p95, prev.sampleSummary?.p95, 32],
        ['sampleSummary.max', result.sampleSummary?.max, prev.sampleSummary?.max, 55],
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

function getBaselineEnvironmentMismatches(baselineEnvironment, currentEnvironment) {
  if (!baselineEnvironment || !currentEnvironment)
    return ['missing baseline/current environment metadata']

  const mismatches = []
  for (const key of comparableBaselineEnvironmentKeys) {
    const baselineValue = baselineEnvironment[key]
    const currentValue = currentEnvironment[key]
    if (baselineValue !== currentValue)
      mismatches.push(`${key}: baseline=${JSON.stringify(baselineValue)} current=${JSON.stringify(currentValue)}`)
  }
  return mismatches
}

function formatBaselineEnvironmentMismatch(mismatches) {
  return [
    'performance baseline environment mismatch; baseline regression check was not comparable',
    ...mismatches.map(item => `  - ${item}`),
    'Regenerate scripts/performance-baseline.json in the same CI/runtime used by perf:gate, or run with --skip-baseline for hard-budget-only bootstrap checks.',
  ].join('\n')
}

function formatEnvironmentValue(value) {
  return value == null ? 'missing' : String(value)
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
    activeBusy: r.cdp?.activeBusyRatio,
    layout: r.cdp?.layoutCount,
    style: r.cdp?.recalcStyleCount,
    paintPerOp: r.timeline?.Paint?.perOperation,
  }))
  console.table(rows)
}

function serializeError(error) {
  if (error instanceof Error)
    return { message: error.message, stack: error.stack }
  return String(error)
}

function summarizeBaselineFields(items, keys) {
  const out = {}
  for (const key of keys) {
    const value = percentile(items.map(item => item?.[key]), 0.75)
    if (value == null)
      continue
    out[key] = round(value, key === 'count' || key.endsWith('Count') ? 0 : 2)
  }
  return out
}

function summarizeBaselineSummary(items) {
  const fields = summarizeBaselineFields(items, ['count', 'min', 'p50', 'p75', 'p95', 'p99', 'max', 'avg'])
  return Object.keys(fields).length ? fields : undefined
}

function summarizeBaselineTimeline(results) {
  const names = new Set(results.flatMap(result => Object.keys(result.timeline ?? {})))
  const out = {}
  for (const name of names) {
    const items = results.map(result => result.timeline?.[name]).filter(Boolean)
    const summary = summarizeBaselineFields(items, ['count', 'durationMs', 'perOperation'])
    if (Object.keys(summary).length)
      out[name] = summary
  }
  return out
}

function summarizeBaselineResult(results) {
  const first = results[0]
  const samples = results.flatMap(result => Array.isArray(result.samples) ? result.samples : [])
  const sampleSummary = samples.length
    ? summarizeSamples(samples)
    : summarizeBaselineSummary(results.map(result => result.sampleSummary))

  const out = {
    name: first.scenario || first.name,
    entry: first.entry,
    runs: results.length,
    operations: Math.max(...results.map(result => result.operations || 1)),
    sampleSummary,
    longTasks: summarizeBaselineFields(results.map(result => result.longTasks), ['count', 'maxMs', 'totalMs']),
    cdp: summarizeBaselineFields(results.map(result => result.cdp), [
      'wallMs',
      'taskDurationMs',
      'scriptDurationMs',
      'layoutDurationMs',
      'recalcStyleDurationMs',
      'layoutCount',
      'recalcStyleCount',
      'jsHeapUsedDeltaMB',
      'mainThreadBusyRatio',
      'intentionalSleepMs',
      'activeExcludedMs',
      'activeWallMs',
      'activeBusyRatio',
    ]),
    timeline: summarizeBaselineTimeline(results),
  }

  const diffComputeSummary = summarizeBaselineSummary(results.map(result => result.diffComputeSummary).filter(Boolean))
  if (diffComputeSummary)
    out.diffComputeSummary = diffComputeSummary

  const streamUpdateHighlightSummary = summarizeBaselineSummary(results.map(result => result.streamUpdateHighlightSummary).filter(Boolean))
  if (streamUpdateHighlightSummary)
    out.streamUpdateHighlightSummary = streamUpdateHighlightSummary

  return out
}

function buildBaselineReport(report) {
  const byName = new Map()
  for (const result of report.results) {
    const key = result.scenario || result.name
    const results = byName.get(key) ?? []
    results.push(result)
    byName.set(key, results)
  }
  return {
    generatedAt: report.generatedAt,
    entry: report.entry,
    scenarios: report.scenarios,
    repeat: report.repeat,
    environment: report.environment,
    results: Array.from(byName.values()).map(summarizeBaselineResult),
  }
}

function buildPerformanceReport(results, budget, extra = {}) {
  return attachAnalysis({
    generatedAt: nowIso(),
    entry,
    scenarios: SCENARIOS,
    repeat,
    results,
    ...extra,
  }, budget)
}

async function writePerformanceReport(report) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(markdownReportPath, buildMarkdownReport(report))
}

async function main() {
  await mkdir(perfDir, { recursive: true })
  await rm(perfAppDir, { recursive: true, force: true })
  await writePerfApp()
  const budget = await readJsonIfExists(budgetPath, null)
  if (!budget) {
    console.error(`Missing performance budget file: ${path.relative(root, budgetPath)}`)
    console.error('Create scripts/performance-budget.json with failBudget and scenarioBudgets before running the gate.')
    process.exit(1)
  }
  const baseline = await readJsonIfExists(baselinePath, null)
  if (!updateBaseline && !reportOnly && !skipBaseline && !baseline?.results) {
    console.error(`Missing committed performance baseline: ${path.relative(root, baselinePath)}`)
    console.error('Run `pnpm perf:baseline` on main and commit the generated baseline, or pass --skip-baseline for bootstrap-only hard-budget checks.')
    process.exit(1)
  }
  const { server, baseUrl } = await startVite()
  const browser = await chromium.launch({
    headless: !headed,
    args: [
      '--js-flags=--expose-gc',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  })
  const environment = await buildEnvironment(browser.version())
  const url = new URL('/scripts/.perf-app/index.html', baseUrl).toString()
  const results = []
  let runError = null

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
          result.scenario = scenario
          if (repeat > 1) {
            result.name = `${scenario}#${i + 1}`
            result.repeatIndex = i + 1
          }
          results.push(result)
        }
        finally {
          await context.close().catch(() => {})
        }
      }
    }
  }
  catch (err) {
    runError = err
  }
  finally {
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
    await rm(perfAppDir, { recursive: true, force: true }).catch(() => {})
  }

  const report = buildPerformanceReport(results, budget, runError
    ? { environment, failedAt: nowIso(), error: serializeError(runError) }
    : { environment })
  await writePerformanceReport(report)
  printSummary(results)
  console.log(`Performance report written to ${path.relative(root, reportPath)}`)
  console.log(`Markdown report written to ${path.relative(root, markdownReportPath)}`)

  if (runError)
    throw runError

  if (updateBaseline) {
    await writeFile(baselinePath, `${JSON.stringify(buildBaselineReport(report), null, 2)}\n`)
    console.log(`Baseline updated at ${path.relative(root, baselinePath)}`)
    return
  }

  const failures = [
    ...(requireBaseline && !baseline?.results?.length
      ? [
          `Missing performance baseline: ${path.relative(root, baselinePath)}`,
          'Run `pnpm perf:baseline` on a known-good commit and commit the generated file.',
        ]
      : []),
    ...checkHardBudgets(results, budget),
    ...checkBaseline(results, baseline, budget.tolerance ?? 0.25, environment, { requireBaseline }),
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
