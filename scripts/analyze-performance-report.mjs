#!/usr/bin/env node

import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const perfDir = path.join(root, '.perf')
const reportPath = path.join(perfDir, 'stream-monaco-performance-report.json')
const analysisJsonPath = path.join(perfDir, 'stream-monaco-performance-analysis.json')
const analysisMdPath = path.join(perfDir, 'stream-monaco-performance-analysis.md')

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const prefix = `${name}=`
  const hit = args.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : fallback
}

const inputPath = path.resolve(root, getArg('--input', reportPath))

function round(n, digits = 2) {
  if (!Number.isFinite(n))
    return n
  const p = 10 ** digits
  return Math.round(n * p) / p
}

function get(obj, pathExpr, fallback = 0) {
  const value = pathExpr.split('.').reduce((acc, key) => acc?.[key], obj)
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function p95(result) {
  return get(result, 'sampleSummary.p95')
}

function max(result) {
  return get(result, 'sampleSummary.max')
}

function wall(result) {
  return get(result, 'wallMs') || get(result, 'cdp.wallMs')
}

function busy(result) {
  return get(result, 'cdp.mainThreadBusyRatio')
}

function longTasks(result) {
  return get(result, 'longTasks.count')
}

function maxLongTask(result) {
  return get(result, 'longTasks.maxMs')
}

function timelinePerOp(result, name) {
  return get(result, `timeline.${name}.perOperation`)
}

function timelineCount(result, name) {
  return get(result, `timeline.${name}.count`)
}

function ratio(a, b) {
  if (!a || !b)
    return 0
  return round(a / b, 3)
}

function severity(score) {
  if (score >= 0.85)
    return 'high'
  if (score >= 0.55)
    return 'medium'
  return 'low'
}

function makeFinding(kind, scenario, score, evidence, diagnosis, action) {
  return {
    kind,
    scenario,
    severity: severity(score),
    score: round(score, 3),
    evidence,
    diagnosis,
    action,
  }
}

function analyzeScenario(result) {
  const findings = []
  const operations = result.operations || 1
  const isStream = result.name.includes('stream-burst')
  const isDiff = result.name.startsWith('diff-')
  const layoutPerOp = timelinePerOp(result, 'Layout')
  const stylePerOp = timelinePerOp(result, 'UpdateLayoutTree') || timelinePerOp(result, 'RecalculateStyles')
  const paintPerOp = timelinePerOp(result, 'Paint')
  const scriptMs = get(result, 'cdp.scriptDurationMs')
  const taskMs = get(result, 'cdp.taskDurationMs')
  const wallMs = wall(result)

  if (busy(result) > 0.72 || longTasks(result) >= 3 || maxLongTask(result) > 180) {
    findings.push(makeFinding(
      'main-thread',
      result.name,
      Math.min(1, Math.max(busy(result), longTasks(result) / 10, maxLongTask(result) / 350)),
      {
        busyRatio: busy(result),
        longTaskCount: longTasks(result),
        maxLongTaskMs: maxLongTask(result),
        taskDurationMs: taskMs,
        scriptDurationMs: scriptMs,
        wallMs,
      },
      '主线程接近饱和，用户会看到输入/滚动/高亮延迟；如果 scriptDuration 占比高，优先查字符串复制、diff 计算和 tokenization。',
      isDiff && isStream
        ? '优先检查 DiffEditorManager streaming append 路径，避免每次 flush/chunk 后 model.getValue() 复制完整文档；把 lastKnownModifiedCode 改为增量维护。'
        : '对该场景打开 Chrome trace，按 FunctionCall/EvaluateScript 聚合调用栈；优先减少同步字符串扫描和高频 DOM/Monaco API 调用。',
    ))
  }

  if (layoutPerOp > (isStream ? 1.2 : 3) || stylePerOp > (isStream ? 2.4 : 6)) {
    findings.push(makeFinding(
      'layout-style',
      result.name,
      Math.min(1, Math.max(layoutPerOp / (isStream ? 2 : 6), stylePerOp / (isStream ? 4 : 10))),
      {
        operations,
        layoutPerOperation: layoutPerOp,
        stylePerOperation: stylePerOp,
        layoutCount: get(result, 'cdp.layoutCount'),
        recalcStyleCount: get(result, 'cdp.recalcStyleCount'),
      },
      '每次更新触发了过多 Layout/StyleRecalc，通常来自高度同步、自动滚动 reveal、content-size-change 回调或测试侧轮询 DOM。',
      '把高度测量和 reveal 合并到同一 RAF；避免在 hot path 读 getContentHeight/getScrollHeight/getBoundingClientRect；确认测试里的 waitForHighlight 没有把查询 DOM 的成本算进库成本。',
    ))
  }

  if (paintPerOp > (isStream ? 2.5 : 6)) {
    findings.push(makeFinding(
      'paint',
      result.name,
      Math.min(1, paintPerOp / (isStream ? 5 : 10)),
      {
        operations,
        paintPerOperation: paintPerOp,
        paintCount: timelineCount(result, 'Paint'),
      },
      'Paint 次数偏高，说明更新拆得过碎或频繁触发可见区域重绘。',
      'streaming 场景优先增大 updateThrottleMs/diffUpdateThrottleMs 或按 frame 合并 append；diff 场景检查 fallback decorations 和 unchanged overlay 是否在流式期间反复刷新。',
    ))
  }

  if (isStream && wallMs / operations > 12) {
    findings.push(makeFinding(
      'stream-throughput',
      result.name,
      Math.min(1, (wallMs / operations) / 20),
      {
        operations,
        wallMs,
        msPerOperation: round(wallMs / operations),
      },
      'stream burst 吞吐偏低；端到端耗时已经超过输入节奏本身。',
      '确认 append buffer 是否被 throttle 合并；避免每个 token 都触发 diff recompute、height sync 或 reveal。',
    ))
  }

  return findings
}

function analyzeCrossScenario(byName) {
  const findings = []
  const cold = byName.get('editor-cold-first-highlight')
  const warm = byName.get('editor-warm-first-highlight')
  const editorUpdate = byName.get('editor-update-highlight')
  const diffUpdate = byName.get('diff-update-highlight')
  const editorStream = byName.get('editor-stream-burst')
  const diffStream = byName.get('diff-stream-burst')
  const diffCold = byName.get('diff-cold-first-highlight')

  if (cold && warm) {
    const r = ratio(p95(cold), p95(warm))
    if (r > 3) {
      findings.push(makeFinding(
        'cold-start',
        'editor-cold-first-highlight/editor-warm-first-highlight',
        Math.min(1, r / 8),
        {
          coldP95Ms: p95(cold),
          warmP95Ms: p95(warm),
          coldToWarmRatio: r,
        },
        '冷启动明显慢于 warm path，主要成本应在 Shiki highlighter 创建、语言 grammar/theme 加载和 shikiToMonaco token provider patch。',
        '发布前给 docs/API 明确推荐预热路径；性能门禁增加 defaultLanguages 冷启动场景，避免只测 4 个 languages 掩盖默认配置成本。',
      ))
    }
  }

  if (editorUpdate && diffUpdate) {
    const r = ratio(p95(diffUpdate), p95(editorUpdate))
    if (r > 1.8) {
      findings.push(makeFinding(
        'diff-overhead',
        'diff-update-highlight/editor-update-highlight',
        Math.min(1, r / 4),
        {
          diffUpdateP95Ms: p95(diffUpdate),
          editorUpdateP95Ms: p95(editorUpdate),
          ratio: r,
        },
        'diff 更新相比普通 editor 更新有明显额外成本，通常来自 diff recomputation、overlay/decorations 和 side-by-side layout。',
        '对 diff update 分离 measurement：model apply、waitForDiff、presentation sync、height/reveal 各打 performance.mark；只对最终稳定帧刷新 overlay。',
      ))
    }
  }

  if (editorStream && diffStream) {
    const r = ratio(wall(diffStream), wall(editorStream))
    if (r > 1.4) {
      findings.push(makeFinding(
        'diff-stream-overhead',
        'diff-stream-burst/editor-stream-burst',
        Math.min(1, r / 3),
        {
          diffStreamWallMs: wall(diffStream),
          editorStreamWallMs: wall(editorStream),
          ratio: r,
        },
        'diff streaming 端到端成本高于普通 streaming；若同时 long task/heap 增长，优先怀疑完整字符串复制或 diff presentation 反复刷新。',
        '修复 DiffEditorManager.flushAppendBufferDiff 中每个 chunk 后 model.getValue() 的 O(n²) 文档复制，并在流式期间降低 presentation overlay 刷新频率。',
      ))
    }
  }

  if (cold && diffCold) {
    const r = ratio(p95(diffCold), p95(cold))
    if (r > 1.4) {
      findings.push(makeFinding(
        'diff-cold-start',
        'diff-cold-first-highlight/editor-cold-first-highlight',
        Math.min(1, r / 3),
        {
          diffColdP95Ms: p95(diffCold),
          editorColdP95Ms: p95(cold),
          ratio: r,
        },
        'diff cold start 成本高于 editor cold start；除了 Shiki/Monaco 初始化，还有 diff editor 初始化和首次 diff 计算。',
        '门禁中把 cold 场景隔离到新 page/context，否则前一个 editor 场景会污染 diff cold 的 highlighter/token provider 状态。',
      ))
    }
  }

  return findings
}

function toMarkdown(report, analysis) {
  const rows = report.results.map((r) => {
    return `| ${r.name} | ${r.operations || 1} | ${p95(r)} | ${max(r)} | ${wall(r)} | ${busy(r)} | ${longTasks(r)} | ${maxLongTask(r)} | ${timelinePerOp(r, 'Layout')} | ${timelinePerOp(r, 'UpdateLayoutTree') || timelinePerOp(r, 'RecalculateStyles')} | ${timelinePerOp(r, 'Paint')} |`
  })
  const findings = analysis.findings.map((f, i) => {
    return [
      `### ${i + 1}. [${f.severity}] ${f.kind} — ${f.scenario}`,
      '',
      `**Evidence:** \`${JSON.stringify(f.evidence)}\``,
      '',
      `**Diagnosis:** ${f.diagnosis}`,
      '',
      `**Action:** ${f.action}`,
      '',
    ].join('\n')
  })

  return [
    '# stream-monaco performance analysis',
    '',
    `Generated from: \`${path.relative(root, inputPath)}\``,
    `Entry: \`${report.entry || 'unknown'}\``,
    '',
    '## Scenario summary',
    '',
    '| scenario | ops | p95 ms | max ms | wall ms | busy | long tasks | max long task ms | layout/op | style/op | paint/op |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows,
    '',
    '## Findings',
    '',
    findings.length ? findings.join('\n') : 'No actionable bottleneck detected by the current heuristics.',
    '',
  ].join('\n')
}

async function main() {
  const report = JSON.parse(await readFile(inputPath, 'utf8'))
  const byName = new Map(report.results.map(r => [r.name, r]))
  const scenarioFindings = report.results.flatMap(analyzeScenario)
  const crossFindings = analyzeCrossScenario(byName)
  const findings = [...scenarioFindings, ...crossFindings]
    .sort((a, b) => b.score - a.score)
  const analysis = {
    generatedAt: new Date().toISOString(),
    sourceReport: path.relative(root, inputPath),
    findings,
  }

  await mkdir(perfDir, { recursive: true })
  await writeFile(analysisJsonPath, `${JSON.stringify(analysis, null, 2)}\n`)
  await writeFile(analysisMdPath, toMarkdown(report, analysis))
  console.log(`Performance analysis written to ${path.relative(root, analysisMdPath)}`)
  if (findings.length) {
    console.log('\nTop findings:')
    for (const finding of findings.slice(0, 5))
      console.log(`- [${finding.severity}] ${finding.kind}: ${finding.scenario}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
