<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { preloadMonacoWorkers, useMonaco } from '../../../src/index'

type DiffPair = { original: string, modified: string }

const collapsedOption = {
  enabled: true,
  contextLineCount: 2,
  minimumLineCount: 4,
  revealLineCount: 2,
} as const

const el = ref<HTMLElement | null>(null)
const actionLogs = ref<string[]>([])
const diffCount = ref(0)
const diffState = ref<'ready' | 'null'>('null')
const collapsed = ref(true)
let pair: DiffPair | null = null
let scenarioVersion = 0
let diffUpdatedDisposable: { dispose: () => void } | null = null
let diffPollTimer: number | null = null

function installDemoWorkerBridge() {
  const globalAny = self as any
  globalAny.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      if (label === 'typescript' || label === 'javascript')
        return new TypeScriptWorker()
      return new EditorWorker()
    },
  }
}

function pushActionLog(text: string) {
  actionLogs.value = [text, ...actionLogs.value].slice(0, 10)
}

function createScenario(version = 0): DiffPair {
  const variant = version % 3
  const originalLines: string[] = [
    'type Task = { id: string, status: \'todo\' | \'done\' }',
    '',
    'export async function synchronizeTasks(tasks: Task[]) {',
    '  const report: string[] = []',
    '  report.push(`input=${tasks.length}`)',
    '',
  ]

  for (let i = 1; i <= 220; i++) {
    if (i % 25 === 0)
      originalLines.push(`  // stable checkpoint ${i}`)
    const n = String(i).padStart(3, '0')
    originalLines.push(`  report.push('stable-${n}')`)
  }

  originalLines.push('', '  return report', '}')

  const modifiedLines = [...originalLines]

  const updateAround = modifiedLines.findIndex(line => line.includes('stable-015'))
  if (updateAround >= 0) {
    modifiedLines[updateAround] = `  report.push('stable-015-optimized-v${variant + 1}')`
    modifiedLines[updateAround + 1] = `  report.push('stable-016-optimized-v${variant + 1}')`
  }

  const tuneAround = modifiedLines.findIndex(line => line.includes('stable-090'))
  if (tuneAround >= 1) {
    modifiedLines[tuneAround - 1] = `  report.push('stable-089-hotfix-v${variant + 1}')`
    modifiedLines[tuneAround] = `  report.push('stable-090-hotfix-v${variant + 1}')`
    modifiedLines[tuneAround + 1] = `  report.push('stable-091-hotfix-v${variant + 1}')`
  }

  const insertAfter = modifiedLines.findIndex(line => line.includes('stable-160'))
  if (insertAfter >= 1) {
    modifiedLines[insertAfter - 1] = `  report.push('stable-159-cache-hit-v${variant + 1}')`
    modifiedLines[insertAfter] = `  report.push('stable-160-cache-hit-v${variant + 1}')`
    modifiedLines[insertAfter + 1] = `  report.push('stable-161-cache-miss-v${variant + 1}')`
  }

  const returnLine = modifiedLines.findIndex(line => line.trim() === 'return report')
  if (returnLine >= 0) {
    const returnVariants = [
      '  return report.filter(Boolean)',
      '  return report.filter(Boolean).slice(0, 220)',
      '  return report.filter(Boolean).map(item => item.trim())',
    ]
    modifiedLines[returnLine] = returnVariants[variant]
  }

  return {
    original: originalLines.join('\n'),
    modified: modifiedLines.join('\n'),
  }
}

const {
  createDiffEditor,
  updateDiff,
  cleanupEditor,
  getDiffEditorView,
  getDiffModels,
} = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['typescript'],
  readOnly: true,
  MAX_HEIGHT: 560,
  wordWrap: 'off',
  maxComputationTime: 0,
  diffAlgorithm: 'legacy',
  renderIndicators: true,
  ignoreTrimWhitespace: false,
  diffHideUnchangedRegions: collapsedOption,
  diffHunkActionsOnHover: true,
  onDiffHunkAction: (ctx) => {
    pushActionLog(
      `${ctx.action.toUpperCase()} ${ctx.side} | O:${ctx.lineChange.originalStartLineNumber}-${ctx.lineChange.originalEndLineNumber} M:${ctx.lineChange.modifiedStartLineNumber}-${ctx.lineChange.modifiedEndLineNumber}`,
    )
    return true
  },
})

installDemoWorkerBridge()
preloadMonacoWorkers()

function computeFallbackHunkCount(): number {
  const { original, modified } = getDiffModels()
  if (!original || !modified)
    return 0
  if (original.getValue() === modified.getValue())
    return 0
  const o = original.getValue().split(/\r?\n/)
  const m = modified.getValue().split(/\r?\n/)
  let count = 0
  const max = Math.max(o.length, m.length)
  let inDiff = false
  for (let i = 0; i < max; i++) {
    const changed = (o[i] ?? '') !== (m[i] ?? '')
    if (changed && !inDiff) {
      count++
      inDiff = true
    }
    if (!changed && inDiff)
      inDiff = false
  }
  return count
}

function syncDiffCount() {
  const lineChanges = getDiffEditorView()?.getLineChanges() ?? null
  const hasNative = !!lineChanges
  diffState.value = hasNative ? 'ready' : 'null'
  const count = hasNative ? (lineChanges?.length ?? 0) : computeFallbackHunkCount()
  diffCount.value = count
}

function startPollDiffCount() {
  if (diffPollTimer != null) {
    clearInterval(diffPollTimer)
    diffPollTimer = null
  }
  let ticks = 0
  diffPollTimer = window.setInterval(() => {
    ticks += 1
    syncDiffCount()
    if (ticks >= 24 || diffCount.value > 0) {
      if (diffPollTimer != null) {
        clearInterval(diffPollTimer)
        diffPollTimer = null
      }
    }
  }, 250)
}

function bindDiffUpdateEvent() {
  diffUpdatedDisposable?.dispose()
  const view = getDiffEditorView()
  if (!view)
    return
  diffUpdatedDisposable = view.onDidUpdateDiff(() => {
    syncDiffCount()
  })
}

function collapseUnchanged() {
  getDiffEditorView()?.updateOptions({
    hideUnchangedRegions: collapsedOption,
  })
  collapsed.value = true
}

function expandUnchanged() {
  getDiffEditorView()?.updateOptions({
    hideUnchangedRegions: { enabled: false },
  })
  collapsed.value = false
}

function resetScenario() {
  scenarioVersion = 0
  pair = createScenario(scenarioVersion)
  actionLogs.value = []
  updateDiff(pair.original, pair.modified, 'typescript')
  collapseUnchanged()
  setTimeout(() => syncDiffCount(), 30)
  startPollDiffCount()
}

function applyScenarioPatch() {
  scenarioVersion += 1
  pair = createScenario(scenarioVersion)
  updateDiff(pair.original, pair.modified, 'typescript')
  pushActionLog(`PATCH v${(scenarioVersion % 3) + 1} | keep current fold state`)
  setTimeout(() => syncDiffCount(), 30)
  startPollDiffCount()
}

onMounted(async () => {
  if (!el.value)
    return

  pair = createScenario(scenarioVersion)
  await createDiffEditor(el.value, pair.original, pair.modified, 'typescript')
  collapseUnchanged()
  bindDiffUpdateEvent()
  syncDiffCount()
  startPollDiffCount()
})

onBeforeUnmount(() => {
  diffUpdatedDisposable?.dispose()
  diffUpdatedDisposable = null
  if (diffPollTimer != null) {
    clearInterval(diffPollTimer)
    diffPollTimer = null
  }
  cleanupEditor()
})
</script>

<template>
  <div class="page">
    <div class="tips">
      <div>1. 默认已折叠未改动区域，整块灰色摘要条现在都可以直接点击展开；上下边缘仍可点击或拖拽逐步 reveal。</div>
      <div>2. gutter 的折叠按钮 hover 更明显，也支持 focus 后按 <code>Enter</code> / <code>Space</code> 触发。</div>
      <div>3. 展开几段后点击 <code>Apply New Patch</code>，当前 unchanged region 的展开状态会尽量保留下来。</div>
      <div>4. 把鼠标移到红/绿变更块上，会出现 upper / lower 两组 <code>Revert</code> / <code>Stage</code>。</div>
      <div>5. 当前 diff hunk 数量：<strong>{{ diffCount }}</strong>，lineChanges 状态：<strong>{{ diffState }}</strong></div>
    </div>

    <div class="editor-card">
      <div class="editor-toolbar">
        <div class="editor-title">Unchanged Region UX</div>
        <div class="editor-meta">
          <span class="badge" :class="{ on: collapsed }">
            {{ collapsed ? 'Collapsed' : 'Expanded' }}
          </span>
          <span class="badge">{{ diffCount }} hunks</span>
        </div>
      </div>

      <div ref="el" class="editor" />
    </div>

    <div class="actions">
      <button :class="{ active: collapsed }" @click="collapseUnchanged">Collapse Unchanged</button>
      <button :class="{ active: !collapsed }" @click="expandUnchanged">Expand All</button>
      <button @click="applyScenarioPatch">Apply New Patch</button>
      <button class="secondary" @click="resetScenario">Reset Scenario</button>
    </div>

    <div class="log">
      <div class="log-title">Hunk Action Logs</div>
      <div v-if="actionLogs.length === 0" class="empty">还没有操作，hover 后点击按钮试试。</div>
      <div v-for="(item, i) in actionLogs" :key="`${item}-${i}`" class="log-item">
        {{ item }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  gap: 14px;
  padding-bottom: 12px;
}
.tips {
  font-size: 13px;
  color: #334155;
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid #dbe4f0;
  border-radius: 14px;
  background:
    radial-gradient(circle at top left, rgb(59 130 246 / 0.08), transparent 40%),
    linear-gradient(180deg, #f8fbff 0%, #f4f7fb 100%);
}
.editor-card {
  border: 1px solid #dbe4f0;
  border-radius: 16px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 18px 48px -36px rgb(15 23 42 / 0.45);
}
.editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid #e5edf7;
  background: linear-gradient(180deg, #fdfefe 0%, #f6f9fc 100%);
}
.editor-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #0f172a;
}
.editor-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #475569;
  background: #eaf0f7;
}
.badge.on {
  color: #0f766e;
  background: #dff7f2;
}
.editor {
  border-top: 1px solid #eef3f8;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
button {
  appearance: none;
  border: 1px solid #c7d5e6;
  border-radius: 999px;
  background: #fff;
  color: #0f172a;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
}
button:hover {
  transform: translateY(-1px);
  border-color: #94a3b8;
}
button.active {
  border-color: #2563eb;
  background: #eaf2ff;
  color: #1d4ed8;
}
button.secondary {
  border-color: #d0d9e5;
  color: #475569;
}
.log {
  border: 1px solid #dbe4f0;
  border-radius: 14px;
  padding: 10px 12px;
  background: #fbfdff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.log-title {
  font-weight: 600;
  margin-bottom: 8px;
}
.log-item {
  padding: 4px 0;
  color: #111827;
}
.empty {
  color: #6b7280;
}
</style>
