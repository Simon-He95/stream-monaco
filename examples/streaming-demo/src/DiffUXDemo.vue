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
let pair: DiffPair | null = null
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

function createScenario(): DiffPair {
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
    modifiedLines[updateAround] = `  report.push('stable-015-optimized')`
    modifiedLines[updateAround + 1] = `  report.push('stable-016-optimized')`
  }

  const tuneAround = modifiedLines.findIndex(line => line.includes('stable-090'))
  if (tuneAround >= 1) {
    modifiedLines[tuneAround - 1] = `  report.push('stable-089-hotfix')`
    modifiedLines[tuneAround] = `  report.push('stable-090-hotfix')`
    modifiedLines[tuneAround + 1] = `  report.push('stable-091-hotfix')`
  }

  const insertAfter = modifiedLines.findIndex(line => line.includes('stable-160'))
  if (insertAfter >= 1) {
    modifiedLines[insertAfter - 1] = `  report.push('stable-159-cache-hit')`
    modifiedLines[insertAfter] = `  report.push('stable-160-cache-hit')`
    modifiedLines[insertAfter + 1] = `  report.push('stable-161-cache-miss')`
  }

  const returnLine = modifiedLines.findIndex(line => line.trim() === 'return report')
  if (returnLine >= 0)
    modifiedLines[returnLine] = '  return report.filter(Boolean)'

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
}

function expandUnchanged() {
  getDiffEditorView()?.updateOptions({
    hideUnchangedRegions: { enabled: false },
  })
}

function resetScenario() {
  pair = createScenario()
  actionLogs.value = []
  updateDiff(pair.original, pair.modified, 'typescript')
  collapseUnchanged()
  setTimeout(() => syncDiffCount(), 30)
  startPollDiffCount()
}

onMounted(async () => {
  if (!el.value)
    return

  pair = createScenario()
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
      <div>1. 默认已折叠未改动区域，点击灰色区域的折叠箭头可展开/收起。</div>
      <div>2. 把鼠标移到红/绿变更块上，会出现 upper / lower 两组 <code>Revert</code> / <code>Stage</code>。</div>
      <div>3. 当前 diff hunk 数量：<strong>{{ diffCount }}</strong></div>
      <div>4. lineChanges 状态：<strong>{{ diffState }}</strong>（`null` 表示 Monaco 还没给出可用 hunk）</div>
    </div>

    <div ref="el" class="editor" />

    <div class="actions">
      <button @click="collapseUnchanged">Collapse Unchanged</button>
      <button @click="expandUnchanged">Expand All</button>
      <button @click="resetScenario">Reset Scenario</button>
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
  gap: 12px;
}
.tips {
  font-size: 13px;
  color: #374151;
  display: grid;
  gap: 4px;
}
.editor {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
}
.actions {
  display: flex;
  gap: 8px;
}
button {
  padding: 6px 10px;
}
.log {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.log-title {
  font-weight: 600;
  margin-bottom: 6px;
}
.log-item {
  padding: 2px 0;
  color: #111827;
}
.empty {
  color: #6b7280;
}
</style>
