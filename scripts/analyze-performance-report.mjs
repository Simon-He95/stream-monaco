#!/usr/bin/env node

import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const perfDir = path.join(root, '.perf')
const defaultReportPath = path.join(perfDir, 'stream-monaco-performance-report.json')
const defaultBudgetPath = path.join(root, 'scripts/performance-budget.json')
const defaultOutputPath = path.join(perfDir, 'stream-monaco-performance-analysis.md')

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const prefix = `${name}=`
  const hit = args.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const reportPath = path.resolve(root, getArg('--report', defaultReportPath))
const budgetPath = path.resolve(root, getArg('--budget', defaultBudgetPath))
const outputPath = path.resolve(root, getArg('--output', defaultOutputPath))
const jsonOutputPath = outputPath.replace(/\.md$/i, '.json')

function round(n, digits = 2) {
  if (!Number.isFinite(n))
    return n
  const p = 10 ** digits
  return Math.round(n * p) / p
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  }
  catch {
    return fallback
  }
}

function getBudget(budget, scenario) {
  return budget?.scenarioBudgets?.[scenario.name] ?? {}
}

function ratio(actual, limit) {
  if (typeof actual !== 'number' || typeof limit !== 'number' || !Number.isFinite(actual) || !Number.isFinite(limit) || limit <= 0)
    return 0
  return actual / limit
}

function metricScore(value, budgetValue) {
  const r = ratio(value, budgetValue)
  if (r >= 1.2)
    return 'critical'
  if (r >= 1)
    return 'over-budget'
  if (r >= 0.8)
    return 'near-budget'
  return 'ok'
}

function maxStatus(statuses) {
  const weight = { ok: 0, 'near-budget': 1, 'over-budget': 2, critical: 3 }
  return statuses.reduce((max, item) => weight[item] > weight[max] ? item : max, 'ok')
}

function perOp(result, value) {
  const ops = result.operations || 1
  return ops > 0 ? value / ops : value
}

function getHotMetrics(result) {
  const cdp = result.cdp ?? {}
  const timeline = result.timeline ?? {}
  const operations = result.operations || 1
  return {
    p95Ms: result.sampleSummary?.p95 ?? 0,
    maxMs: result.sampleSummary?.max ?? 0,
    wallMs: result.wallMs ?? cdp.wallMs ?? 0,
    taskMs: cdp.taskDurationMs ?? 0,
    scriptMs: cdp.scriptDurationMs ?? 0,
    layoutMs: cdp.layoutDurationMs ?? 0,
    recalcMs: cdp.recalcStyleDurationMs ?? 0,
    longTasks: result.longTasks?.count ?? 0,
    maxLongTaskMs: result.longTasks?.maxMs ?? 0,
    busyRatio: cdp.mainThreadBusyRatio ?? 0,
    layoutCount: cdp.layoutCount ?? timeline.Layout?.count ?? 0,
    recalcCount: cdp.recalcStyleCount ?? timeline.UpdateLayoutTree?.count ?? timeline.RecalculateStyles?.count ?? 0,
    paintCount: timeline.Paint?.count ?? 0,
    layoutPerOp: timeline.Layout?.perOperation ?? perOp(result, cdp.layoutCount ?? 0),
    stylePerOp: (timeline.RecalculateStyles?.perOperation || timeline.UpdateLayoutTree?.perOperation || perOp(result, cdp.recalcStyleCount ?? 0)),
    paintPerOp: timeline.Paint?.perOperation ?? perOp(result, timeline.Paint?.count ?? 0),
    taskPerOpMs: perOp(result, cdp.taskDurationMs ?? 0),
    scriptPerOpMs: perOp(result, cdp.scriptDurationMs ?? 0),
    operations,
  }
}

function detectDominantBottleneck(result, metrics) {
  const name = result.name
  if (name.includes('cold') && metrics.p95Ms > 1000)
    return 'cold-start-highlighter'
  if (name.includes('diff') && metrics.stylePerOp >= 4)
    return 'diff-dom-layout-churn'
  if (metrics.layoutPerOp >= 2 || metrics.stylePerOp >= 4 || metrics.paintPerOp >= 4)
    return 'layout-paint-churn'
  if (metrics.scriptPerOpMs >= 3 && metrics.layoutPerOp < 1)
    return 'tokenization-or-model-edit-cpu'
  if (name.includes('stream') && metrics.longTasks > 0)
    return 'streaming-batch-starvation'
  if (metrics.maxLongTaskMs >= 80)
    return 'main-thread-long-task'
  return 'within-budget-or-no-clear-dominant-cost'
}

function recommendationsFor(result, metrics, budget) {
  const name = result.name
  const recs = []

  if (name.includes('cold') && metrics.p95Ms > Math.min(budget.sampleP95Ms ?? Infinity, 1500)) {
    recs.push({
      priority: 'P0',
      area: 'cold start',
      action: '把 Shiki/Monaco theme+language 注册从 createEditor/createDiffEditor 的可见路径前移。对业务暴露 preload/warmup 示例，默认示例只传当前需要的 languages，不要使用全量 defaultLanguages。',
      verify: 'editor-cold-first-highlight / diff-cold-first-highlight 的 p95、maxLongTaskMs、scriptDurationMs 应下降。',
    })
  }

  if (name.includes('update') && metrics.scriptPerOpMs >= 3) {
    recs.push({
      priority: 'P0',
      area: 'hot update CPU',
      action: '区分 append、small replace、large replace 三类更新；append 场景优先走 appendCode/appendModified，非 append 只在文本规模低于 minimalEditMaxChars 时计算 minimal edit。',
      verify: `${name} 的 scriptPerOpMs 和 sample p95 应下降，model 内容必须保持一致。`,
    })
  }

  if (metrics.layoutPerOp >= (budget.layoutPerOperation ?? 2) || metrics.stylePerOp >= (budget.recalcStylePerOperation ?? 4)) {
    recs.push({
      priority: name.includes('diff') ? 'P0' : 'P1',
      area: 'layout/style',
      action: '把高度测量、scrollHeight/getLayoutInfo/getBoundingClientRect/readContainerLayoutSize 收敛到单个 RAF；同一轮 flush 内只 layout 一次，避免内容变化、height manager、scroll reveal 分别读写布局。',
      verify: `${name} 的 Layout.perOperation、StyleRecalc.perOperation、layoutDurationMs 应下降。`,
    })
  }

  if (name === 'diff-stream-burst') {
    recs.push({
      priority: 'P0',
      area: 'diff streaming correctness/perf',
      action: '修复大块 append 的 chunk 切分，必须逐字节/逐字符保持 totalText；避免每个 chunk 后 model.getValue() 造成 O(n²)。',
      verify: '新增大块 append 回归：最终 modified value 与输入完全相等；diff-stream-burst scriptPerOpMs 下降。',
    })
  }

  if (name.includes('stream') && metrics.maxLongTaskMs >= (budget.maxLongTaskMs ?? 120)) {
    recs.push({
      priority: 'P1',
      area: 'scheduler',
      action: '把单次 flush 的工作量切成时间预算片，例如 8-12ms 一个 chunk；chunk 间使用 RAF/yield，避免连续 applyEdits + reveal + height update 堵塞渲染。',
      verify: `${name} 的 maxLongTaskMs 和 longTasks.count 应下降，wallMs 不应明显增加。`,
    })
  }

  if (!recs.length) {
    recs.push({
      priority: 'P2',
      area: 'guardrail',
      action: '该场景当前没有明确瓶颈；保留 baseline 回归检测即可，不要为了局部指标牺牲稳定性。',
      verify: 'baseline tolerance 内稳定。',
    })
  }

  return recs
}

function analyzeScenario(result, budget) {
  const metrics = getHotMetrics(result)
  const statuses = [
    metricScore(metrics.p95Ms, budget.sampleP95Ms),
    metricScore(metrics.maxMs, budget.sampleMaxMs),
    metricScore(metrics.wallMs, budget.wallMs),
    metricScore(metrics.longTasks, budget.longTaskCount),
    metricScore(metrics.maxLongTaskMs, budget.maxLongTaskMs),
    metricScore(metrics.busyRatio, budget.mainThreadBusyRatio),
    metricScore(metrics.layoutPerOp, budget.layoutPerOperation),
    metricScore(metrics.stylePerOp, budget.recalcStylePerOperation),
    metricScore(metrics.paintPerOp, budget.paintPerOperation),
  ]
  const bottleneck = detectDominantBottleneck(result, metrics)
  return {
    scenario: result.name,
    status: maxStatus(statuses),
    bottleneck,
    metrics,
    recommendations: recommendationsFor(result, metrics, budget),
  }
}

function markdownTable(rows) {
  const headers = ['scenario', 'status', 'bottleneck', 'p95', 'max', 'longTasks', 'task/op', 'script/op', 'layout/op', 'style/op', 'paint/op']
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) {
    const m = row.metrics
    lines.push(`| ${row.scenario} | ${row.status} | ${row.bottleneck} | ${round(m.p95Ms)}ms | ${round(m.maxMs)}ms | ${m.longTasks} | ${round(m.taskPerOpMs)}ms | ${round(m.scriptPerOpMs)}ms | ${round(m.layoutPerOp, 3)} | ${round(m.stylePerOp, 3)} | ${round(m.paintPerOp, 3)} |`)
  }
  return lines.join('\n')
}

function renderMarkdown(report, analyses) {
  const lines = []
  lines.push('# stream-monaco performance analysis')
  lines.push('')
  lines.push(`Generated from: \`${path.relative(root, reportPath)}\``)
  lines.push(`Entry: \`${report.entry ?? 'unknown'}\``)
  lines.push(`Generated at: \`${report.generatedAt ?? 'unknown'}\``)
  lines.push('')
  lines.push('## Scenario diagnosis')
  lines.push('')
  lines.push(markdownTable(analyses))
  lines.push('')
  lines.push('## Prioritized actions')
  lines.push('')

  const actions = []
  for (const analysis of analyses) {
    for (const rec of analysis.recommendations) {
      actions.push({ scenario: analysis.scenario, ...rec })
    }
  }
  const priorityWeight = { P0: 0, P1: 1, P2: 2 }
  actions.sort((a, b) => (priorityWeight[a.priority] ?? 9) - (priorityWeight[b.priority] ?? 9))
  for (const action of actions) {
    lines.push(`### ${action.priority} · ${action.scenario} · ${action.area}`)
    lines.push('')
    lines.push(`- Action: ${action.action}`)
    lines.push(`- Verify: ${action.verify}`)
    lines.push('')
  }

  lines.push('## Reading guide')
  lines.push('')
  lines.push('- `task/op` 和 `script/op` 高：偏 CPU/tokenization/model edit。')
  lines.push('- `layout/op`、`style/op`、`paint/op` 高：偏 DOM/layout/reveal/height manager。')
  lines.push('- cold 场景慢而 warm 场景正常：优先做 preload/highlighter registration 前移。')
  lines.push('- stream 场景 long task 高：优先做 chunk/yield 和 flush 预算。')
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function main() {
  const report = await readJson(reportPath)
  if (!report?.results?.length)
    throw new Error(`No performance results found in ${reportPath}`)
  const budget = await readJson(budgetPath, { scenarioBudgets: {} })
  const analyses = report.results.map(result => analyzeScenario(result, getBudget(budget, result)))
  await writeFile(jsonOutputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), analyses }, null, 2)}\n`)
  await writeFile(outputPath, renderMarkdown(report, analyses))
  console.log(`Performance analysis written to ${path.relative(root, outputPath)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
