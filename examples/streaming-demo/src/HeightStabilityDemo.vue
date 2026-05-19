<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { preloadMonacoWorkers, useMonaco } from '../../../src/index'

interface HeightMetrics {
  current: number
  maxDelta: number
  largeJumps: number
  changes: number
  lastHeight: number
  styleHeight: string
  rectHeight: number
  clientHeight: number
  offsetHeight: number
  scrollHeight: number
  maxHeight: string
  overflowY: string
  hasScrollbar: boolean
  scrollbarWidth: number
  transition: string
  monacoContentHeight: number
  monacoScrollHeight: number
  monacoScrollTop: number
  monacoLayoutHeight: number
  monacoHasScrollbar: boolean
  lineCount: number
  scheduleCalls: number
  scheduleTotalMs: number
  scheduleMaxMs: number
  slowSchedules: number
}

interface RuntimeMetrics {
  streamMs: number
  frames: number
  totalFrameGap: number
  maxFrameGap: number
  longTasks: number
  longTaskTotalMs: number
  maxLongTaskMs: number
}

const baselineEl = ref<HTMLElement | null>(null)
const smoothEl = ref<HTMLElement | null>(null)
const constrainedBaselineEl = ref<HTMLElement | null>(null)
const constrainedSmoothEl = ref<HTMLElement | null>(null)
const running = ref(false)

function createHeightMetrics() {
  return reactive<HeightMetrics>({
    current: 0,
    maxDelta: 0,
    largeJumps: 0,
    changes: 0,
    lastHeight: 0,
    styleHeight: '',
    rectHeight: 0,
    clientHeight: 0,
    offsetHeight: 0,
    scrollHeight: 0,
    maxHeight: '',
    overflowY: '',
    hasScrollbar: false,
    scrollbarWidth: 0,
    transition: '',
    monacoContentHeight: 0,
    monacoScrollHeight: 0,
    monacoScrollTop: 0,
    monacoLayoutHeight: 0,
    monacoHasScrollbar: false,
    lineCount: 0,
    scheduleCalls: 0,
    scheduleTotalMs: 0,
    scheduleMaxMs: 0,
    slowSchedules: 0,
  })
}

const baselineMetrics = createHeightMetrics()
const smoothMetrics = createHeightMetrics()
const constrainedBaselineMetrics = createHeightMetrics()
const constrainedSmoothMetrics = createHeightMetrics()
const runtimeMetrics = reactive<RuntimeMetrics>({
  streamMs: 0,
  frames: 0,
  totalFrameGap: 0,
  maxFrameGap: 0,
  longTasks: 0,
  longTaskTotalMs: 0,
  maxLongTaskMs: 0,
})

const commonOptions = {
  wordWrap: 'on' as const,
  wrappingIndent: 'same' as const,
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['markdown', 'typescript', 'shellscript'],
  readOnly: true,
  updateThrottleMs: 0,
}

const baselineEditor = useMonaco({
  ...commonOptions,
  MAX_HEIGHT: 420,
  smoothHeightTransition: false,
})
const smoothEditor = useMonaco({
  ...commonOptions,
  MAX_HEIGHT: 420,
  smoothHeightTransition: true,
})
const constrainedBaselineEditor = useMonaco({
  ...commonOptions,
  MAX_HEIGHT: 180,
  smoothHeightTransition: false,
})
const constrainedSmoothEditor = useMonaco({
  ...commonOptions,
  MAX_HEIGHT: 180,
  smoothHeightTransition: true,
})

preloadMonacoWorkers()

const sections = [
  `# Streaming Monaco Height Stability

This page streams the same markdown into two editors so host height changes can be compared side by side.
`,
  `## Install

\`\`\`shellscript
pnpm install
pnpm --filter streaming-demo dev
\`\`\`
`,
  `## Notes

- The baseline editor keeps the legacy height tolerance.
- The smooth editor transitions height while content is growing.
- Both editors receive identical update chunks.
`,
  `## TypeScript

\`\`\`typescript
const editor = useMonaco({
  wordWrap: 'on',
  smoothHeightTransition: true,
  heightTransitionMs: 120,
  heightTransitionEasing: 'cubic-bezier(0.4, 0, 0.2, 1)',
})
\`\`\`
`,
]
const markdown = Array.from({ length: 20 })
  .map((_, index) => `${sections[index % sections.length]}\nParagraph ${index + 1}: streaming content expands the editor host a little at a time.\n`)
  .join('\n')

let timer: ReturnType<typeof setInterval> | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null
let finalSampleTimer: ReturnType<typeof setTimeout> | null = null
let observers: ResizeObserver[] = []
let frameRaf: number | null = null
let streamStartedAt = 0
let frameLastAt = 0
let longTaskObserver: PerformanceObserver | null = null

function resetMetrics(metrics: HeightMetrics) {
  metrics.current = 0
  metrics.maxDelta = 0
  metrics.largeJumps = 0
  metrics.changes = 0
  metrics.lastHeight = 0
  metrics.styleHeight = ''
  metrics.rectHeight = 0
  metrics.clientHeight = 0
  metrics.offsetHeight = 0
  metrics.scrollHeight = 0
  metrics.maxHeight = ''
  metrics.overflowY = ''
  metrics.hasScrollbar = false
  metrics.scrollbarWidth = 0
  metrics.transition = ''
  metrics.monacoContentHeight = 0
  metrics.monacoScrollHeight = 0
  metrics.monacoScrollTop = 0
  metrics.monacoLayoutHeight = 0
  metrics.monacoHasScrollbar = false
  metrics.lineCount = 0
  metrics.scheduleCalls = 0
  metrics.scheduleTotalMs = 0
  metrics.scheduleMaxMs = 0
  metrics.slowSchedules = 0
}

function resetRuntimeMetrics() {
  runtimeMetrics.streamMs = 0
  runtimeMetrics.frames = 0
  runtimeMetrics.totalFrameGap = 0
  runtimeMetrics.maxFrameGap = 0
  runtimeMetrics.longTasks = 0
  runtimeMetrics.longTaskTotalMs = 0
  runtimeMetrics.maxLongTaskMs = 0
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function scheduleAverage(metrics: HeightMetrics) {
  if (metrics.scheduleCalls === 0)
    return 0
  return round(metrics.scheduleTotalMs / metrics.scheduleCalls)
}

function averageFrameGap() {
  if (runtimeMetrics.frames === 0)
    return 0
  return round(runtimeMetrics.totalFrameGap / runtimeMetrics.frames)
}

function sampleContainer(target: HTMLElement, metrics: HeightMetrics, editorApi: typeof baselineEditor) {
  const rect = target.getBoundingClientRect()
  const styles = getComputedStyle(target)
  const editor = editorApi.getEditorView()
  metrics.styleHeight = target.style.height
  metrics.rectHeight = round(rect.height)
  metrics.clientHeight = target.clientHeight
  metrics.offsetHeight = target.offsetHeight
  metrics.scrollHeight = target.scrollHeight
  metrics.maxHeight = styles.maxHeight
  metrics.overflowY = styles.overflowY
  metrics.hasScrollbar = target.scrollHeight > target.clientHeight + 1
  metrics.scrollbarWidth = Math.max(0, target.offsetWidth - target.clientWidth)
  metrics.transition = styles.transition
  metrics.monacoContentHeight = round(editor?.getContentHeight?.() ?? 0)
  metrics.monacoScrollHeight = round(editor?.getScrollHeight?.() ?? 0)
  metrics.monacoScrollTop = round(editor?.getScrollTop?.() ?? 0)
  metrics.monacoLayoutHeight = round(editor?.getLayoutInfo?.()?.height ?? 0)
  metrics.monacoHasScrollbar = metrics.monacoScrollHeight > metrics.monacoLayoutHeight + 1
  metrics.lineCount = editor?.getModel?.()?.getLineCount?.() ?? 0
}

function recordHeight(height: number, metrics: HeightMetrics) {
  metrics.current = Math.round(height)
  if (metrics.lastHeight > 0) {
    const delta = Math.abs(height - metrics.lastHeight)
    if (delta >= 0.5) {
      metrics.changes += 1
      metrics.maxDelta = Math.max(metrics.maxDelta, Math.round(delta))
      if (delta >= 64)
        metrics.largeJumps += 1
    }
  }
  metrics.lastHeight = height
}

function observeHeight(target: HTMLElement, metrics: HeightMetrics, editorApi: typeof baselineEditor) {
  const observer = new ResizeObserver((entries) => {
    const height = entries[0]?.contentRect.height ?? 0
    recordHeight(height, metrics)
    sampleContainer(target, metrics, editorApi)
  })
  observer.observe(target)
  observers.push(observer)
}

function recordSchedule(metrics: HeightMetrics, run: () => void) {
  const start = performance.now()
  run()
  const duration = performance.now() - start
  metrics.scheduleCalls += 1
  metrics.scheduleTotalMs = round(metrics.scheduleTotalMs + duration)
  metrics.scheduleMaxMs = Math.max(metrics.scheduleMaxMs, round(duration))
  if (duration > 8)
    metrics.slowSchedules += 1
}

function stopFrameSampler() {
  if (frameRaf != null) {
    cancelAnimationFrame(frameRaf)
    frameRaf = null
  }
}

function startFrameSampler() {
  stopFrameSampler()
  frameLastAt = performance.now()
  const tick = (now: number) => {
    const gap = now - frameLastAt
    frameLastAt = now
    runtimeMetrics.frames += 1
    runtimeMetrics.totalFrameGap = round(runtimeMetrics.totalFrameGap + gap)
    runtimeMetrics.maxFrameGap = Math.max(runtimeMetrics.maxFrameGap, round(gap))
    if (running.value)
      frameRaf = requestAnimationFrame(tick)
  }
  frameRaf = requestAnimationFrame(tick)
}

function installLongTaskObserver() {
  if (typeof PerformanceObserver === 'undefined')
    return
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (!running.value)
        return
      for (const entry of list.getEntries()) {
        runtimeMetrics.longTasks += 1
        runtimeMetrics.longTaskTotalMs = round(runtimeMetrics.longTaskTotalMs + entry.duration)
        runtimeMetrics.maxLongTaskMs = Math.max(runtimeMetrics.maxLongTaskMs, round(entry.duration))
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: false })
  }
  catch {}
}

function refreshSamples() {
  if (baselineEl.value)
    sampleContainer(baselineEl.value, baselineMetrics, baselineEditor)
  if (smoothEl.value)
    sampleContainer(smoothEl.value, smoothMetrics, smoothEditor)
  if (constrainedBaselineEl.value)
    sampleContainer(constrainedBaselineEl.value, constrainedBaselineMetrics, constrainedBaselineEditor)
  if (constrainedSmoothEl.value)
    sampleContainer(constrainedSmoothEl.value, constrainedSmoothMetrics, constrainedSmoothEditor)
}

function buildReport() {
  refreshSamples()
  return {
    runtime: {
      streamMs: runtimeMetrics.streamMs,
      frames: runtimeMetrics.frames,
      averageFrameGap: averageFrameGap(),
      maxFrameGap: runtimeMetrics.maxFrameGap,
      longTasks: runtimeMetrics.longTasks,
      longTaskTotalMs: runtimeMetrics.longTaskTotalMs,
      maxLongTaskMs: runtimeMetrics.maxLongTaskMs,
    },
    baseline: {
      ...baselineMetrics,
      scheduleAverageMs: scheduleAverage(baselineMetrics),
    },
    smooth: {
      ...smoothMetrics,
      scheduleAverageMs: scheduleAverage(smoothMetrics),
    },
    constrainedBaseline: {
      ...constrainedBaselineMetrics,
      scheduleAverageMs: scheduleAverage(constrainedBaselineMetrics),
    },
    constrainedSmooth: {
      ...constrainedSmoothMetrics,
      scheduleAverageMs: scheduleAverage(constrainedSmoothMetrics),
    },
  }
}

function publishReport() {
  document.documentElement.dataset.heightStabilityReport = JSON.stringify(buildReport())
}

function stopStream(options: { finalSample?: boolean } = {}) {
  if (startTimer != null) {
    clearTimeout(startTimer)
    startTimer = null
  }
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
  if (finalSampleTimer != null) {
    clearTimeout(finalSampleTimer)
    finalSampleTimer = null
  }
  running.value = false
  stopFrameSampler()
  runtimeMetrics.streamMs = streamStartedAt > 0
    ? round(performance.now() - streamStartedAt)
    : runtimeMetrics.streamMs
  refreshSamples()
  publishReport()
  if (options.finalSample === false)
    return
  finalSampleTimer = setTimeout(() => {
    finalSampleTimer = null
    refreshSamples()
    publishReport()
  }, 400)
}

function startStream() {
  stopStream()
  let offset = 0
  running.value = true
  streamStartedAt = performance.now()
  resetRuntimeMetrics()
  recordSchedule(baselineMetrics, () => baselineEditor.updateCode('', 'markdown'))
  recordSchedule(smoothMetrics, () => smoothEditor.updateCode('', 'markdown'))
  recordSchedule(constrainedBaselineMetrics, () => constrainedBaselineEditor.updateCode('', 'markdown'))
  recordSchedule(constrainedSmoothMetrics, () => constrainedSmoothEditor.updateCode('', 'markdown'))
  startTimer = setTimeout(() => {
    startTimer = null
    resetMetrics(baselineMetrics)
    resetMetrics(smoothMetrics)
    resetMetrics(constrainedBaselineMetrics)
    resetMetrics(constrainedSmoothMetrics)
    resetRuntimeMetrics()
    streamStartedAt = performance.now()
    startFrameSampler()
    timer = setInterval(() => {
      offset += 42
      const next = markdown.slice(0, Math.min(offset, markdown.length))
      recordSchedule(baselineMetrics, () => baselineEditor.updateCode(next, 'markdown'))
      recordSchedule(smoothMetrics, () => smoothEditor.updateCode(next, 'markdown'))
      recordSchedule(constrainedBaselineMetrics, () => constrainedBaselineEditor.updateCode(next, 'markdown'))
      recordSchedule(constrainedSmoothMetrics, () => constrainedSmoothEditor.updateCode(next, 'markdown'))
      refreshSamples()
      if (offset >= markdown.length)
        stopStream()
    }, 24)
  }, 180)
}

onMounted(async () => {
  if (!baselineEl.value || !smoothEl.value || !constrainedBaselineEl.value || !constrainedSmoothEl.value)
    return
  await Promise.all([
    baselineEditor.createEditor(baselineEl.value, '', 'markdown'),
    smoothEditor.createEditor(smoothEl.value, '', 'markdown'),
    constrainedBaselineEditor.createEditor(constrainedBaselineEl.value, '', 'markdown'),
    constrainedSmoothEditor.createEditor(constrainedSmoothEl.value, '', 'markdown'),
  ])
  observeHeight(baselineEl.value, baselineMetrics, baselineEditor)
  observeHeight(smoothEl.value, smoothMetrics, smoothEditor)
  observeHeight(constrainedBaselineEl.value, constrainedBaselineMetrics, constrainedBaselineEditor)
  observeHeight(constrainedSmoothEl.value, constrainedSmoothMetrics, constrainedSmoothEditor)
  installLongTaskObserver()
  ;(window as any).__heightStabilityReport = buildReport
  ;(window as any).__heightStabilityRestart = startStream
  startStream()
})

onBeforeUnmount(() => {
  stopStream({ finalSample: false })
  stopFrameSampler()
  longTaskObserver?.disconnect()
  longTaskObserver = null
  for (const observer of observers)
    observer.disconnect()
  observers = []
  delete (window as any).__heightStabilityReport
  delete (window as any).__heightStabilityRestart
  baselineEditor.cleanupEditor()
  smoothEditor.cleanupEditor()
  constrainedBaselineEditor.cleanupEditor()
  constrainedSmoothEditor.cleanupEditor()
})
</script>

<template>
  <section class="height-demo">
    <header class="toolbar">
      <h1>Height Stability Demo</h1>
      <div class="actions">
        <button :disabled="running" @click="startStream">
          Restart
        </button>
        <button :disabled="!running" @click="stopStream()">
          Stop
        </button>
      </div>
    </header>

    <dl class="runtime-metrics">
      <div>
        <dt>stream ms</dt>
        <dd>{{ runtimeMetrics.streamMs }}</dd>
      </div>
      <div>
        <dt>frames</dt>
        <dd>{{ runtimeMetrics.frames }}</dd>
      </div>
      <div>
        <dt>avg frame gap</dt>
        <dd>{{ averageFrameGap() }}ms</dd>
      </div>
      <div>
        <dt>max frame gap</dt>
        <dd>{{ runtimeMetrics.maxFrameGap }}ms</dd>
      </div>
      <div>
        <dt>long tasks</dt>
        <dd>{{ runtimeMetrics.longTasks }}</dd>
      </div>
      <div>
        <dt>max long task</dt>
        <dd>{{ runtimeMetrics.maxLongTaskMs }}ms</dd>
      </div>
    </dl>

    <h2 class="scenario-title">
      Standard max height (MAX_HEIGHT 420)
    </h2>

    <div class="grid">
      <article class="panel" data-kind="baseline">
        <div class="panel-header">
          <h2>Baseline</h2>
          <span>smoothHeightTransition: false</span>
        </div>
        <dl class="metrics">
          <div>
            <dt>height</dt>
            <dd>{{ baselineMetrics.current }}px</dd>
          </div>
          <div>
            <dt>max delta</dt>
            <dd>{{ baselineMetrics.maxDelta }}px</dd>
          </div>
          <div>
            <dt>large jumps</dt>
            <dd>{{ baselineMetrics.largeJumps }}</dd>
          </div>
          <div>
            <dt>changes</dt>
            <dd>{{ baselineMetrics.changes }}</dd>
          </div>
          <div>
            <dt>scrollbar</dt>
            <dd>{{ baselineMetrics.hasScrollbar ? 'yes' : 'no' }}</dd>
          </div>
          <div>
            <dt>monaco scrollbar</dt>
            <dd>{{ baselineMetrics.monacoHasScrollbar ? 'yes' : 'no' }}</dd>
          </div>
          <div>
            <dt>scroll height</dt>
            <dd>{{ baselineMetrics.scrollHeight }}px</dd>
          </div>
          <div>
            <dt>client height</dt>
            <dd>{{ baselineMetrics.clientHeight }}px</dd>
          </div>
          <div>
            <dt>style height</dt>
            <dd>{{ baselineMetrics.styleHeight || 'n/a' }}</dd>
          </div>
          <div>
            <dt>max height</dt>
            <dd>{{ baselineMetrics.maxHeight || 'n/a' }}</dd>
          </div>
          <div>
            <dt>overflow</dt>
            <dd>{{ baselineMetrics.overflowY || 'n/a' }}</dd>
          </div>
          <div>
            <dt>content height</dt>
            <dd>{{ baselineMetrics.monacoContentHeight }}px</dd>
          </div>
          <div>
            <dt>layout height</dt>
            <dd>{{ baselineMetrics.monacoLayoutHeight }}px</dd>
          </div>
          <div>
            <dt>scroll top</dt>
            <dd>{{ baselineMetrics.monacoScrollTop }}px</dd>
          </div>
          <div>
            <dt>avg schedule</dt>
            <dd>{{ scheduleAverage(baselineMetrics) }}ms</dd>
          </div>
        </dl>
        <div ref="baselineEl" class="editor" />
      </article>

      <article class="panel" data-kind="smooth">
        <div class="panel-header">
          <h2>Smooth</h2>
          <span>smoothHeightTransition: true</span>
        </div>
        <dl class="metrics">
          <div>
            <dt>height</dt>
            <dd>{{ smoothMetrics.current }}px</dd>
          </div>
          <div>
            <dt>max delta</dt>
            <dd>{{ smoothMetrics.maxDelta }}px</dd>
          </div>
          <div>
            <dt>large jumps</dt>
            <dd>{{ smoothMetrics.largeJumps }}</dd>
          </div>
          <div>
            <dt>changes</dt>
            <dd>{{ smoothMetrics.changes }}</dd>
          </div>
          <div>
            <dt>scrollbar</dt>
            <dd>{{ smoothMetrics.hasScrollbar ? 'yes' : 'no' }}</dd>
          </div>
          <div>
            <dt>monaco scrollbar</dt>
            <dd>{{ smoothMetrics.monacoHasScrollbar ? 'yes' : 'no' }}</dd>
          </div>
          <div>
            <dt>scroll height</dt>
            <dd>{{ smoothMetrics.scrollHeight }}px</dd>
          </div>
          <div>
            <dt>client height</dt>
            <dd>{{ smoothMetrics.clientHeight }}px</dd>
          </div>
          <div>
            <dt>style height</dt>
            <dd>{{ smoothMetrics.styleHeight || 'n/a' }}</dd>
          </div>
          <div>
            <dt>max height</dt>
            <dd>{{ smoothMetrics.maxHeight || 'n/a' }}</dd>
          </div>
          <div>
            <dt>overflow</dt>
            <dd>{{ smoothMetrics.overflowY || 'n/a' }}</dd>
          </div>
          <div>
            <dt>content height</dt>
            <dd>{{ smoothMetrics.monacoContentHeight }}px</dd>
          </div>
          <div>
            <dt>layout height</dt>
            <dd>{{ smoothMetrics.monacoLayoutHeight }}px</dd>
          </div>
          <div>
            <dt>scroll top</dt>
            <dd>{{ smoothMetrics.monacoScrollTop }}px</dd>
          </div>
          <div>
            <dt>avg schedule</dt>
            <dd>{{ scheduleAverage(smoothMetrics) }}ms</dd>
          </div>
        </dl>
        <div ref="smoothEl" class="editor" />
      </article>
    </div>

    <h2 class="scenario-title">
      Constrained max height (MAX_HEIGHT 180)
    </h2>

    <div class="grid">
      <article class="panel" data-kind="constrained-baseline">
        <div class="panel-header">
          <h2>Baseline</h2>
          <span>MAX_HEIGHT: 180, smoothHeightTransition: false</span>
        </div>
        <dl class="metrics">
          <div>
            <dt>height</dt>
            <dd>{{ constrainedBaselineMetrics.current }}px</dd>
          </div>
          <div>
            <dt>max delta</dt>
            <dd>{{ constrainedBaselineMetrics.maxDelta }}px</dd>
          </div>
          <div>
            <dt>large jumps</dt>
            <dd>{{ constrainedBaselineMetrics.largeJumps }}</dd>
          </div>
          <div>
            <dt>changes</dt>
            <dd>{{ constrainedBaselineMetrics.changes }}</dd>
          </div>
          <div>
            <dt>scrollbar</dt>
            <dd>{{ constrainedBaselineMetrics.hasScrollbar ? 'yes' : 'no' }}</dd>
          </div>
          <div>
            <dt>monaco scrollbar</dt>
            <dd>{{ constrainedBaselineMetrics.monacoHasScrollbar ? 'yes' : 'no' }}</dd>
          </div>
          <div>
            <dt>scroll height</dt>
            <dd>{{ constrainedBaselineMetrics.scrollHeight }}px</dd>
          </div>
          <div>
            <dt>client height</dt>
            <dd>{{ constrainedBaselineMetrics.clientHeight }}px</dd>
          </div>
          <div>
            <dt>style height</dt>
            <dd>{{ constrainedBaselineMetrics.styleHeight || 'n/a' }}</dd>
          </div>
          <div>
            <dt>max height</dt>
            <dd>{{ constrainedBaselineMetrics.maxHeight || 'n/a' }}</dd>
          </div>
          <div>
            <dt>overflow</dt>
            <dd>{{ constrainedBaselineMetrics.overflowY || 'n/a' }}</dd>
          </div>
          <div>
            <dt>content height</dt>
            <dd>{{ constrainedBaselineMetrics.monacoContentHeight }}px</dd>
          </div>
          <div>
            <dt>layout height</dt>
            <dd>{{ constrainedBaselineMetrics.monacoLayoutHeight }}px</dd>
          </div>
          <div>
            <dt>scroll top</dt>
            <dd>{{ constrainedBaselineMetrics.monacoScrollTop }}px</dd>
          </div>
          <div>
            <dt>avg schedule</dt>
            <dd>{{ scheduleAverage(constrainedBaselineMetrics) }}ms</dd>
          </div>
        </dl>
        <div ref="constrainedBaselineEl" class="editor" />
      </article>

      <article class="panel" data-kind="constrained-smooth">
        <div class="panel-header">
          <h2>Smooth</h2>
          <span>MAX_HEIGHT: 180, smoothHeightTransition: true</span>
        </div>
        <dl class="metrics">
          <div>
            <dt>height</dt>
            <dd>{{ constrainedSmoothMetrics.current }}px</dd>
          </div>
          <div>
            <dt>max delta</dt>
            <dd>{{ constrainedSmoothMetrics.maxDelta }}px</dd>
          </div>
          <div>
            <dt>large jumps</dt>
            <dd>{{ constrainedSmoothMetrics.largeJumps }}</dd>
          </div>
          <div>
            <dt>changes</dt>
            <dd>{{ constrainedSmoothMetrics.changes }}</dd>
          </div>
          <div>
            <dt>scrollbar</dt>
            <dd>{{ constrainedSmoothMetrics.hasScrollbar ? 'yes' : 'no' }}</dd>
          </div>
          <div>
            <dt>monaco scrollbar</dt>
            <dd>{{ constrainedSmoothMetrics.monacoHasScrollbar ? 'yes' : 'no' }}</dd>
          </div>
          <div>
            <dt>scroll height</dt>
            <dd>{{ constrainedSmoothMetrics.scrollHeight }}px</dd>
          </div>
          <div>
            <dt>client height</dt>
            <dd>{{ constrainedSmoothMetrics.clientHeight }}px</dd>
          </div>
          <div>
            <dt>style height</dt>
            <dd>{{ constrainedSmoothMetrics.styleHeight || 'n/a' }}</dd>
          </div>
          <div>
            <dt>max height</dt>
            <dd>{{ constrainedSmoothMetrics.maxHeight || 'n/a' }}</dd>
          </div>
          <div>
            <dt>overflow</dt>
            <dd>{{ constrainedSmoothMetrics.overflowY || 'n/a' }}</dd>
          </div>
          <div>
            <dt>content height</dt>
            <dd>{{ constrainedSmoothMetrics.monacoContentHeight }}px</dd>
          </div>
          <div>
            <dt>layout height</dt>
            <dd>{{ constrainedSmoothMetrics.monacoLayoutHeight }}px</dd>
          </div>
          <div>
            <dt>scroll top</dt>
            <dd>{{ constrainedSmoothMetrics.monacoScrollTop }}px</dd>
          </div>
          <div>
            <dt>avg schedule</dt>
            <dd>{{ scheduleAverage(constrainedSmoothMetrics) }}ms</dd>
          </div>
        </dl>
        <div ref="constrainedSmoothEl" class="editor" />
      </article>
    </div>
  </section>
</template>

<style scoped>
.height-demo {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  align-items: center;
  display: flex;
  gap: 16px;
  justify-content: space-between;
}

h1,
h2 {
  margin: 0;
}

h1 {
  font-size: 20px;
}

h2 {
  font-size: 16px;
}

.scenario-title {
  margin-top: 4px;
}

.actions {
  display: flex;
  gap: 8px;
}

button {
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  background: #fff;
  color: #0f172a;
  cursor: pointer;
  padding: 6px 10px;
}

button:disabled {
  cursor: default;
  opacity: 0.5;
}

.grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel {
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 12px;
}

.panel-header {
  align-items: baseline;
  display: flex;
  gap: 10px;
  justify-content: space-between;
  margin-bottom: 10px;
}

.panel-header span {
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.runtime-metrics,
.metrics {
  display: grid;
  gap: 8px;
  margin: 0 0 12px;
}

.runtime-metrics {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

.metrics {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.runtime-metrics div,
.metrics div {
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  padding: 8px;
}

dt {
  color: #64748b;
  font-size: 12px;
}

dd {
  color: #0f172a;
  font-size: 16px;
  font-weight: 600;
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor {
  border: 1px solid #e0e0e0;
  border-radius: 4px;
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }

  .toolbar,
  .panel-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .runtime-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
