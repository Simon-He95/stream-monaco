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
  if (value == null || budgetValue == null || !Number.isFinite(value) || !Number.isFinite(budgetValue) || budgetValue <= 0)
    return 'no-budget'
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
    tokenizationMs: result.tokenization?.totalMs ?? 0,
    grammarTokenizationMs: result.grammarTokenization?.totalMs ?? 0,
    themeRegistrationMs: result.themeRegistration?.totalMs ?? 0,
    layoutMs: cdp.layoutDurationMs ?? 0,
    recalcMs: cdp.recalcStyleDurationMs ?? 0,
    longTasks: result.longTasks?.count ?? 0,
    maxLongTaskMs: result.longTasks?.maxMs ?? 0,
    busyRatio: cdp.activeBusyRatio ?? cdp.mainThreadBusyRatio ?? 0,
    layoutCount: cdp.layoutCount ?? timeline.Layout?.count ?? 0,
    recalcCount: cdp.recalcStyleCount ?? timeline.UpdateLayoutTree?.count ?? timeline.RecalculateStyles?.count ?? 0,
    paintCount: timeline.Paint?.count ?? 0,
    layoutPerOp: timeline.Layout?.perOperation ?? perOp(result, cdp.layoutCount ?? 0),
    stylePerOp: (timeline.RecalculateStyles?.perOperation || timeline.UpdateLayoutTree?.perOperation || perOp(result, cdp.recalcStyleCount ?? 0)),
    paintPerOp: timeline.Paint?.perOperation ?? perOp(result, timeline.Paint?.count ?? 0),
    taskPerOpMs: perOp(result, cdp.taskDurationMs ?? 0),
    scriptPerOpMs: perOp(result, cdp.scriptDurationMs ?? 0),
    tokenizationPerOpMs: perOp(result, result.tokenization?.totalMs ?? 0),
    grammarTokenizationPerOpMs: perOp(result, result.grammarTokenization?.totalMs ?? 0),
    operations,
  }
}

function detectDominantBottleneck(result, metrics) {
  const name = result.name
  const tokenizationDominates = metrics.tokenizationMs > 40 && metrics.tokenizationMs > metrics.scriptMs * 0.4
  if (name.includes('cold') && metrics.p95Ms > 1000)
    return 'cold-start-highlighter'
  if (metrics.grammarTokenizationMs > metrics.tokenizationMs * 0.8 && tokenizationDominates)
    return 'textmate-grammar-tokenization'
  if (tokenizationDominates)
    return 'tokenization-cpu'
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
      action: '把 Shiki/Monaco theme+language 注册从 createEditor/createDiffEditor 的可见路径前移；同时用 themeRegistration/tokenization 分段确认启动成本没有被误归因到 DOM。',
      verify: 'cold first-highlight 的 themeRegistrationMs、tokenization.totalMs、scriptDurationMs 应分别可解释，p95 不应回退。',
    })
  }

  if (metrics.tokenizationMs > 40 && metrics.tokenizationMs > metrics.scriptMs * 0.4) {
    recs.push({
      priority: name.includes('cold') ? 'P0' : 'P1',
      area: 'tokenization',
      action: '继续优先分析 Shiki/TextMate grammar tokenization：记录慢 token 行/状态，比较可见行数、autoScrollInitial、预热 provider 后的首个真实 tokenize；不要先动 diff overlay 或 encoded-provider scope 映射。',
      verify: `${name} 的 grammarTokenization.totalMs、tokenization.max、highlightAfterCreateMs 应下降，token DOM 和语义高亮必须保持正确。`,
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

  const tokenizationDominates = metrics.tokenizationMs > 40 && metrics.tokenizationMs > metrics.scriptMs * 0.4
  if (!tokenizationDominates && (metrics.layoutPerOp >= (budget.layoutPerOperation ?? 2) || metrics.stylePerOp >= (budget.recalcStylePerOperation ?? 4))) {
    recs.push({
      priority: name.includes('diff') ? 'P0' : 'P1',
      area: 'layout/style',
      action: '把高度测量、scrollHeight/getLayoutInfo/getBoundingClientRect/readContainerLayoutSize 收敛到单个 RAF；同一轮 flush 内只 layout 一次，避免内容变化、height manager、scroll reveal 分别读写布局。',
      verify: `${name} 的 Layout.perOperation、StyleRecalc.perOperation、layoutDurationMs 应下降。`,
    })
  }

  if (
    name.includes('diff-stream')
    && (
      metrics.maxLongTaskMs >= (budget.maxLongTaskMs ?? Infinity)
      || metrics.busyRatio >= (budget.activeBusyRatio ?? budget.mainThreadBusyRatio ?? Infinity)
      || metrics.layoutPerOp >= (budget.layoutPerOperation ?? Infinity)
      || metrics.stylePerOp >= (budget.recalcStylePerOperation ?? Infinity)
    )
  ) {
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
  const globalWarn = budget?.warningBudget || {}
  const globalFail = budget?.failBudget || {}
  const busyBudget = typeof result.cdp?.activeBusyRatio === 'number'
    ? (budget.activeBusyRatio ?? globalFail.activeBusyRatio ?? globalFail.mainThreadBusyRatio)
    : (budget.mainThreadBusyRatio ?? globalFail.mainThreadBusyRatio)
  const statuses = [
    metricScore(metrics.p95Ms, budget.sampleP95Ms),
    metricScore(metrics.maxMs, budget.sampleMaxMs),
    metricScore(metrics.wallMs, budget.wallMs),
    metricScore(metrics.longTasks, budget.longTaskCount),
    metricScore(metrics.maxLongTaskMs, budget.maxLongTaskMs),
    metricScore(metrics.busyRatio, busyBudget),
    metricScore(metrics.layoutPerOp, budget.layoutPerOperation),
    metricScore(metrics.stylePerOp, budget.recalcStylePerOperation),
    metricScore(metrics.paintPerOp, budget.paintPerOperation),
  ]
  // Add streaming highlight latency checks if data present
  const streamHighlightP95 = result.streamUpdateHighlightSummary?.p95
  const streamHighlightMax = result.streamUpdateHighlightSummary?.max
  if (streamHighlightP95 != null || streamHighlightMax != null) {
    statuses.push(
      metricScore(streamHighlightP95, budget.streamUpdateHighlightP95Ms),
      metricScore(streamHighlightMax, budget.streamUpdateHighlightMaxMs),
    )
  }
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
  const headers = ['scenario', 'status', 'bottleneck', 'p95', 'max', 'longTasks', 'busy', 'task/op', 'script/op', 'tokenize/op', 'grammar/op', 'layout/op', 'style/op', 'paint/op']
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) {
    const m = row.metrics
    lines.push(`| ${row.scenario} | ${row.status} | ${row.bottleneck} | ${round(m.p95Ms)}ms | ${round(m.maxMs)}ms | ${m.longTasks} | ${round(m.busyRatio, 3)} | ${round(m.taskPerOpMs)}ms | ${round(m.scriptPerOpMs)}ms | ${round(m.tokenizationPerOpMs)}ms | ${round(m.grammarTokenizationPerOpMs)}ms | ${round(m.layoutPerOp, 3)} | ${round(m.stylePerOp, 3)} | ${round(m.paintPerOp, 3)} |`)
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
  lines.push('- `busy` 优先使用扣除 benchmark sleep 后的 active busy ratio；没有 active 值时使用 mainThreadBusyRatio。')
  lines.push('- `task/op` 和 `script/op` 高：偏 CPU/tokenization/model edit。')
  lines.push('- `tokenize/op` 高：优先看 Shiki/TextMate tokenization、可见行数和 provider 预热，不要先归因到 diff overlay。')
  lines.push('- `grammar/op` 接近 `tokenize/op`：瓶颈在 TextMate grammar matching，不在 scope 映射或 token DOM。')
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
