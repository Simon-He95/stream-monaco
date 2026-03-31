<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import {
  preloadMonacoWorkers,
  type DiffHunkActionContext,
  type MonacoLanguage,
  type MonacoOptions,
  useMonaco,
} from '../../../src/index'

type DiffPair = { original: string; modified: string }
type DiffHunkActionMode = 'default' | 'custom-patch' | 'custom-update-diff'
type DiffTestModelPair = {
  original: import('monaco-editor').editor.ITextModel
  modified: import('monaco-editor').editor.ITextModel
}
type DiffTestApi = {
  swapModelsSameContent: () => Promise<void> | void
  swapModelsChangedContent: () => Promise<void> | void
  setDiffPair: (
    pair: DiffPair,
    options?: { preserveViewState?: boolean },
  ) => Promise<void> | void
  resetScenario: () => Promise<void> | void
  getDiffValues: () => DiffPair
  getActionLogs: () => string[]
  getPatchFlowLogs: () => string[]
  getDiffSummary: () => {
    diffCount: number
    diffState: 'ready' | 'null'
    addedLines: number
    removedLines: number
  }
  setHunkActionMode: (mode: DiffHunkActionMode) => void
  getHunkActionMode: () => DiffHunkActionMode
  setModifiedScrollTop: (top: number) => void
  getModifiedScrollTop: () => number
}

declare global {
  interface Window {
    __streamMonacoDiffTestApi?: DiffTestApi
  }
}

const collapsedOption = {
  enabled: true,
  contextLineCount: 2,
  minimumLineCount: 4,
  revealLineCount: 5,
} as const

const lineInfoCollapsedOption = {
  enabled: true,
  contextLineCount: 4,
  minimumLineCount: 4,
  revealLineCount: 5,
} as const

const el = ref<HTMLElement | null>(null)
const actionLogs = ref<string[]>([])
const patchFlowLogs = ref<string[]>([])
const diffCount = ref(0)
const diffState = ref<'ready' | 'null'>('null')
const collapsed = ref(true)
const addedLines = ref(0)
const removedLines = ref(0)
const streamPlaybackActive = ref(false)
const streamPaused = ref(false)
const fileName = ref('packages/runtime/src/synchronizeTasks.ts')
const fileCaption = ref('Pierre-inspired diff chrome on top of Monaco + Shiki')
let pair: DiffPair | null = null
let scenarioVersion = 0
let diffHunkActionMode: DiffHunkActionMode = 'default'
let diffUpdatedDisposable: { dispose: () => void } | null = null
let diffPollTimer: number | null = null
let diffStreamTimer: number | null = null
let diffStreamTicket = 0
let injectedDiffModels: DiffTestModelPair | null = null

type LineChangeLike = {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

type DiffLineStyle = NonNullable<MonacoOptions['diffLineStyle']>
type DiffScenario = 'streaming' | 'pierre-reference' | 'line-info-reference'
type DiffAppearance = NonNullable<MonacoOptions['diffAppearance']>
type DiffUnchangedRegionStyle = NonNullable<
  MonacoOptions['diffUnchangedRegionStyle']
>
type DiffColumnCount = 1 | 2
type StreamSpeed = 'slow' | 'normal' | 'fast'
type DiffTheme =
  | 'vitesse-light'
  | 'vitesse-dark'
  | 'snazzy-light'
  | 'one-light'
  | 'rose-pine-dawn'
  | 'rose-pine-moon'
  | 'catppuccin-latte'
  | 'catppuccin-mocha'
  | 'github-dark'
type ReferenceLineCount = 6 | 48 | 512 | 4096
type DiffViewportState = {
  originalTop: number
  originalLeft: number
  modifiedTop: number
  modifiedLeft: number
}

const streamSpeedOptions = {
  slow: {
    label: 'Slow',
    delayMs: 20,
  },
  normal: {
    label: 'Normal',
    delayMs: 10,
  },
  fast: {
    label: 'Fast',
    delayMs: 4,
  },
} as const satisfies Record<
  StreamSpeed,
  {
    label: string
    delayMs: number
  }
>

const lightDiffThemes = [
  'snazzy-light',
  'one-light',
  'rose-pine-dawn',
  'catppuccin-latte',
  'vitesse-light',
] as const satisfies readonly DiffTheme[]

const darkDiffThemes = [
  'vitesse-dark',
  'github-dark',
  'rose-pine-moon',
  'catppuccin-mocha',
] as const satisfies readonly DiffTheme[]

const themeLabels: Record<DiffTheme, string> = {
  'vitesse-light': 'Vitesse Light',
  'vitesse-dark': 'Vitesse Dark',
  'snazzy-light': 'Snazzy Light',
  'one-light': 'One Light',
  'rose-pine-dawn': 'Rose Dawn',
  'rose-pine-moon': 'Rose Moon',
  'catppuccin-latte': 'Latte',
  'catppuccin-mocha': 'Mocha',
  'github-dark': 'GitHub Dark',
}

function isDarkDiffTheme(theme: DiffTheme) {
  return (darkDiffThemes as readonly string[]).includes(theme)
}

function resolveThemeForAppearance(
  theme: DiffTheme,
  appearance: 'light' | 'dark',
): DiffTheme {
  if (appearance === 'dark') {
    if (theme === 'vitesse-light' || theme === 'vitesse-dark')
      return 'vitesse-dark'
    if (theme === 'rose-pine-dawn' || theme === 'rose-pine-moon')
      return 'rose-pine-moon'
    if (theme === 'catppuccin-latte' || theme === 'catppuccin-mocha')
      return 'catppuccin-mocha'
    return 'github-dark'
  }
  if (theme === 'vitesse-light' || theme === 'vitesse-dark')
    return 'vitesse-light'
  if (theme === 'rose-pine-dawn' || theme === 'rose-pine-moon')
    return 'rose-pine-dawn'
  if (theme === 'catppuccin-latte' || theme === 'catppuccin-mocha')
    return 'catppuccin-latte'
  if (theme === 'snazzy-light') return 'snazzy-light'
  return 'one-light'
}

function parseDiffLineStyle(value: string | null | undefined): DiffLineStyle {
  return value === 'bar' ? 'bar' : 'background'
}

function parseDiffScenario(
  value: string | null | undefined,
  fallback: DiffScenario,
): DiffScenario {
  if (value === 'pierre-reference' || value === 'reference')
    return 'pierre-reference'
  if (value === 'line-info-reference' || value === 'line-info')
    return 'line-info-reference'
  if (value === 'streaming') return 'streaming'
  return fallback
}

function parseDiffTheme(
  value: string | null | undefined,
  fallback: DiffTheme,
): DiffTheme {
  if (
    value === 'vitesse-dark' ||
    value === 'snazzy-light' ||
    value === 'one-light' ||
    value === 'rose-pine-dawn' ||
    value === 'catppuccin-latte' ||
    value === 'vitesse-light' ||
    value === 'rose-pine-moon' ||
    value === 'catppuccin-mocha' ||
    value === 'github-dark'
  ) {
    return value
  }
  return fallback
}

function parseDiffAppearance(
  value: string | null | undefined,
  fallback: DiffAppearance,
): DiffAppearance {
  if (value === 'light' || value === 'dark') return value
  return value === 'auto' ? 'auto' : fallback
}

function parseDiffColumnCount(
  value: string | null | undefined,
  fallback: DiffColumnCount,
): DiffColumnCount {
  if (value === '1') return 1
  if (value === '2') return 2
  return fallback
}

function parseBooleanFlag(
  value: string | null | undefined,
  fallback: boolean,
) {
  if (value === '1' || value === 'true' || value === 'on') return true
  if (value === '0' || value === 'false' || value === 'off') return false
  return fallback
}

function parseStreamSpeed(
  value: string | null | undefined,
  fallback: StreamSpeed,
): StreamSpeed {
  if (value === 'slow' || value === 'normal' || value === 'fast') return value
  return fallback
}

function parseReferenceLineCount(
  value: string | null | undefined,
  fallback: ReferenceLineCount,
): ReferenceLineCount {
  if (value === '48') return 48
  if (value === '512') return 512
  if (value === '4096') return 4096
  if (value === '6') return 6
  return fallback
}

function parseDiffUnchangedRegionStyle(
  value: string | null | undefined,
  fallback: DiffUnchangedRegionStyle,
): DiffUnchangedRegionStyle {
  if (value === 'line-info-basic') return 'line-info-basic'
  if (value === 'simple') return 'simple'
  return value === 'metadata' ? 'metadata' : fallback
}

const initialDiffLineStyle =
  typeof window !== 'undefined'
    ? parseDiffLineStyle(
        new URLSearchParams(window.location.search).get('style'),
      )
    : 'background'

const diffLineStyle = ref<DiffLineStyle>(initialDiffLineStyle)
const captureMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('capture') === '1'
const initialDiffScenario =
  typeof window !== 'undefined'
    ? parseDiffScenario(
        new URLSearchParams(window.location.search).get('scenario'),
        captureMode ? 'pierre-reference' : 'streaming',
      )
    : 'streaming'
const diffScenario = ref<DiffScenario>(initialDiffScenario)
const isReferenceScenario = computed(
  () => diffScenario.value === 'pierre-reference',
)
const isLineInfoScenario = computed(
  () => diffScenario.value === 'line-info-reference',
)
const initialDiffAppearance =
  typeof window !== 'undefined'
    ? parseDiffAppearance(
        new URLSearchParams(window.location.search).get('appearance'),
        'auto',
      )
    : 'auto'
const diffAppearance = ref<DiffAppearance>(initialDiffAppearance)
const initialDiffTheme =
  typeof window !== 'undefined'
    ? parseDiffTheme(
        new URLSearchParams(window.location.search).get('theme'),
        captureMode ? 'snazzy-light' : 'vitesse-light',
      )
    : 'vitesse-light'
const diffTheme = ref<DiffTheme>(initialDiffTheme)
const effectiveDiffAppearance = computed<'light' | 'dark'>(() => {
  if (diffAppearance.value === 'light' || diffAppearance.value === 'dark')
    return diffAppearance.value
  return isDarkDiffTheme(diffTheme.value) ? 'dark' : 'light'
})
const availableDiffThemes = computed<DiffTheme[]>(() =>
  diffAppearance.value === 'dark'
    ? [...darkDiffThemes]
    : diffAppearance.value === 'light'
    ? [...lightDiffThemes]
    : [...lightDiffThemes, ...darkDiffThemes],
)
const initialDiffUnchangedRegionStyle =
  typeof window !== 'undefined'
    ? parseDiffUnchangedRegionStyle(
        new URLSearchParams(window.location.search).get('unchangedStyle'),
        'line-info',
      )
    : 'line-info'
const diffUnchangedRegionStyle = ref<DiffUnchangedRegionStyle>(
  initialDiffUnchangedRegionStyle,
)
const initialReferenceLineCount =
  typeof window !== 'undefined'
    ? parseReferenceLineCount(
        new URLSearchParams(window.location.search).get('lines'),
        6,
      )
    : 6
const referenceLineCount = ref<ReferenceLineCount>(initialReferenceLineCount)
const initialDiffColumnCount =
  typeof window !== 'undefined'
    ? parseDiffColumnCount(
        new URLSearchParams(window.location.search).get('columns'),
        2,
      )
    : 2
const diffColumnCount = ref<DiffColumnCount>(initialDiffColumnCount)
const initialStreamOutput =
  typeof window !== 'undefined'
    ? parseBooleanFlag(
        new URLSearchParams(window.location.search).get('streamOutput'),
        false,
      )
    : false
const streamOutput = ref(initialStreamOutput)
const initialStreamSpeed =
  typeof window !== 'undefined'
    ? parseStreamSpeed(
        new URLSearchParams(window.location.search).get('streamSpeed'),
        'normal',
      )
    : 'normal'
const streamSpeed = ref<StreamSpeed>(initialStreamSpeed)

function normalizeThemeSelection() {
  if (diffAppearance.value === 'dark' && !isDarkDiffTheme(diffTheme.value)) {
    diffTheme.value = resolveThemeForAppearance(diffTheme.value, 'dark')
    return
  }
  if (diffAppearance.value === 'light' && isDarkDiffTheme(diffTheme.value)) {
    diffTheme.value = resolveThemeForAppearance(diffTheme.value, 'light')
  }
}

normalizeThemeSelection()
const referenceLineDigits = computed(() =>
  Math.max(2, String(referenceLineCount.value).length),
)
const referenceLineNumberWidth = computed(
  () => 36 + Math.max(0, referenceLineDigits.value - 2) * 12,
)
const referenceGutterMetrics = computed(() => {
  const markerWidth = 4
  const gap = 16
  const numberWidth = referenceLineNumberWidth.value
  const marginWidth = markerWidth + gap * 2 + numberWidth
  return {
    markerWidth,
    gap,
    numberWidth,
    marginWidth,
    lineNumberLeft: markerWidth + gap,
  }
})
const editorInlineStyle = computed<Record<string, string>>(() => {
  if (!isReferenceScenario.value && !isLineInfoScenario.value) return {}
  const marginWidth = `${referenceGutterMetrics.value.marginWidth}px`
  return {
    '--stream-monaco-gutter-marker-width': `${referenceGutterMetrics.value.markerWidth}px`,
    '--stream-monaco-gutter-gap': `${referenceGutterMetrics.value.gap}px`,
    '--stream-monaco-line-number-left': `${referenceGutterMetrics.value.lineNumberLeft}px`,
    '--stream-monaco-line-number-width': `${referenceGutterMetrics.value.numberWidth}px`,
    '--stream-monaco-original-margin-width': marginWidth,
    '--stream-monaco-original-scrollable-left': marginWidth,
    '--stream-monaco-original-scrollable-width': `calc(100% - ${marginWidth})`,
    '--stream-monaco-modified-margin-width': marginWidth,
    '--stream-monaco-modified-scrollable-left': marginWidth,
    '--stream-monaco-modified-scrollable-width': `calc(100% - ${marginWidth})`,
  }
})

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

function pushPatchFlowLog(text: string) {
  patchFlowLogs.value = [text, ...patchFlowLogs.value].slice(0, 10)
}

function formatDiffHunkActionLog(ctx: DiffHunkActionContext) {
  return `${ctx.action.toUpperCase()} ${ctx.side} | O:${
    ctx.lineChange.originalStartLineNumber
  }-${ctx.lineChange.originalEndLineNumber} M:${
    ctx.lineChange.modifiedStartLineNumber
  }-${ctx.lineChange.modifiedEndLineNumber}`
}

function hasDiffLineRange(startLineNumber: number, endLineNumber: number) {
  return startLineNumber > 0 && endLineNumber >= startLineNumber
}

function splitDiffText(value: string) {
  return value === '' ? [] : value.split(/\r?\n/)
}

function joinDiffText(lines: string[]) {
  return lines.join('\n')
}

function getDiffRangeLines(
  lines: string[],
  startLineNumber: number,
  endLineNumber: number,
) {
  if (!hasDiffLineRange(startLineNumber, endLineNumber)) return []
  return lines.slice(startLineNumber - 1, endLineNumber)
}

function removeDiffRangeLines(
  lines: string[],
  startLineNumber: number,
  endLineNumber: number,
) {
  const next = [...lines]
  if (!hasDiffLineRange(startLineNumber, endLineNumber)) return next
  next.splice(startLineNumber - 1, endLineNumber - startLineNumber + 1)
  return next
}

function insertDiffLinesBefore(
  lines: string[],
  lineNumber: number,
  insertedLines: string[],
) {
  const next = [...lines]
  const index = Math.max(0, Math.min(next.length, lineNumber - 1))
  next.splice(index, 0, ...insertedLines)
  return next
}

function insertDiffLinesAfter(
  lines: string[],
  lineNumber: number,
  insertedLines: string[],
) {
  const next = [...lines]
  const index = Math.max(0, Math.min(next.length, lineNumber))
  next.splice(index, 0, ...insertedLines)
  return next
}

function computeCustomPatchFlowPair(
  ctx: DiffHunkActionContext,
  values: DiffPair,
): DiffPair {
  const originalLines = splitDiffText(values.original)
  const modifiedLines = splitDiffText(values.modified)
  const hasOriginal = hasDiffLineRange(
    ctx.lineChange.originalStartLineNumber,
    ctx.lineChange.originalEndLineNumber,
  )
  const hasModified = hasDiffLineRange(
    ctx.lineChange.modifiedStartLineNumber,
    ctx.lineChange.modifiedEndLineNumber,
  )
  const originalChunk = getDiffRangeLines(
    originalLines,
    ctx.lineChange.originalStartLineNumber,
    ctx.lineChange.originalEndLineNumber,
  )
  const modifiedChunk = getDiffRangeLines(
    modifiedLines,
    ctx.lineChange.modifiedStartLineNumber,
    ctx.lineChange.modifiedEndLineNumber,
  )

  if (ctx.action === 'revert' && ctx.side === 'upper') {
    if (!hasOriginal || originalChunk.length === 0) return values
    const nextModified = hasModified
      ? insertDiffLinesBefore(
          modifiedLines,
          ctx.lineChange.modifiedStartLineNumber,
          originalChunk,
        )
      : insertDiffLinesAfter(
          modifiedLines,
          Math.max(
            0,
            ctx.lineChange.modifiedStartLineNumber
              || ctx.lineChange.modifiedEndLineNumber,
          ),
          originalChunk,
        )
    return {
      original: values.original,
      modified: joinDiffText(nextModified),
    }
  }

  if (ctx.action === 'revert' && ctx.side === 'lower') {
    if (!hasModified) return values
    return {
      original: values.original,
      modified: joinDiffText(
        removeDiffRangeLines(
          modifiedLines,
          ctx.lineChange.modifiedStartLineNumber,
          ctx.lineChange.modifiedEndLineNumber,
        ),
      ),
    }
  }

  if (ctx.action === 'stage' && ctx.side === 'upper') {
    if (!hasOriginal) return values
    return {
      original: joinDiffText(
        removeDiffRangeLines(
          originalLines,
          ctx.lineChange.originalStartLineNumber,
          ctx.lineChange.originalEndLineNumber,
        ),
      ),
      modified: values.modified,
    }
  }

  if (ctx.action === 'stage' && ctx.side === 'lower') {
    if (!hasModified || modifiedChunk.length === 0) return values
    const nextOriginal = hasOriginal
      ? insertDiffLinesAfter(
          originalLines,
          ctx.lineChange.originalEndLineNumber,
          modifiedChunk,
        )
      : insertDiffLinesAfter(
          originalLines,
          Math.max(0, ctx.lineChange.originalStartLineNumber),
          modifiedChunk,
        )
    return {
      original: joinDiffText(nextOriginal),
      modified: values.modified,
    }
  }

  return values
}

async function applyCustomPatchFlow(ctx: DiffHunkActionContext) {
  const summary = formatDiffHunkActionLog(ctx)
  await new Promise((resolve) => window.setTimeout(resolve, 24))
  const liveValues: DiffPair = {
    original: ctx.originalModel.getValue(),
    modified: ctx.modifiedModel.getValue(),
  }
  const nextPair = computeCustomPatchFlowPair(ctx, liveValues)
  pushPatchFlowLog(`PATCH FLOW ${summary}`)
  pair = nextPair
  ctx.originalModel.setValue(nextPair.original)
  ctx.modifiedModel.setValue(nextPair.modified)
  syncDiffCount()
  startPollDiffCount()
}

async function applyCustomUpdateDiffFlow(ctx: DiffHunkActionContext) {
  const summary = formatDiffHunkActionLog(ctx)
  await new Promise((resolve) => window.setTimeout(resolve, 24))
  const liveValues: DiffPair = {
    original: ctx.originalModel.getValue(),
    modified: ctx.modifiedModel.getValue(),
  }
  const nextPair = computeCustomPatchFlowPair(ctx, liveValues)
  pushPatchFlowLog(`UPDATE DIFF FLOW ${summary}`)
  pair = nextPair
  updateDiff(nextPair.original, nextPair.modified, currentScenarioMeta().language)
  syncDiffCount()
  window.setTimeout(() => syncDiffCount(), 30)
  startPollDiffCount()
}

function createStreamingScenario(version = 0): DiffPair {
  const variant = version % 3
  const originalLines: string[] = [
    "type Task = { id: string, status: 'todo' | 'done' }",
    '',
    'export async function synchronizeTasks(tasks: Task[]) {',
    '  const report: string[] = []',
    '  report.push(`input=${tasks.length}`)',
    '',
  ]

  for (let i = 1; i <= 220; i++) {
    if (i % 25 === 0) originalLines.push(`  // stable checkpoint ${i}`)
    const n = String(i).padStart(3, '0')
    originalLines.push(`  report.push('stable-${n}')`)
  }

  originalLines.push('', '  return report', '}')

  const modifiedLines = [...originalLines]

  const updateAround = modifiedLines.findIndex((line) =>
    line.includes('stable-015'),
  )
  if (updateAround >= 0) {
    modifiedLines[updateAround] = `  report.push('stable-015-optimized-v${
      variant + 1
    }')`
    modifiedLines[updateAround + 1] = `  report.push('stable-016-optimized-v${
      variant + 1
    }')`
  }

  const tuneAround = modifiedLines.findIndex((line) =>
    line.includes('stable-090'),
  )
  if (tuneAround >= 1) {
    modifiedLines[tuneAround - 1] = `  report.push('stable-089-hotfix-v${
      variant + 1
    }')`
    modifiedLines[tuneAround] = `  report.push('stable-090-hotfix-v${
      variant + 1
    }')`
    modifiedLines[tuneAround + 1] = `  report.push('stable-091-hotfix-v${
      variant + 1
    }')`
  }

  const insertAfter = modifiedLines.findIndex((line) =>
    line.includes('stable-160'),
  )
  if (insertAfter >= 1) {
    modifiedLines[insertAfter - 1] = `  report.push('stable-159-cache-hit-v${
      variant + 1
    }')`
    modifiedLines[insertAfter] = `  report.push('stable-160-cache-hit-v${
      variant + 1
    }')`
    modifiedLines[insertAfter + 1] = `  report.push('stable-161-cache-miss-v${
      variant + 1
    }')`
  }

  const returnLine = modifiedLines.findIndex(
    (line) => line.trim() === 'return report',
  )
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

function createPierreReferenceScenario(
  version = 0,
  totalLines = referenceLineCount.value,
): DiffPair {
  const variant = version % 3
  const nextVariants = [
    '    try stdout.print("Hello there, {s}!\\\\n", .{"zig"});',
    '    try stdout.print("Greetings, {s}!\\\\n", .{"compiler"});',
    '    try stdout.print("Howdy, {s}!\\\\n", .{"friend"});',
  ]

  if (totalLines <= 6) {
    const originalLines = [
      'const std = @import("std");',
      '',
      'pub fn main() !void {',
      '    const stdout = std.io.getStdOut().writer();',
      '    try stdout.print("Hi you, {s}!\\\\n", .{"world"});',
      '}',
    ]
    return {
      original: originalLines.join('\n'),
      modified: originalLines
        .map((line, index) => (index === 4 ? nextVariants[variant] : line))
        .join('\n'),
    }
  }

  const fillerCount = Math.max(0, totalLines - 6)
  const fillerWidth = String(Math.max(1, fillerCount)).length
  const fillerLines = Array.from({ length: fillerCount }, (_, index) => {
    const id = String(index + 1).padStart(fillerWidth, '0')
    return `    // alignment guard ${id}`
  })
  const originalLines = [
    'const std = @import("std");',
    '',
    'pub fn main() !void {',
    '    const stdout = std.io.getStdOut().writer();',
    ...fillerLines,
    '    try stdout.print("Hi you, {s}!\\\\n", .{"world"});',
    '}',
  ]
  return {
    original: originalLines.join('\n'),
    modified: originalLines
      .map((line, index) =>
        index === originalLines.length - 2 ? nextVariants[variant] : line,
      )
      .join('\n'),
  }
}

function createLineInfoReferenceScenario(version = 0): DiffPair {
  const tailVariants = [
    '  summary.push(`phase:tail-${tasks[0].id}`)',
    "  summary.push(`phase:tail-${tasks.at(-1)?.id ?? 'none'}`)",
    "  summary.push(`phase:tail-${tasks.map(task => task.id).join(',')}`)",
  ]
  const midVariants = [
    'summary.push(`phase:mid-${tasks.length}`)',
    'summary.push(`phase:mid-${tasks.filter(task => task.done).length}`)',
    "summary.push(`phase:mid-${tasks.some(task => task.done) ? 'warm' : 'cold'}`)",
  ]
  const bootVariants = [
    "summary.push('phase:boot-ready')",
    "summary.push('phase:boot-synced')",
    "summary.push('phase:boot-drained')",
  ]

  const variant = version % 3
  const originalLines = [
    'type Task = { id: string; done: boolean }',
    '',
    'export function buildTaskSummary(tasks: Task[]) {',
    '  const summary: string[] = []',
    '  const metadata = new Map<string, string>()',
    "  metadata.set('source', 'line-info')",
    "summary.push('checkpoint-02')",
    "summary.push('checkpoint-03')",
    "summary.push('checkpoint-04')",
    "summary.push('checkpoint-05')",
    "summary.push('phase:boot')",
    "summary.push('checkpoint-07')",
    "summary.push('checkpoint-08')",
    "summary.push('checkpoint-09')",
    "summary.push('checkpoint-10')",
    "summary.push('checkpoint-11')",
    "summary.push('checkpoint-12')",
    "summary.push('checkpoint-13')",
    "summary.push('checkpoint-14')",
    "summary.push('checkpoint-15')",
    "summary.push('checkpoint-16')",
    "summary.push('checkpoint-17')",
    "summary.push('checkpoint-18')",
    "summary.push('checkpoint-19')",
    "summary.push('checkpoint-20')",
    "summary.push('checkpoint-21')",
    "summary.push('checkpoint-22')",
    "summary.push('checkpoint-23')",
    "summary.push('checkpoint-24')",
    "summary.push('checkpoint-25')",
    "summary.push('checkpoint-26')",
    "summary.push('checkpoint-27')",
    "summary.push('checkpoint-28')",
    "summary.push('checkpoint-29')",
    "summary.push('checkpoint-30')",
    "summary.push('checkpoint-31')",
    "summary.push('checkpoint-32')",
    "summary.push('checkpoint-33')",
    "summary.push('phase:mid')",
    "summary.push('checkpoint-35')",
    "summary.push('checkpoint-36')",
    "summary.push('checkpoint-37')",
    "summary.push('checkpoint-38')",
    "summary.push('checkpoint-39')",
    "summary.push('checkpoint-40')",
    "summary.push('checkpoint-41')",
    "summary.push('checkpoint-42')",
    "summary.push('checkpoint-43')",
    "summary.push('checkpoint-44')",
    "summary.push('checkpoint-45')",
    "summary.push('checkpoint-46')",
    "summary.push('checkpoint-47')",
    "summary.push('checkpoint-48')",
    "summary.push('checkpoint-49')",
    "summary.push('checkpoint-50')",
    "summary.push('checkpoint-51')",
    "summary.push('checkpoint-52')",
    "summary.push('checkpoint-53')",
    "summary.push('checkpoint-54')",
    "summary.push('checkpoint-55')",
    "summary.push('checkpoint-56')",
    "summary.push('checkpoint-57')",
    "summary.push('phase:tail')",
    "summary.push('checkpoint-59')",
    "summary.push('checkpoint-60')",
    "summary.push('checkpoint-61')",
    "summary.push('checkpoint-62')",
    "summary.push('checkpoint-63')",
    "summary.push('checkpoint-64')",
    "summary.push('checkpoint-65')",
    "summary.push('checkpoint-66')",
    "summary.push('checkpoint-67')",
    "summary.push('checkpoint-68')",
    "summary.push('checkpoint-69')",
    "summary.push('checkpoint-70')",
    "summary.push('checkpoint-71')",
    "summary.push('checkpoint-72')",
    "summary.push('checkpoint-73')",
    '  return summary',
    '}',
  ]

  const modifiedLines = [...originalLines]
  modifiedLines[10] = bootVariants[variant]
  modifiedLines[38] = midVariants[variant]
  modifiedLines.splice(
    62,
    1,
    'if (tasks.length > 0) {',
    `  ${tailVariants[variant]}`,
    '}',
  )

  return {
    original: originalLines.join('\n'),
    modified: modifiedLines.join('\n'),
  }
}

function currentScenarioMeta(): {
  fileName: string
  caption: string
  language: MonacoLanguage
} {
  if (diffScenario.value === 'pierre-reference') {
    return {
      fileName: 'main.zig',
      caption:
        referenceLineCount.value > 6
          ? `Reference scene aligned to the Pierre-style screenshot (${referenceLineCount.value} lines)`
          : 'Reference scene aligned to the Pierre-style screenshot',
      language: 'zig',
    }
  }

  if (diffScenario.value === 'line-info-reference') {
    return {
      fileName: 'task-summary.ts',
      caption: 'Line Info reference scene for visual parity checks',
      language: 'typescript',
    }
  }

  return {
    fileName: 'packages/runtime/src/synchronizeTasks.ts',
    caption: 'Pierre-inspired diff chrome on top of Monaco + Shiki',
    language: 'typescript',
  }
}

function applyScenarioMeta() {
  const meta = currentScenarioMeta()
  fileName.value = meta.fileName
  fileCaption.value = meta.caption
  return meta
}

function createActiveScenario(version = 0) {
  if (diffScenario.value === 'pierre-reference') {
    return createPierreReferenceScenario(version)
  }
  if (diffScenario.value === 'line-info-reference') {
    return createLineInfoReferenceScenario(version)
  }
  return createStreamingScenario(version)
}

function applyScenarioPresentation() {
  monacoOptions.languages = ['typescript', 'zig']
  monacoOptions.theme = diffTheme.value
  monacoOptions.diffLineStyle = diffLineStyle.value
  monacoOptions.diffAppearance = effectiveDiffAppearance.value
  monacoOptions.renderSideBySide = diffColumnCount.value === 2
  monacoOptions.useInlineViewWhenSpaceIsLimited = false
  monacoOptions.diffAutoScroll = true
  monacoOptions.diffHideUnchangedRegions = isLineInfoScenario.value
    ? lineInfoCollapsedOption
    : collapsedOption
  monacoOptions.diffUnchangedRegionStyle = diffUnchangedRegionStyle.value
  monacoOptions.fontFamily =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
  monacoOptions.lineDecorationsWidth = 12
  monacoOptions.lineNumbersMinChars =
    isReferenceScenario.value || isLineInfoScenario.value ? 2 : 3
  monacoOptions.glyphMargin =
    !isReferenceScenario.value && !isLineInfoScenario.value
  monacoOptions.fontSize = isReferenceScenario.value
    ? 13
    : isLineInfoScenario.value
    ? 13
    : 14
  monacoOptions.lineHeight = isReferenceScenario.value
    ? 30
    : isLineInfoScenario.value
    ? 30
    : 26
  monacoOptions.renderLineHighlight =
    isReferenceScenario.value || isLineInfoScenario.value ? 'none' : 'line'
  monacoOptions.renderLineHighlightOnlyWhenFocus = true
  monacoOptions.renderOverviewRuler =
    !isReferenceScenario.value && !isLineInfoScenario.value
  monacoOptions.scrollBeyondLastLine = false
  monacoOptions.scrollbar =
    isReferenceScenario.value || isLineInfoScenario.value
      ? {
          vertical: 'hidden',
          horizontal: 'hidden',
          verticalScrollbarSize: 0,
          horizontalScrollbarSize: 0,
          handleMouseWheel: false,
          alwaysConsumeMouseWheel: false,
        }
      : {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
          handleMouseWheel: true,
          alwaysConsumeMouseWheel: false,
        }
  const needsExtraBottomSpace =
    diffUnchangedRegionStyle.value === 'line-info' ||
    diffUnchangedRegionStyle.value === 'line-info-basic' ||
    diffUnchangedRegionStyle.value === 'metadata'
  monacoOptions.padding = isReferenceScenario.value
    ? { top: 10, bottom: needsExtraBottomSpace ? 20 : 12 }
    : isLineInfoScenario.value
    ? { top: 10, bottom: needsExtraBottomSpace ? 22 : 14 }
    : { top: 8, bottom: needsExtraBottomSpace ? 20 : 10 }
  monacoOptions.MAX_HEIGHT = isLineInfoScenario.value
    ? 2200
    : isReferenceScenario.value
    ? 560
    : 560
}

const monacoOptions: MonacoOptions = {
  themes: [...darkDiffThemes, ...lightDiffThemes],
  theme: diffTheme.value,
  diffAppearance: initialDiffAppearance,
  languages: ['typescript', 'zig'],
  readOnly: true,
  MAX_HEIGHT: 560,
  wordWrap: 'off',
  maxComputationTime: 0,
  diffAlgorithm: 'legacy',
  renderIndicators: true,
  ignoreTrimWhitespace: false,
  renderSideBySide: initialDiffColumnCount === 2,
  useInlineViewWhenSpaceIsLimited: false,
  diffAutoScroll: true,
  diffHideUnchangedRegions: collapsedOption,
  diffHunkActionsOnHover: true,
  diffLineStyle: diffLineStyle.value,
  diffUnchangedRegionStyle: initialDiffUnchangedRegionStyle,
  onDiffHunkAction: async (ctx) => {
    pushActionLog(formatDiffHunkActionLog(ctx))
    if (diffHunkActionMode === 'custom-patch') {
      await applyCustomPatchFlow(ctx)
      return false
    }
    if (diffHunkActionMode === 'custom-update-diff') {
      await applyCustomUpdateDiffFlow(ctx)
      return false
    }
    return true
  },
}

const {
  createDiffEditor,
  updateDiff,
  cleanupEditor,
  getDiffEditorView,
  getDiffModels,
  getMonacoInstance,
  refreshDiffPresentation,
  setDiffModels,
  setTheme,
} = useMonaco(monacoOptions)

installDemoWorkerBridge()
preloadMonacoWorkers()

function summarizeLineChanges(lineChanges: LineChangeLike[]) {
  let added = 0
  let removed = 0

  for (const change of lineChanges) {
    removed += Math.max(
      0,
      change.originalEndLineNumber - change.originalStartLineNumber + 1,
    )
    added += Math.max(
      0,
      change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1,
    )
  }

  return {
    added,
    removed,
    hunks: lineChanges.length,
  }
}

function computeFallbackSummary() {
  const { original, modified } = getDiffModels()
  if (!original || !modified) return { added: 0, removed: 0, hunks: 0 }
  if (original.getValue() === modified.getValue())
    return { added: 0, removed: 0, hunks: 0 }
  const o = original.getValue().split(/\r?\n/)
  const m = modified.getValue().split(/\r?\n/)
  let added = 0
  let removed = 0
  let hunks = 0
  const max = Math.max(o.length, m.length)
  let inDiff = false
  for (let i = 0; i < max; i++) {
    const left = o[i]
    const right = m[i]
    const changed = (left ?? '') !== (right ?? '')
    if (changed && !inDiff) {
      hunks++
      inDiff = true
    }
    if (!changed && inDiff) inDiff = false

    if (changed) {
      if (typeof left !== 'undefined') removed++
      if (typeof right !== 'undefined') added++
    }
  }
  return { added, removed, hunks }
}

function syncDiffCount() {
  const lineChanges = getDiffEditorView()?.getLineChanges() ?? null
  const hasNative = !!lineChanges
  diffState.value = hasNative ? 'ready' : 'null'
  const summary = hasNative
    ? summarizeLineChanges(lineChanges as LineChangeLike[])
    : computeFallbackSummary()
  diffCount.value = summary.hunks
  addedLines.value = summary.added
  removedLines.value = summary.removed
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

function readActiveDiffValues(): DiffPair {
  const { original, modified } = getDiffModels()
  return {
    original: original?.getValue() ?? '',
    modified: modified?.getValue() ?? '',
  }
}

function stopDiffStreamPlayback() {
  diffStreamTicket += 1
  streamPlaybackActive.value = false
  streamPaused.value = false
  if (diffStreamTimer != null) {
    clearTimeout(diffStreamTimer)
    diffStreamTimer = null
  }
}

function waitForDiffStreamTick(ticket: number, delayMs: number) {
  return new Promise<boolean>((resolve) => {
    if (ticket !== diffStreamTicket) {
      resolve(false)
      return
    }
    diffStreamTimer = window.setTimeout(() => {
      diffStreamTimer = null
      resolve(ticket === diffStreamTicket)
    }, delayMs)
  })
}

function getStreamSpeedConfig() {
  return streamSpeedOptions[streamSpeed.value]
}

function getRandomStreamChunkSize() {
  return Math.floor(Math.random() * 10) + 1
}

async function waitForStreamPlaybackAdvance(ticket: number) {
  while (ticket === diffStreamTicket) {
    if (streamPaused.value) {
      const stillPaused = await waitForDiffStreamTick(ticket, 80)
      if (!stillPaused) return false
      continue
    }

    const delayed = await waitForDiffStreamTick(ticket, getStreamSpeedConfig().delayMs)
    if (!delayed) return false
    if (!streamPaused.value) return true
  }
  return false
}

function createStreamPreviewPair(targetPair: DiffPair): DiffPair {
  const maxLength = Math.max(
    targetPair.original.length,
    targetPair.modified.length,
  )
  if (maxLength <= 1) return targetPair
  const seedLength = Math.min(maxLength, getRandomStreamChunkSize())
  return {
    original: targetPair.original.slice(0, seedLength),
    modified: targetPair.modified.slice(0, seedLength),
  }
}

function readDiffViewportState(): DiffViewportState | null {
  const view = getDiffEditorView()
  if (!view) return null
  const original = view.getOriginalEditor()
  const modified = view.getModifiedEditor()
  return {
    originalTop: original.getScrollTop(),
    originalLeft: original.getScrollLeft(),
    modifiedTop: modified.getScrollTop(),
    modifiedLeft: modified.getScrollLeft(),
  }
}

function restoreDiffViewport(state: DiffViewportState | null) {
  if (!state) return
  const view = getDiffEditorView()
  if (!view) return
  const original = view.getOriginalEditor()
  const modified = view.getModifiedEditor()
  original.setScrollTop(state.originalTop)
  original.setScrollLeft(state.originalLeft)
  modified.setScrollTop(state.modifiedTop)
  modified.setScrollLeft(state.modifiedLeft)
}

function scrollDiffViewportToBottom() {
  const view = getDiffEditorView()
  if (!view) return
  const original = view.getOriginalEditor()
  const modified = view.getModifiedEditor()
  original.setScrollTop(original.getScrollHeight())
  modified.setScrollTop(modified.getScrollHeight())
}

async function playStreamedDiff(targetPair: DiffPair, language: MonacoLanguage) {
  stopDiffStreamPlayback()
  const ticket = diffStreamTicket
  const maxLength = Math.max(
    targetPair.original.length,
    targetPair.modified.length,
  )
  if (maxLength <= 1) {
    updateDiff(targetPair.original, targetPair.modified, language)
    applyCurrentFoldState()
    syncDiffCount()
    startPollDiffCount()
    return
  }

  streamPlaybackActive.value = true
  let length = Math.max(
    readActiveDiffValues().original.length,
    readActiveDiffValues().modified.length,
  )

  while (length < maxLength) {
    if (ticket !== diffStreamTicket) return
    length = Math.min(maxLength, length + getRandomStreamChunkSize())
    updateDiff(
      targetPair.original.slice(0, length),
      targetPair.modified.slice(0, length),
      language,
    )
    syncDiffCount()
    const shouldContinue = await waitForStreamPlaybackAdvance(ticket)
    if (!shouldContinue) return
  }

  if (ticket !== diffStreamTicket) return
  updateDiff(targetPair.original, targetPair.modified, language)
  syncDiffCount()
  const viewState = readDiffViewportState()
  const shouldSettle = await waitForDiffStreamTick(ticket, 180)
  if (!shouldSettle) return
  streamPlaybackActive.value = false
  await remountDiffEditor({
    streamPreview: false,
    viewportMode: 'preserve',
    viewportState: viewState,
  })
}

function applyCurrentFoldState(forceCollapse = false) {
  if (forceCollapse || collapsed.value) collapseUnchanged()
  else expandUnchanged()
}

function showExpandedDuringStream() {
  monacoOptions.diffHideUnchangedRegions = { enabled: false }
  getDiffEditorView()?.updateOptions({
    hideUnchangedRegions: { enabled: false },
  })
}

function renderScenarioPair(
  targetPair: DiffPair,
  language: MonacoLanguage,
  options: { forceCollapse?: boolean } = {},
) {
  stopDiffStreamPlayback()
  const nextPair = streamOutput.value
    ? createStreamPreviewPair(targetPair)
    : targetPair
  updateDiff(nextPair.original, nextPair.modified, language)
  if (streamOutput.value) {
    if (options.forceCollapse) collapsed.value = true
    showExpandedDuringStream()
  }
  else {
    applyCurrentFoldState(options.forceCollapse)
  }
  if (streamOutput.value) scrollDiffViewportToBottom()
  else resetDiffViewport()
  window.setTimeout(() => {
    if (streamOutput.value) scrollDiffViewportToBottom()
    else resetDiffViewport()
  }, 32)
  setTimeout(() => syncDiffCount(), 30)
  startPollDiffCount()
  if (streamOutput.value) void playStreamedDiff(targetPair, language)
}

function bindDiffUpdateEvent() {
  diffUpdatedDisposable?.dispose()
  const view = getDiffEditorView()
  if (!view) return
  diffUpdatedDisposable = view.onDidUpdateDiff(() => {
    syncDiffCount()
  })
}

function resetDiffViewport() {
  const view = getDiffEditorView()
  if (!view) return
  const original = view.getOriginalEditor()
  const modified = view.getModifiedEditor()
  original.setScrollTop(0)
  original.setScrollLeft(0)
  modified.setScrollTop(0)
  modified.setScrollLeft(0)
}

function createStandaloneDiffModels(
  nextPair: DiffPair,
  language: MonacoLanguage,
): DiffTestModelPair {
  const monaco = getMonacoInstance()
  return {
    original: monaco.editor.createModel(nextPair.original, language),
    modified: monaco.editor.createModel(nextPair.modified, language),
  }
}

function disposeDiffModelPair(models: DiffTestModelPair | null) {
  if (!models) return
  const active = getDiffModels()
  if (models.original !== active.original) models.original.dispose()
  if (models.modified !== active.modified) models.modified.dispose()
}

function trackInjectedDiffModels(nextModels: DiffTestModelPair) {
  const previous = injectedDiffModels
  injectedDiffModels = nextModels
  disposeDiffModelPair(previous)
}

async function swapDiffModels(nextPair: DiffPair, preserveViewState?: boolean) {
  const language = currentScenarioMeta().language
  const nextModels = createStandaloneDiffModels(nextPair, language)
  await setDiffModels(nextModels, {
    codeLanguage: language,
    preserveViewState,
  })
  pair = nextPair
  trackInjectedDiffModels(nextModels)
  syncDiffCount()
  startPollDiffCount()
}

function installDiffTestBridge() {
  if (typeof window === 'undefined') return
  window.__streamMonacoDiffTestApi = {
    async swapModelsSameContent() {
      if (!pair) return
      await swapDiffModels(pair)
    },
    async swapModelsChangedContent() {
      scenarioVersion += 1
      const nextPair = createActiveScenario(scenarioVersion)
      await swapDiffModels(nextPair, false)
    },
    async setDiffPair(nextPair, options) {
      actionLogs.value = []
      patchFlowLogs.value = []
      await swapDiffModels(nextPair, options?.preserveViewState ?? false)
      resetDiffViewport()
      window.setTimeout(() => resetDiffViewport(), 32)
    },
    async resetScenario() {
      resetScenario()
      await new Promise((resolve) => window.setTimeout(resolve, 80))
    },
    getDiffValues() {
      return readActiveDiffValues()
    },
    getActionLogs() {
      return [...actionLogs.value]
    },
    getPatchFlowLogs() {
      return [...patchFlowLogs.value]
    },
    getDiffSummary() {
      syncDiffCount()
      return {
        diffCount: diffCount.value,
        diffState: diffState.value,
        addedLines: addedLines.value,
        removedLines: removedLines.value,
      }
    },
    setHunkActionMode(mode) {
      diffHunkActionMode = mode
      actionLogs.value = []
      patchFlowLogs.value = []
    },
    getHunkActionMode() {
      return diffHunkActionMode
    },
    setModifiedScrollTop(top: number) {
      getDiffEditorView()?.getModifiedEditor().setScrollTop(top)
    },
    getModifiedScrollTop() {
      return getDiffEditorView()?.getModifiedEditor().getScrollTop() ?? 0
    },
  }
}

function uninstallDiffTestBridge() {
  if (typeof window === 'undefined') return
  diffHunkActionMode = 'default'
  delete window.__streamMonacoDiffTestApi
}

function syncDemoStateToUrl() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.set('style', diffLineStyle.value)
  url.searchParams.set('appearance', diffAppearance.value)
  url.searchParams.set('scenario', diffScenario.value)
  url.searchParams.set('theme', diffTheme.value)
  url.searchParams.set('lines', String(referenceLineCount.value))
  url.searchParams.set('unchangedStyle', diffUnchangedRegionStyle.value)
  url.searchParams.set('columns', String(diffColumnCount.value))
  url.searchParams.set('streamOutput', streamOutput.value ? '1' : '0')
  url.searchParams.set('streamSpeed', streamSpeed.value)
  window.history.replaceState({}, '', url)
}

async function remountDiffEditor(
  options: {
    streamPreview?: boolean
    viewportMode?: 'top' | 'bottom' | 'preserve'
    viewportState?: DiffViewportState | null
  } = {},
) {
  if (!el.value) return
  if (!pair) pair = createActiveScenario(scenarioVersion)
  const meta = applyScenarioMeta()
  applyScenarioPresentation()
  await setTheme(diffTheme.value)
  stopDiffStreamPlayback()
  cleanupEditor()
  const streamPreview = options.streamPreview ?? streamOutput.value
  const initialPair = streamPreview ? createStreamPreviewPair(pair) : pair
  await createDiffEditor(
    el.value,
    initialPair.original,
    initialPair.modified,
    meta.language,
  )
  if (streamPreview) showExpandedDuringStream()
  else applyCurrentFoldState()
  bindDiffUpdateEvent()
  const viewportMode = options.viewportMode ?? (streamPreview ? 'bottom' : 'top')
  if (viewportMode === 'preserve') restoreDiffViewport(options.viewportState ?? null)
  else if (viewportMode === 'bottom') scrollDiffViewportToBottom()
  else resetDiffViewport()
  window.setTimeout(() => {
    if (viewportMode === 'preserve') restoreDiffViewport(options.viewportState ?? null)
    else if (viewportMode === 'bottom') scrollDiffViewportToBottom()
    else resetDiffViewport()
  }, 32)
  syncDiffCount()
  startPollDiffCount()
  if (streamPreview) void playStreamedDiff(pair, meta.language)
}

function refreshActiveDiffPresentation() {
  applyScenarioPresentation()
  refreshDiffPresentation()
  syncDiffCount()
}

async function setDiffLineStyle(style: DiffLineStyle) {
  if (diffLineStyle.value === style) return
  diffLineStyle.value = style
  syncDemoStateToUrl()
  refreshActiveDiffPresentation()
}

async function setDiffTheme(next: DiffTheme) {
  if (diffTheme.value === next) return
  diffTheme.value = next
  normalizeThemeSelection()
  syncDemoStateToUrl()
  applyScenarioPresentation()
  await setTheme(diffTheme.value)
  refreshDiffPresentation()
}

async function setDiffAppearance(next: DiffAppearance) {
  if (diffAppearance.value === next) return
  diffAppearance.value = next
  normalizeThemeSelection()
  syncDemoStateToUrl()
  applyScenarioPresentation()
  await setTheme(diffTheme.value)
  refreshDiffPresentation()
}

async function setDiffColumnCount(next: DiffColumnCount) {
  if (diffColumnCount.value === next) return
  diffColumnCount.value = next
  syncDemoStateToUrl()
  await remountDiffEditor()
}

async function setDiffScenario(next: DiffScenario) {
  if (diffScenario.value === next) return
  diffScenario.value = next
  normalizeThemeSelection()
  monacoOptions.theme = diffTheme.value
  scenarioVersion = 0
  pair = createActiveScenario(scenarioVersion)
  actionLogs.value = []
  patchFlowLogs.value = []
  syncDemoStateToUrl()
  await remountDiffEditor()
}

async function setStreamOutput(next: boolean) {
  if (streamOutput.value === next) return
  streamOutput.value = next
  syncDemoStateToUrl()
  await remountDiffEditor()
}

function setStreamSpeed(next: StreamSpeed) {
  if (streamSpeed.value === next) return
  streamSpeed.value = next
  syncDemoStateToUrl()
}

function toggleStreamPaused() {
  if (!streamPlaybackActive.value) return
  streamPaused.value = !streamPaused.value
}

async function setDiffUnchangedRegionStyle(next: DiffUnchangedRegionStyle) {
  if (diffUnchangedRegionStyle.value === next) return
  diffUnchangedRegionStyle.value = next
  syncDemoStateToUrl()
  refreshActiveDiffPresentation()
}

async function setReferenceLineCount(next: ReferenceLineCount) {
  if (referenceLineCount.value === next) return
  referenceLineCount.value = next
  scenarioVersion = 0
  pair = createActiveScenario(scenarioVersion)
  syncDemoStateToUrl()
  await remountDiffEditor()
}

function collapseUnchanged() {
  if (streamPlaybackActive.value) {
    collapsed.value = true
    return
  }
  monacoOptions.diffHideUnchangedRegions = isLineInfoScenario.value
    ? lineInfoCollapsedOption
    : collapsedOption
  getDiffEditorView()?.updateOptions({
    hideUnchangedRegions: isLineInfoScenario.value
      ? lineInfoCollapsedOption
      : collapsedOption,
  })
  collapsed.value = true
}

function expandUnchanged() {
  if (streamPlaybackActive.value) {
    collapsed.value = false
    return
  }
  monacoOptions.diffHideUnchangedRegions = { enabled: false }
  getDiffEditorView()?.updateOptions({
    hideUnchangedRegions: { enabled: false },
  })
  collapsed.value = false
}

function resetScenario() {
  scenarioVersion = 0
  pair = createActiveScenario(scenarioVersion)
  const meta = applyScenarioMeta()
  actionLogs.value = []
  patchFlowLogs.value = []
  applyScenarioPresentation()
  renderScenarioPair(pair, meta.language, { forceCollapse: true })
}

function applyScenarioPatch() {
  scenarioVersion += 1
  pair = createActiveScenario(scenarioVersion)
  const meta = applyScenarioMeta()
  applyScenarioPresentation()
  renderScenarioPair(pair, meta.language)
  pushActionLog(`PATCH v${(scenarioVersion % 3) + 1} | keep current fold state`)
}

onMounted(async () => {
  if (!el.value) return

  pair = createActiveScenario(scenarioVersion)
  applyScenarioMeta()
  applyScenarioPresentation()
  monacoOptions.diffLineStyle = diffLineStyle.value
  monacoOptions.theme = diffTheme.value
  monacoOptions.diffAppearance = effectiveDiffAppearance.value
  syncDemoStateToUrl()
  await remountDiffEditor()
  installDiffTestBridge()
})

onBeforeUnmount(() => {
  diffUpdatedDisposable?.dispose()
  diffUpdatedDisposable = null
  stopDiffStreamPlayback()
  if (diffPollTimer != null) {
    clearInterval(diffPollTimer)
    diffPollTimer = null
  }
  uninstallDiffTestBridge()
  cleanupEditor()
  disposeDiffModelPair(injectedDiffModels)
  injectedDiffModels = null
})
</script>

<template>
  <div class="page" :class="`appearance-${effectiveDiffAppearance}`">
    <div class="tips">
      <div>
        1. 这版是按 Pierre 风格重做的 Monaco diff
        皮肤，目标是保留现有技术栈和流式 diff 能力。
      </div>
      <div>
        2. 默认折叠未改动区域，整块摘要条都可直接展开；上下边缘仍支持逐步
        reveal。
      </div>
      <div>
        3. hover 红绿变更块会出现 <code>Revert</code> /
        <code>Stage</code>，便于继续扩成更完整的 patch 流程。
      </div>
    </div>

    <div
      class="line-info-compare-frame"
      :class="{
        active: isLineInfoScenario,
        capture: captureMode,
      }"
    >
      <div v-if="isLineInfoScenario" class="line-info-tabs">
        <button
          class="line-info-tab"
          :class="{ active: diffUnchangedRegionStyle === 'line-info' }"
          type="button"
          @click="setDiffUnchangedRegionStyle('line-info')"
        >
          Line Info
        </button>
        <button
          class="line-info-tab"
          :class="{ active: diffUnchangedRegionStyle === 'line-info-basic' }"
          type="button"
          @click="setDiffUnchangedRegionStyle('line-info-basic')"
        >
          Line Info Basic
        </button>
        <button
          class="line-info-tab"
          :class="{ active: diffUnchangedRegionStyle === 'metadata' }"
          type="button"
          @click="setDiffUnchangedRegionStyle('metadata')"
        >
          Metadata
        </button>
        <button
          class="line-info-tab"
          :class="{ active: diffUnchangedRegionStyle === 'simple' }"
          type="button"
          @click="setDiffUnchangedRegionStyle('simple')"
        >
          Simple
        </button>
        <button class="line-info-tab" type="button">Custom</button>
      </div>

      <div
        class="editor-card"
        :class="[
          `appearance-${effectiveDiffAppearance}`,
          {
            reference: isReferenceScenario,
            'line-info-reference': isLineInfoScenario,
            capture: captureMode,
          },
        ]"
      >
        <div class="filebar">
          <div class="filebar-main">
            <span class="file-icon" aria-hidden="true">
              <span class="file-icon-dot" />
            </span>
            <div class="file-copy">
              <div class="file-name">{{ fileName }}</div>
              <div
                v-if="!captureMode && !isReferenceScenario"
                class="file-caption"
              >
                {{ fileCaption }}
              </div>
            </div>
          </div>

          <div class="file-stats">
            <span class="delta delta-removed">-{{ removedLines }}</span>
            <span class="delta delta-added">+{{ addedLines }}</span>
          </div>
        </div>

        <div v-if="!captureMode" class="toolbar-row">
          <div class="status-group">
            <span class="badge badge-live">
              {{
                diffState === 'ready' ? 'Native diff ready' : 'Fallback summary'
              }}
            </span>
            <span class="badge" :class="{ on: collapsed && !streamPlaybackActive }">
              {{
                streamPlaybackActive
                  ? 'Expanded for stream'
                  : collapsed
                    ? 'Collapsed'
                    : 'Expanded'
              }}
            </span>
            <span class="badge">Layout: {{ diffColumnCount }} col</span>
            <span class="badge" :class="{ on: streamOutput || streamPlaybackActive }">
              {{
                streamPlaybackActive
                  ? streamPaused
                    ? 'Paused'
                    : 'Streaming...'
                  : streamOutput
                    ? 'Streaming on'
                    : 'Static output'
              }}
            </span>
            <span v-if="streamOutput" class="badge">
              Speed: {{ streamSpeedOptions[streamSpeed].label }}
            </span>
            <span class="badge">{{ diffCount }} hunks</span>
            <span class="badge">Style: {{ diffLineStyle }}</span>
            <span class="badge">Appearance: {{ effectiveDiffAppearance }}</span>
            <span class="badge">Theme: {{ themeLabels[diffTheme] }}</span>
            <span v-if="isReferenceScenario" class="badge">
              Lines: {{ referenceLineCount }}
            </span>
          </div>

          <div class="control-group">
            <div class="segmented" aria-label="Diff scenario">
              <button
                :class="{ active: diffScenario === 'streaming' }"
                @click="setDiffScenario('streaming')"
              >
                Streaming
              </button>
              <button
                :class="{ active: diffScenario === 'pierre-reference' }"
                @click="setDiffScenario('pierre-reference')"
              >
                Reference
              </button>
              <button
                :class="{ active: diffScenario === 'line-info-reference' }"
                @click="setDiffScenario('line-info-reference')"
              >
                Line Info
              </button>
            </div>
            <div class="segmented" aria-label="Diff column count">
              <button
                :class="{ active: diffColumnCount === 2 }"
                @click="setDiffColumnCount(2)"
              >
                2 Col
              </button>
              <button
                :class="{ active: diffColumnCount === 1 }"
                @click="setDiffColumnCount(1)"
              >
                1 Col
              </button>
            </div>
            <div class="segmented" aria-label="Diff output mode">
              <button
                :class="{ active: !streamOutput }"
                @click="setStreamOutput(false)"
              >
                Static
              </button>
              <button
                :class="{ active: streamOutput }"
                @click="setStreamOutput(true)"
              >
                Stream
              </button>
            </div>
            <div
              v-if="streamOutput"
              class="segmented"
              aria-label="Stream speed"
            >
              <button
                :class="{ active: streamSpeed === 'slow' }"
                @click="setStreamSpeed('slow')"
              >
                Slow
              </button>
              <button
                :class="{ active: streamSpeed === 'normal' }"
                @click="setStreamSpeed('normal')"
              >
                Normal
              </button>
              <button
                :class="{ active: streamSpeed === 'fast' }"
                @click="setStreamSpeed('fast')"
              >
                Fast
              </button>
            </div>
            <div class="segmented" aria-label="Diff line style">
              <button
                :class="{ active: diffLineStyle === 'background' }"
                @click="setDiffLineStyle('background')"
              >
                Background
              </button>
              <button
                :class="{ active: diffLineStyle === 'bar' }"
                @click="setDiffLineStyle('bar')"
              >
                Bar
              </button>
            </div>
            <div
              v-if="!isLineInfoScenario"
              class="segmented"
              aria-label="Unchanged region style"
            >
              <button
                :class="{ active: diffUnchangedRegionStyle === 'line-info' }"
                @click="setDiffUnchangedRegionStyle('line-info')"
              >
                Line Info
              </button>
              <button
                :class="{
                  active: diffUnchangedRegionStyle === 'line-info-basic',
                }"
                @click="setDiffUnchangedRegionStyle('line-info-basic')"
              >
                Line Info Basic
              </button>
              <button
                :class="{ active: diffUnchangedRegionStyle === 'metadata' }"
                @click="setDiffUnchangedRegionStyle('metadata')"
              >
                Metadata
              </button>
              <button
                :class="{ active: diffUnchangedRegionStyle === 'simple' }"
                @click="setDiffUnchangedRegionStyle('simple')"
              >
                Simple
              </button>
            </div>
            <div class="segmented" aria-label="Diff appearance">
              <button
                :class="{ active: diffAppearance === 'auto' }"
                @click="setDiffAppearance('auto')"
              >
                Auto
              </button>
              <button
                :class="{ active: diffAppearance === 'light' }"
                @click="setDiffAppearance('light')"
              >
                Light
              </button>
              <button
                :class="{ active: diffAppearance === 'dark' }"
                @click="setDiffAppearance('dark')"
              >
                Dark
              </button>
            </div>
            <div class="segmented" aria-label="Diff theme">
              <button
                v-for="themeName in availableDiffThemes"
                :key="themeName"
                :class="{ active: diffTheme === themeName }"
                @click="setDiffTheme(themeName)"
              >
                {{ themeLabels[themeName] }}
              </button>
            </div>
            <div
              v-if="isReferenceScenario"
              class="segmented"
              aria-label="Reference line count"
            >
              <button
                :class="{ active: referenceLineCount === 6 }"
                @click="setReferenceLineCount(6)"
              >
                6
              </button>
              <button
                :class="{ active: referenceLineCount === 48 }"
                @click="setReferenceLineCount(48)"
              >
                48
              </button>
              <button
                :class="{ active: referenceLineCount === 512 }"
                @click="setReferenceLineCount(512)"
              >
                512
              </button>
              <button
                :class="{ active: referenceLineCount === 4096 }"
                @click="setReferenceLineCount(4096)"
              >
                4096
              </button>
            </div>
            <button
              v-if="streamOutput"
              :class="{ active: streamPaused }"
              :disabled="!streamPlaybackActive"
              @click="toggleStreamPaused"
            >
              {{ streamPaused ? 'Resume' : 'Pause' }}
            </button>
            <button :class="{ active: collapsed }" @click="collapseUnchanged">
              Collapse
            </button>
            <button :class="{ active: !collapsed }" @click="expandUnchanged">
              Expand
            </button>
            <button @click="applyScenarioPatch">New Patch</button>
            <button class="secondary" @click="resetScenario">Reset</button>
          </div>
        </div>

        <div class="editor-stage" :class="{ capture: captureMode }">
          <div ref="el" class="editor" :style="editorInlineStyle" />
        </div>
      </div>
    </div>

    <div class="log">
      <div class="log-title">Hunk Action Logs</div>
      <div v-if="actionLogs.length === 0" class="empty">
        还没有操作，hover 后点击按钮试试。
      </div>
      <div
        v-for="(item, i) in actionLogs"
        :key="`${item}-${i}`"
        class="log-item"
      >
        {{ item }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  --demo-ink-strong: #0f172a;
  --demo-ink-muted: #64748b;
  --demo-ink-soft: #435266;
  --demo-card-border: rgb(148 163 184 / 0.18);
  --demo-card-bg: radial-gradient(
      circle at top center,
      rgb(255 255 255 / 0.9),
      transparent 55%
    ),
    linear-gradient(180deg, #fffdfa 0%, #fbfcfe 100%);
  --demo-card-shadow: 0 30px 70px -48px rgb(15 23 42 / 0.42);
  --demo-toolbar-border: rgb(226 232 240 / 0.92);
  --demo-segmented-border: rgb(148 163 184 / 0.16);
  --demo-segmented-bg: rgb(255 255 255 / 0.72);
  --demo-segmented-shadow: inset 0 1px 0 rgb(255 255 255 / 0.75);
  --demo-tab-bg: rgb(241 241 241 / 0.96);
  --demo-tab-shadow: inset 0 1px 0 rgb(255 255 255 / 0.82);
  --demo-tab-ink: rgb(115 115 115);
  --demo-tab-active-bg: #ffffff;
  --demo-tab-active-ink: #111827;
  --demo-tab-active-shadow: inset 0 0 0 1px rgb(15 23 42 / 0.08),
    0 1px 3px rgb(15 23 42 / 0.08);
  --demo-badge-ink: #465468;
  --demo-badge-border: rgb(148 163 184 / 0.16);
  --demo-badge-bg: rgb(248 250 252 / 0.92);
  --demo-badge-on-ink: #0f766e;
  --demo-badge-on-bg: rgb(221 248 240 / 0.92);
  --demo-badge-on-border: rgb(20 184 166 / 0.18);
  --demo-badge-live-ink: #0369a1;
  --demo-badge-live-bg: rgb(224 242 254 / 0.92);
  --demo-badge-live-border: rgb(14 165 233 / 0.18);
  --demo-button-border: rgb(148 163 184 / 0.18);
  --demo-button-bg: rgb(255 255 255 / 0.92);
  --demo-button-ink: #0f172a;
  --demo-button-hover-border: rgb(100 116 139 / 0.32);
  --demo-button-hover-shadow: 0 16px 24px -24px rgb(15 23 42 / 0.35);
  --demo-button-active-border: rgb(14 165 233 / 0.22);
  --demo-button-active-bg: rgb(224 242 254 / 0.9);
  --demo-button-active-ink: #0369a1;
  --demo-button-secondary-ink: #475569;
  --demo-stage-bg: radial-gradient(
      circle at top center,
      rgb(255 255 255 / 0.95),
      transparent 60%
    ),
    linear-gradient(180deg, #fcfdff 0%, #f6f8fb 100%);
  --demo-log-border: rgb(148 163 184 / 0.18);
  --demo-log-bg: linear-gradient(
    180deg,
    rgb(255 255 255 / 0.95) 0%,
    rgb(248 250 252 / 0.95) 100%
  );
  --demo-log-shadow: 0 18px 48px -42px rgb(15 23 42 / 0.36);
  --demo-diff-frame-border: rgb(203 213 225 / 0.56);
  --demo-diff-frame-shadow: 0 16px 40px -32px rgb(15 23 42 / 0.18);
  --demo-diff-panel-bg: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
  --demo-diff-panel-bg-soft: #ffffff;
  --demo-diff-panel-bg-strong: #ffffff;
  --demo-diff-panel-border: rgb(226 232 240 / 0.3);
  --demo-diff-pane-divider: rgb(226 232 240 / 0.42);
  --demo-diff-gutter-bg: transparent;
  --demo-diff-gutter-guide: transparent;
  --demo-diff-line-number: rgb(100 116 139 / 0.56);
  --demo-diff-line-number-active: rgb(100 116 139 / 0.56);
  --demo-diff-added-fg: #14b8a6;
  --demo-diff-removed-fg: #f43f5e;
  --demo-diff-added-line: rgb(219 246 238 / 0.9);
  --demo-diff-removed-line: rgb(254 235 238 / 0.94);
  --demo-diff-added-inline: rgb(187 247 208 / 0.9);
  --demo-diff-removed-inline: rgb(254 205 211 / 0.76);
  --demo-diff-added-inline-border: rgb(20 184 166 / 0.1);
  --demo-diff-removed-inline-border: rgb(244 63 94 / 0.12);
  --demo-diff-added-gutter: linear-gradient(
    90deg,
    #14b8a6 0 var(--stream-monaco-gutter-marker-width),
    rgb(20 184 166 / 0.08) var(--stream-monaco-gutter-marker-width) 100%
  );
  --demo-diff-removed-gutter: repeating-linear-gradient(
        180deg,
        #f43f5e 0 2px,
        transparent 2px 4px
      )
      left / var(--stream-monaco-gutter-marker-width) 100% no-repeat,
    linear-gradient(90deg, rgb(244 63 94 / 0.08) 0 100%);
  --demo-diff-added-line-fill: rgb(220 252 241 / 0.82);
  --demo-diff-removed-line-fill: rgb(255 241 242 / 0.9);
  display: grid;
  gap: 18px;
  min-width: 0;
  padding: 8px 0 18px;
}

.page.appearance-dark {
  --demo-ink-strong: #e2e8f0;
  --demo-ink-muted: #94a3b8;
  --demo-ink-soft: #b6c2d3;
  --demo-card-border: rgb(82 82 91 / 0.56);
  --demo-card-bg: rgb(10 10 11 / 0.99);
  --demo-card-shadow: 0 34px 80px -52px rgb(0 0 0 / 0.72);
  --demo-toolbar-border: rgb(63 63 70 / 0.82);
  --demo-segmented-border: rgb(82 82 91 / 0.42);
  --demo-segmented-bg: rgb(24 24 27 / 0.82);
  --demo-segmented-shadow: inset 0 1px 0 rgb(255 255 255 / 0.04);
  --demo-tab-bg: rgb(24 24 27 / 0.9);
  --demo-tab-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05);
  --demo-tab-ink: rgb(148 163 184 / 0.9);
  --demo-tab-active-bg: rgb(39 39 42 / 0.98);
  --demo-tab-active-ink: #f8fafc;
  --demo-tab-active-shadow: inset 0 0 0 1px rgb(161 161 170 / 0.14),
    0 8px 18px -14px rgb(0 0 0 / 0.72);
  --demo-badge-ink: #cbd5e1;
  --demo-badge-border: rgb(82 82 91 / 0.4);
  --demo-badge-bg: rgb(24 24 27 / 0.92);
  --demo-badge-on-ink: #99f6e4;
  --demo-badge-on-bg: rgb(15 118 110 / 0.2);
  --demo-badge-on-border: rgb(45 212 191 / 0.24);
  --demo-badge-live-ink: #bae6fd;
  --demo-badge-live-bg: rgb(23 37 84 / 0.22);
  --demo-badge-live-border: rgb(96 165 250 / 0.24);
  --demo-button-border: rgb(82 82 91 / 0.44);
  --demo-button-bg: rgb(24 24 27 / 0.94);
  --demo-button-ink: #e2e8f0;
  --demo-button-hover-border: rgb(113 113 122 / 0.56);
  --demo-button-hover-shadow: 0 18px 30px -24px rgb(0 0 0 / 0.7);
  --demo-button-active-border: rgb(34 197 94 / 0.28);
  --demo-button-active-bg: rgb(20 83 45 / 0.28);
  --demo-button-active-ink: #86efac;
  --demo-button-secondary-ink: #cbd5e1;
  --demo-stage-bg: rgb(10 10 11 / 0.99);
  --demo-log-border: rgb(82 82 91 / 0.44);
  --demo-log-bg: linear-gradient(
    180deg,
    rgb(19 19 21 / 0.96) 0%,
    rgb(15 15 17 / 0.96) 100%
  );
  --demo-log-shadow: 0 20px 48px -42px rgb(0 0 0 / 0.78);
  --demo-diff-frame-border: rgb(82 82 91 / 0.56);
  --demo-diff-frame-shadow: 0 18px 40px -30px rgb(0 0 0 / 0.84);
  --demo-diff-panel-bg: rgb(10 10 11 / 0.99);
  --demo-diff-panel-bg-soft: rgb(10 10 11 / 0.99);
  --demo-diff-panel-bg-strong: rgb(10 10 11 / 0.99);
  --demo-diff-panel-border: rgb(82 82 91 / 0.3);
  --demo-diff-pane-divider: rgb(82 82 91 / 0.34);
  --demo-diff-gutter-bg: linear-gradient(
    180deg,
    rgb(13 13 15 / 0.94) 0%,
    rgb(9 9 10 / 0.98) 100%
  );
  --demo-diff-gutter-guide: rgb(161 161 170 / 0.08);
  --demo-diff-line-number: rgb(161 161 170 / 0.58);
  --demo-diff-line-number-active: rgb(228 228 231 / 0.8);
  --demo-diff-added-fg: #5eead4;
  --demo-diff-removed-fg: #fda4af;
  --demo-diff-added-line: rgb(13 148 136 / 0.18);
  --demo-diff-removed-line: rgb(225 29 72 / 0.18);
  --demo-diff-added-inline: rgb(45 212 191 / 0.24);
  --demo-diff-removed-inline: rgb(251 113 133 / 0.24);
  --demo-diff-added-inline-border: rgb(94 234 212 / 0.28);
  --demo-diff-removed-inline-border: rgb(253 164 175 / 0.3);
  --demo-diff-added-gutter: linear-gradient(
    90deg,
    #5eead4 0 var(--stream-monaco-gutter-marker-width),
    rgb(94 234 212 / 0.2) var(--stream-monaco-gutter-marker-width) 100%
  );
  --demo-diff-removed-gutter: repeating-linear-gradient(
        180deg,
        #fda4af 0 2px,
        transparent 2px 4px
      )
      left / var(--stream-monaco-gutter-marker-width) 100% no-repeat,
    linear-gradient(90deg, rgb(253 164 175 / 0.18) 0 100%);
  --demo-diff-added-line-fill: linear-gradient(
    90deg,
    rgb(15 118 110 / 0.38) 0%,
    rgb(13 148 136 / 0.28) 100%
  );
  --demo-diff-removed-line-fill: linear-gradient(
    90deg,
    rgb(159 18 57 / 0.38) 0%,
    rgb(225 29 72 / 0.28) 100%
  );
}

.tips {
  font-size: 13px;
  color: var(--demo-ink-soft);
  display: grid;
  gap: 8px;
  padding: 16px 18px;
  border: 1px solid color-mix(in srgb, var(--demo-card-border) 90%, transparent);
  border-radius: 20px;
  background: var(--demo-card-bg);
  box-shadow: var(--demo-card-shadow);
}

.tips code {
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--demo-button-bg) 78%, transparent);
}

.editor-card {
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--demo-card-border);
  border-radius: 24px;
  overflow: hidden;
  background: var(--demo-card-bg);
  box-shadow: var(--demo-card-shadow);
}

.editor-card.reference {
  border-radius: 22px;
  border-color: rgb(203 213 225 / 0.84);
  background: linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%);
  box-shadow: 0 12px 34px -28px rgb(15 23 42 / 0.16);
}

.editor-card.line-info-reference {
  border-radius: 22px;
  border-color: rgb(215 217 221 / 0.92);
  background: #ffffff;
  box-shadow: 0 8px 28px -24px rgb(15 23 42 / 0.14);
}

.editor-card.reference.appearance-dark {
  border-color: rgb(82 82 91 / 0.72);
  background: linear-gradient(
    180deg,
    rgb(20 20 24 / 0.98) 0%,
    rgb(11 11 13 / 0.99) 100%
  );
  box-shadow: 0 20px 42px -30px rgb(0 0 0 / 0.62);
}

.editor-card.line-info-reference.appearance-dark {
  border-color: rgb(82 82 91 / 0.68);
  background: linear-gradient(
    180deg,
    rgb(18 18 22 / 0.98) 0%,
    rgb(10 10 12 / 0.99) 100%
  );
  box-shadow: 0 18px 38px -28px rgb(0 0 0 / 0.58);
}

.line-info-compare-frame {
  display: grid;
  gap: 18px;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  container-type: inline-size;
}

.line-info-compare-frame.active {
  gap: 28px;
}

.line-info-compare-frame.capture.active {
  width: 1664px;
  max-width: 1664px;
  gap: 28px;
}

.line-info-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
  padding: 3px;
  border-radius: 18px;
  background: var(--demo-tab-bg);
  box-shadow: var(--demo-tab-shadow);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.line-info-tabs::-webkit-scrollbar {
  display: none;
}

.line-info-tab {
  flex: 0 0 auto;
  border: 0;
  border-radius: 15px;
  background: transparent;
  color: var(--demo-tab-ink);
  padding: 14px 22px;
  font-size: 14px;
  font-weight: 600;
  box-shadow: none;
  transform: none;
  white-space: nowrap;
}

.line-info-tab:hover {
  transform: none;
  border-color: transparent;
  box-shadow: none;
}

.line-info-tab.active {
  background: var(--demo-tab-active-bg);
  color: var(--demo-tab-active-ink);
  box-shadow: var(--demo-tab-active-shadow);
}

.filebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  padding: 18px 20px 14px;
}

.editor-card.reference .filebar {
  padding: 18px 22px 10px;
}

.editor-card.line-info-reference .filebar {
  padding: 22px 24px 14px;
}

.filebar-main {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1 1 260px;
  min-width: 0;
}

.editor-card.reference .filebar-main {
  gap: 16px;
}

.editor-card.line-info-reference .filebar-main {
  gap: 16px;
}

.file-icon {
  width: 28px;
  height: 28px;
  border-radius: 10px;
  border: 2px solid #0ea5e9;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.editor-card.reference .file-icon {
  width: 32px;
  height: 32px;
  border-radius: 11px;
}

.editor-card.line-info-reference .file-icon {
  width: 30px;
  height: 30px;
  border-radius: 10px;
}

.page.appearance-dark .file-icon {
  border-color: rgb(56 189 248 / 0.9);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.08),
    0 12px 28px -20px rgb(56 189 248 / 0.45);
}

.file-icon-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #0ea5e9;
}

.page.appearance-dark .file-icon-dot {
  background: #38bdf8;
  box-shadow: 0 0 0 2px rgb(56 189 248 / 0.18);
}

.editor-card.reference .file-icon-dot {
  width: 9px;
  height: 9px;
}

.file-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.file-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--demo-ink-strong);
  letter-spacing: 0.01em;
}

.page.appearance-dark .file-name {
  color: #f8fafc;
}

.editor-card.reference .file-name {
  font-size: 15px;
  font-weight: 650;
}

.editor-card.line-info-reference .file-name {
  font-size: 16px;
  font-weight: 600;
}

.file-caption {
  font-size: 12px;
  color: var(--demo-ink-muted);
}

.page.appearance-dark .file-caption {
  color: #b6c2d3;
}

.file-stats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex: 0 0 auto;
  margin-left: auto;
}

.page.appearance-dark .file-stats {
  color: #dbe7f5;
}

.editor-card.reference .file-stats {
  gap: 8px;
  font-size: 13px;
}

.editor-card.line-info-reference .file-stats {
  gap: 8px;
  font-size: 13px;
}

.delta {
  display: inline-flex;
  align-items: center;
}

.page.appearance-dark .delta {
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid transparent;
  line-height: 1;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05);
}

.delta-removed {
  color: #ef4444;
}

.delta-added {
  color: #14b8a6;
}

.page.appearance-dark .delta-removed {
  color: #fb7185;
  background: rgb(159 18 57 / 0.16);
  border-color: rgb(251 113 133 / 0.2);
}

.page.appearance-dark .delta-added {
  color: #2dd4bf;
  background: rgb(15 118 110 / 0.16);
  border-color: rgb(45 212 191 / 0.22);
}

.toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 20px 16px;
  border-bottom: 1px solid var(--demo-toolbar-border);
}

.status-group,
.control-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.segmented {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border-radius: 999px;
  border: 1px solid var(--demo-segmented-border);
  background: var(--demo-segmented-bg);
  box-shadow: var(--demo-segmented-shadow);
}

.segmented button {
  box-shadow: none;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: var(--demo-badge-ink);
  border: 1px solid var(--demo-badge-border);
  background: var(--demo-badge-bg);
}

.badge.on {
  color: var(--demo-badge-on-ink);
  background: var(--demo-badge-on-bg);
  border-color: var(--demo-badge-on-border);
}

.badge-live {
  color: var(--demo-badge-live-ink);
  background: var(--demo-badge-live-bg);
  border-color: var(--demo-badge-live-border);
}

.editor-stage {
  min-width: 0;
  padding: 14px 16px 18px;
  background: var(--demo-stage-bg);
}

.editor-stage.capture {
  padding-top: 12px;
}

.editor-card.reference .editor-stage {
  padding: 2px 2px 10px;
  background: linear-gradient(180deg, #ffffff 0%, #fafbfd 100%);
}

.editor-card.reference.appearance-dark .editor-stage {
  background: linear-gradient(
    180deg,
    rgb(20 20 24 / 0.98) 0%,
    rgb(11 11 13 / 0.99) 100%
  );
}

.editor-card.reference.capture .editor-stage {
  padding: 0 0 8px;
}

.editor-card.line-info-reference .editor-stage {
  padding: 4px 4px 8px;
  background: #ffffff;
}

.editor-card.line-info-reference.appearance-dark .editor-stage {
  background: linear-gradient(
    180deg,
    rgb(18 18 22 / 0.98) 0%,
    rgb(10 10 12 / 0.99) 100%
  );
}

.editor-card.line-info-reference.capture .editor-stage {
  padding: 4px 4px 8px;
}

.editor {
  --stream-monaco-frame-radius: 18px;
  --stream-monaco-fixed-editor-bg: var(--demo-diff-panel-bg-strong);
  --stream-monaco-frame-border: var(--demo-diff-frame-border);
  --stream-monaco-frame-shadow: var(--demo-diff-frame-shadow);
  --stream-monaco-panel-bg: var(--demo-diff-panel-bg);
  --stream-monaco-panel-bg-soft: var(--demo-diff-panel-bg-soft);
  --stream-monaco-panel-bg-strong: var(--demo-diff-panel-bg-strong);
  --stream-monaco-panel-border: var(--demo-diff-panel-border);
  --stream-monaco-pane-divider: var(--demo-diff-pane-divider);
  --stream-monaco-gutter-bg: var(--demo-diff-gutter-bg);
  --stream-monaco-gutter-guide: var(--demo-diff-gutter-guide);
  --stream-monaco-gutter-marker-width: 4px;
  --stream-monaco-gutter-gap: 16px;
  --stream-monaco-line-number: var(--demo-diff-line-number);
  --stream-monaco-line-number-active: var(--demo-diff-line-number-active);
  --stream-monaco-line-number-left: calc(
    var(--stream-monaco-gutter-marker-width) + var(--stream-monaco-gutter-gap)
  );
  --stream-monaco-line-number-width: 36px;
  --stream-monaco-line-number-align: center;
  --stream-monaco-original-margin-width: calc(
    var(--stream-monaco-gutter-marker-width) +
      (var(--stream-monaco-gutter-gap) * 2) +
      var(--stream-monaco-line-number-width)
  );
  --stream-monaco-original-scrollable-left: var(
    --stream-monaco-original-margin-width
  );
  --stream-monaco-original-scrollable-width: calc(
    100% - var(--stream-monaco-original-margin-width)
  );
  --stream-monaco-modified-margin-width: calc(
    var(--stream-monaco-gutter-marker-width) +
      (var(--stream-monaco-gutter-gap) * 2) +
      var(--stream-monaco-line-number-width)
  );
  --stream-monaco-modified-scrollable-left: var(
    --stream-monaco-modified-margin-width
  );
  --stream-monaco-modified-scrollable-width: calc(
    100% - var(--stream-monaco-modified-margin-width)
  );
  --stream-monaco-added-fg: var(--demo-diff-added-fg);
  --stream-monaco-removed-fg: var(--demo-diff-removed-fg);
  --stream-monaco-added-line: var(--demo-diff-added-line);
  --stream-monaco-removed-line: var(--demo-diff-removed-line);
  --stream-monaco-added-inline: var(--demo-diff-added-inline);
  --stream-monaco-removed-inline: var(--demo-diff-removed-inline);
  --stream-monaco-added-outline: transparent;
  --stream-monaco-removed-outline: transparent;
  --stream-monaco-added-inline-border: var(--demo-diff-added-inline-border);
  --stream-monaco-removed-inline-border: var(--demo-diff-removed-inline-border);
  --stream-monaco-added-line-shadow: none;
  --stream-monaco-removed-line-shadow: none;
  --stream-monaco-added-gutter: var(--demo-diff-added-gutter);
  --stream-monaco-removed-gutter: var(--demo-diff-removed-gutter);
  --stream-monaco-added-line-fill: var(--demo-diff-added-line-fill);
  --stream-monaco-removed-line-fill: var(--demo-diff-removed-line-fill);
}

.editor-card.reference .editor {
  --stream-monaco-frame-radius: 16px;
  --stream-monaco-frame-border: transparent;
  --stream-monaco-frame-shadow: none;
  --stream-monaco-panel-bg: #ffffff;
  --stream-monaco-panel-bg-soft: #ffffff;
  --stream-monaco-panel-bg-strong: #ffffff;
  --stream-monaco-panel-border: rgb(226 232 240 / 0.3);
  --stream-monaco-pane-divider: rgb(226 232 240 / 0.42);
  --stream-monaco-gutter-bg: transparent;
  --stream-monaco-gutter-guide: transparent;
  --stream-monaco-line-number: rgb(100 116 139 / 0.56);
  --stream-monaco-line-number-active: rgb(100 116 139 / 0.56);
  --stream-monaco-gutter-gap: 16px;
  --stream-monaco-line-number-left: calc(
    var(--stream-monaco-gutter-marker-width) + var(--stream-monaco-gutter-gap)
  );
  --stream-monaco-line-number-width: 36px;
  --stream-monaco-line-number-align: center;
  --stream-monaco-modified-margin-width: calc(
    var(--stream-monaco-gutter-marker-width) +
      (var(--stream-monaco-gutter-gap) * 2) +
      var(--stream-monaco-line-number-width)
  );
  --stream-monaco-added-fg: #14b8a6;
  --stream-monaco-removed-fg: #f43f5e;
  --stream-monaco-added-line: rgb(219 246 238 / 0.9);
  --stream-monaco-removed-line: rgb(254 235 238 / 0.94);
  --stream-monaco-added-inline: rgb(187 247 208 / 0.9);
  --stream-monaco-removed-inline: rgb(254 205 211 / 0.76);
  --stream-monaco-added-outline: transparent;
  --stream-monaco-removed-outline: transparent;
  --stream-monaco-added-inline-border: rgb(20 184 166 / 0.1);
  --stream-monaco-removed-inline-border: rgb(244 63 94 / 0.12);
  --stream-monaco-added-line-shadow: none;
  --stream-monaco-removed-line-shadow: none;
  --stream-monaco-added-gutter: linear-gradient(
    90deg,
    var(--stream-monaco-added-fg) 0 var(--stream-monaco-gutter-marker-width),
    rgb(20 184 166 / 0.08) var(--stream-monaco-gutter-marker-width) 100%
  );
  --stream-monaco-removed-gutter: repeating-linear-gradient(
        180deg,
        var(--stream-monaco-removed-fg) 0 2px,
        transparent 2px 4px
      )
      left / var(--stream-monaco-gutter-marker-width) 100% no-repeat,
    linear-gradient(90deg, rgb(244 63 94 / 0.08) 0 100%);
  --stream-monaco-added-line-fill: rgb(220 252 241 / 0.82);
  --stream-monaco-removed-line-fill: rgb(255 241 242 / 0.9);
}

.editor-card.line-info-reference .editor {
  --stream-monaco-frame-radius: 18px;
  --stream-monaco-frame-border: transparent;
  --stream-monaco-frame-shadow: none;
  --stream-monaco-panel-bg: #ffffff;
  --stream-monaco-panel-bg-soft: #ffffff;
  --stream-monaco-panel-bg-strong: #ffffff;
  --stream-monaco-panel-border: rgb(229 231 235 / 0.82);
  --stream-monaco-pane-divider: rgb(229 231 235 / 0.92);
  --stream-monaco-gutter-bg: transparent;
  --stream-monaco-gutter-guide: transparent;
  --stream-monaco-gutter-gap: 18px;
  --stream-monaco-line-number: rgb(82 82 82 / 0.88);
  --stream-monaco-line-number-active: rgb(82 82 82 / 0.88);
  --stream-monaco-added-fg: #14b8a6;
  --stream-monaco-removed-fg: #ff3658;
  --stream-monaco-added-line: rgb(232 249 245 / 0.98);
  --stream-monaco-removed-line: rgb(255 241 241 / 0.98);
  --stream-monaco-added-inline: rgb(197 245 219 / 0.96);
  --stream-monaco-removed-inline: rgb(255 215 217 / 0.92);
  --stream-monaco-added-outline: transparent;
  --stream-monaco-removed-outline: transparent;
  --stream-monaco-added-inline-border: transparent;
  --stream-monaco-removed-inline-border: transparent;
  --stream-monaco-added-line-shadow: none;
  --stream-monaco-removed-line-shadow: none;
  --stream-monaco-added-gutter: linear-gradient(
    90deg,
    var(--stream-monaco-added-fg) 0 var(--stream-monaco-gutter-marker-width),
    rgb(20 184 166 / 0.08) var(--stream-monaco-gutter-marker-width) 100%
  );
  --stream-monaco-removed-gutter: repeating-linear-gradient(
        180deg,
        var(--stream-monaco-removed-fg) 0 2px,
        transparent 2px 4px
      )
      left / var(--stream-monaco-gutter-marker-width) 100% no-repeat,
    linear-gradient(90deg, rgb(255 54 88 / 0.08) 0 100%);
  --stream-monaco-added-line-fill: rgb(231 248 244 / 0.96);
  --stream-monaco-removed-line-fill: rgb(255 241 241 / 0.98);
}

.editor-card.reference.appearance-dark .editor {
  --stream-monaco-frame-border: transparent;
  --stream-monaco-frame-shadow: none;
  --stream-monaco-panel-bg: rgb(12 12 14 / 0.99);
  --stream-monaco-panel-bg-soft: rgb(12 12 14 / 0.99);
  --stream-monaco-panel-bg-strong: rgb(12 12 14 / 0.99);
  --stream-monaco-panel-border: rgb(82 82 91 / 0.32);
  --stream-monaco-pane-divider: rgb(82 82 91 / 0.42);
  --stream-monaco-gutter-bg: transparent;
  --stream-monaco-gutter-guide: transparent;
  --stream-monaco-line-number: rgb(161 161 170 / 0.58);
  --stream-monaco-line-number-active: rgb(228 228 231 / 0.82);
  --stream-monaco-added-fg: #5eead4;
  --stream-monaco-removed-fg: #fda4af;
  --stream-monaco-added-line: rgb(13 148 136 / 0.18);
  --stream-monaco-removed-line: rgb(225 29 72 / 0.18);
  --stream-monaco-added-inline: rgb(45 212 191 / 0.24);
  --stream-monaco-removed-inline: rgb(251 113 133 / 0.24);
  --stream-monaco-added-inline-border: rgb(94 234 212 / 0.28);
  --stream-monaco-removed-inline-border: rgb(253 164 175 / 0.3);
  --stream-monaco-added-gutter: linear-gradient(
    90deg,
    var(--stream-monaco-added-fg) 0 var(--stream-monaco-gutter-marker-width),
    rgb(94 234 212 / 0.2) var(--stream-monaco-gutter-marker-width) 100%
  );
  --stream-monaco-removed-gutter: repeating-linear-gradient(
        180deg,
        var(--stream-monaco-removed-fg) 0 2px,
        transparent 2px 4px
      )
      left / var(--stream-monaco-gutter-marker-width) 100% no-repeat,
    linear-gradient(90deg, rgb(253 164 175 / 0.18) 0 100%);
  --stream-monaco-added-line-fill: linear-gradient(
    90deg,
    rgb(15 118 110 / 0.38) 0%,
    rgb(13 148 136 / 0.28) 100%
  );
  --stream-monaco-removed-line-fill: linear-gradient(
    90deg,
    rgb(159 18 57 / 0.38) 0%,
    rgb(225 29 72 / 0.28) 100%
  );
}

.editor-card.line-info-reference.appearance-dark .editor {
  --stream-monaco-frame-border: transparent;
  --stream-monaco-frame-shadow: none;
  --stream-monaco-panel-bg: rgb(12 12 14 / 0.99);
  --stream-monaco-panel-bg-soft: rgb(12 12 14 / 0.99);
  --stream-monaco-panel-bg-strong: rgb(12 12 14 / 0.99);
  --stream-monaco-panel-border: rgb(82 82 91 / 0.32);
  --stream-monaco-pane-divider: rgb(82 82 91 / 0.42);
  --stream-monaco-gutter-bg: transparent;
  --stream-monaco-gutter-guide: transparent;
  --stream-monaco-line-number: rgb(161 161 170 / 0.68);
  --stream-monaco-line-number-active: rgb(228 228 231 / 0.82);
  --stream-monaco-added-fg: #5eead4;
  --stream-monaco-removed-fg: #fda4af;
  --stream-monaco-added-line: rgb(13 148 136 / 0.18);
  --stream-monaco-removed-line: rgb(225 29 72 / 0.18);
  --stream-monaco-added-inline: rgb(45 212 191 / 0.24);
  --stream-monaco-removed-inline: rgb(251 113 133 / 0.24);
  --stream-monaco-added-inline-border: transparent;
  --stream-monaco-removed-inline-border: transparent;
  --stream-monaco-added-gutter: linear-gradient(
    90deg,
    var(--stream-monaco-added-fg) 0 var(--stream-monaco-gutter-marker-width),
    rgb(94 234 212 / 0.2) var(--stream-monaco-gutter-marker-width) 100%
  );
  --stream-monaco-removed-gutter: repeating-linear-gradient(
        180deg,
        var(--stream-monaco-removed-fg) 0 2px,
        transparent 2px 4px
      )
      left / var(--stream-monaco-gutter-marker-width) 100% no-repeat,
    linear-gradient(90deg, rgb(253 164 175 / 0.18) 0 100%);
  --stream-monaco-added-line-fill: linear-gradient(
    90deg,
    rgb(15 118 110 / 0.38) 0%,
    rgb(13 148 136 / 0.28) 100%
  );
  --stream-monaco-removed-line-fill: linear-gradient(
    90deg,
    rgb(159 18 57 / 0.38) 0%,
    rgb(225 29 72 / 0.28) 100%
  );
}

button {
  appearance: none;
  border: 1px solid var(--demo-button-border);
  border-radius: 999px;
  background: var(--demo-button-bg);
  color: var(--demo-button-ink);
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.01em;
  transition: background-color 0.16s ease, border-color 0.16s ease,
    color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease;
}

button:hover {
  transform: translateY(-1px);
  border-color: var(--demo-button-hover-border);
  box-shadow: var(--demo-button-hover-shadow);
}

button.active {
  border-color: var(--demo-button-active-border);
  background: var(--demo-button-active-bg);
  color: var(--demo-button-active-ink);
}

button.secondary {
  border-color: var(--demo-segmented-border);
  color: var(--demo-button-secondary-ink);
}

.log {
  border: 1px solid var(--demo-log-border);
  border-radius: 20px;
  padding: 14px 16px;
  background: var(--demo-log-bg);
  box-shadow: var(--demo-log-shadow);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.log-title {
  font-weight: 700;
  margin-bottom: 10px;
  color: var(--demo-ink-strong);
}

.log-item {
  padding: 5px 0;
  color: var(--demo-ink-strong);
}

.empty {
  color: var(--demo-ink-muted);
}

@container (max-width: 860px) {
  .line-info-tabs {
    width: 100%;
  }

  .editor-card.line-info-reference .filebar {
    padding: 20px 20px 14px;
  }
}

@container (max-width: 620px) {
  .line-info-tab {
    padding: 12px 18px;
    font-size: 13px;
  }

  .editor-card.line-info-reference .filebar {
    gap: 12px;
    padding: 18px 18px 12px;
  }

  .editor-card.line-info-reference .filebar-main {
    gap: 12px;
    flex-basis: 100%;
  }

  .editor-card.line-info-reference .file-stats {
    gap: 12px;
    margin-left: 46px;
    font-size: 15px;
  }

  .editor-card.line-info-reference .editor-stage,
  .editor-card.line-info-reference.capture .editor-stage {
    padding: 4px 2px 8px;
  }
}

@container (max-width: 480px) {
  .line-info-compare-frame.active {
    gap: 22px;
  }

  .line-info-tab {
    padding: 12px 16px;
  }

  .editor-card.line-info-reference .filebar {
    padding: 16px 16px 12px;
  }

  .editor-card.line-info-reference .file-icon {
    width: 28px;
    height: 28px;
  }

  .editor-card.line-info-reference .file-name {
    font-size: 15px;
  }

  .editor-card.line-info-reference .file-stats {
    display: flex;
    flex: 1 0 100%;
    width: 100%;
    box-sizing: border-box;
    justify-content: flex-end;
    margin-left: 0;
    padding-left: 0;
  }
}
</style>
