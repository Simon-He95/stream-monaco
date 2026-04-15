# stream-monaco

[![NPM version](https://img.shields.io/npm/v/stream-monaco?color=a1b858&label=)](https://www.npmjs.com/package/stream-monaco)
[![English Docs](https://img.shields.io/badge/docs-English-blue)](README.md)
[![NPM downloads](https://img.shields.io/npm/dm/stream-monaco)](https://www.npmjs.com/package/stream-monaco)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/stream-monaco)](https://bundlephobia.com/package/stream-monaco)
[![License](https://img.shields.io/npm/l/stream-monaco)](./LICENSE)

流式更新版 Monaco Editor + Shiki 语法高亮，提供框架无关内核，适配 Vue、React、Svelte、Solid、Preact 与 Vanilla JS。

### 项目简介

`stream-monaco` 提供一个与框架无关的内核来集成 Monaco 编辑器与 Shiki 语法高亮，针对流式更新与高效高亮做了优化；可在无 Vue 的环境下使用，同时也提供对 Vue 3 的友好支持与示例。

IMPORTANT: Since v0.0.32 the library enables a default time-based throttle for `updateCode` (`updateThrottleMs = 50`) to reduce CPU usage under high-frequency streaming. Set `updateThrottleMs: 0` in `useMonaco()` options to restore previous behavior (only RAF-based coalescing).

### 特性

- 🚀 **无需 Vue 也可使用** - 核心与框架无关
- 🌿 **与 Vue 3 组合式 API 兼容** - 提供示例与最佳实践
- 🔁 **可用于任意框架**：Vue、React、Svelte、Solid、Preact，或纯 JS/TS

说明：内部响应式基于 `alien-signals` 的轻薄适配层实现，因此核心逻辑不再强依赖 Vue。Vue 仍然完全支持，但被标记为可选的 peer 依赖，使库在非 Vue 环境也可复用核心能力，且对现有 API 无破坏。

- 🎨 **Shiki 高亮** - 使用 Shiki 实现高效的语法高亮，支持 TextMate 语法和 VS Code 主题
- 📝 **流式更新** - 支持流式输入更新，实时响应代码变化

- `registerMonacoThemes(themes, languages): Promise<Highlighter>` — 使用 shiki 创建或获取高亮器并把主题注册到 Monaco，返回解析为 shiki highlighter 的 Promise，便于复用（例如渲染页面片段）。
  `getOrCreateHighlighter(themes, languages): Promise<Highlighter>` — 直接获取或创建一个 highlighter（并受内部缓存管理）。如需直接控制 shiki highlighter（例如调用 `codeToHtml` 或 `setTheme`），请使用此方法并自行处理加载/错误逻辑。

注意：如果你只使用 Monaco 编辑器并在 `createEditor` 时传入了全量 `themes`，通常只需调用 `monaco.editor.setTheme(themeName)` 即可。

补充：如果你要切换到一个**不在初始 `themes` 列表里的主题**（例如运行时才决定的 `andromeeda`），建议使用 `useMonaco()` 返回的 `await setTheme(themeName)`，而不是直接调用 `monaco.editor.setTheme(themeName)`。

`setTheme()` 会确保主题被注册；并且在可能的情况下，会对底层 Shiki highlighter 进行一次 `loadTheme(themeName)` 的兜底，避免出现 `Theme ... not found, you may need to load it first` 这类“主题未加载”的错误。

配置：`useMonaco()` 不会自动同步 Shiki highlighter；如果你需要在切换主题时同步页面中独立的 Shiki 渲染，请手动使用 `getOrCreateHighlighter(...)` 并调用高亮器实例的 `setTheme`。

### 安装

使用 pnpm 安装：

```bash
pnpm add stream-monaco
```

使用 npm 安装：

```bash
npm install stream-monaco
```

使用 yarn 安装：

```bash
yarn add stream-monaco
```

### 示例工程

- `examples/streaming-demo`：Vue 3 + Vite 示例，包含 streaming、diff、diff UX 路由
- `examples/react-demo`：React + Vite 示例，演示不重建编辑器的主题/语言切换与 `appendCode()` 流式追加

快速启动：

```bash
pnpm -C examples/streaming-demo dev
pnpm -C examples/react-demo dev
```

### 基础使用（Vue）

#### 简单示例

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useMonaco } from 'stream-monaco'

const props = defineProps<{
  code: string
  language: string
}>()

const codeEditor = ref<HTMLElement>()

const { createEditor, updateCode, cleanupEditor } = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['javascript', 'typescript', 'vue', 'python'],
  readOnly: false,
  MAX_HEIGHT: 600,
})

// 创建编辑器实例
onMounted(async () => {
  if (codeEditor.value) {
    await createEditor(codeEditor.value, props.code, props.language)
  }
})

// 监听代码和语言变化
watch(
  () => [props.code, props.language],
  ([newCode, newLanguage]) => {
    updateCode(newCode, newLanguage)
  },
)
</script>

<template>
  <div ref="codeEditor" class="monaco-editor-container" />
</template>

<style scoped>
.monaco-editor-container {
  border: 1px solid #e0e0e0;
  border-radius: 4px;
}
</style>
```

#### 完整配置示例

```vue
<script setup lang="ts">
import type { MonacoLanguage, MonacoTheme } from 'stream-monaco'
import { onMounted, ref } from 'vue'
import { useMonaco } from 'stream-monaco'

const editorContainer = ref<HTMLElement>()

const {
  createEditor,
  updateCode,
  setTheme,
  setLanguage,
  getCurrentTheme,
  getEditor,
  getEditorView,
  getCode,
  cleanupEditor,
} = useMonaco({
  // 主题配置 - 至少需要两个主题（暗色/亮色）
  themes: ['github-dark', 'github-light'],

  // 支持的语言列表
  languages: ['javascript', 'typescript', 'python', 'vue', 'json'],

  // 编辑器最大高度
  MAX_HEIGHT: 500,

  // 是否只读
  readOnly: false,

  // 是否在创建前清理之前的资源
  isCleanOnBeforeCreate: true,

  // 创建前的钩子函数
  onBeforeCreate: (monaco) => {
    // 可以在这里注册自定义语言、主题等
    console.log('Monaco editor is about to be created', monaco)
    return [] // 返回需要清理的 disposable 对象数组
  },

  // Monaco 编辑器原生配置
  fontSize: 14,
  lineNumbers: 'on',
  wordWrap: 'on',
  minimap: { enabled: false },
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    alwaysConsumeMouseWheel: false,
  },
  // 当使用流式追加（append）或频繁更新时，可通过 revealDebounceMs 合并多次自动滚动请求
  // 默认值：75（毫秒）。设置为 0 可关闭合并逻辑（立即 reveal）。增大到 150+ 可进一步减少滚动频率。
  revealDebounceMs: 75,
})

onMounted(async () => {
  if (editorContainer.value) {
    const editor = await createEditor(
      editorContainer.value,
      'console.log("Hello, Monaco!")',
      'javascript',
    )

    console.log('Editor created:', editor)
  }
})

// 主题切换
// 主题切换（示例：异步等待与强制重应用）
// setTheme 返回一个 Promise，resolve 表示主题已经应用到 Monaco（并在可能的情况下同步到 shiki highlighter）
// 如果希望即便当前主题相同也强制重新应用（例如强制重新渲染页面中的 shiki 片段），传入第二个参数 true
async function switchTheme(theme: MonacoTheme) {
  // 普通调用（自动跳过与当前相同的主题）
  await setTheme(theme)

  // 强制应用示例：
  // await setTheme(theme, true)
}

// 语言切换
function switchLanguage(language: MonacoLanguage) {
  setLanguage(language)
}

// 更新代码
function updateEditorCode(code: string, language: string) {
  updateCode(code, language)
}

// 获取当前主题
const currentTheme = getCurrentTheme()
console.log('Current theme:', currentTheme)

// 获取 Monaco 静态 API
const monacoEditor = getEditor()
console.log('Monaco editor API:', monacoEditor)

// 获取编辑器实例
const editorInstance = getEditorView()
console.log('Editor instance:', editorInstance)

// 获取编辑器当前代码（在用户手动编辑后非常有用）
function getCurrentCode() {
  const code = getCode()
  if (code) {
    console.log('当前代码:', code)
    return code
  }
  return null
}
</script>

<template>
  <div>
    <div class="controls">
      <button @click="switchTheme('github-dark')">暗色主题</button>
      <button @click="switchTheme('github-light')">亮色主题</button>
      <button @click="switchLanguage('typescript')">TypeScript</button>
      <button @click="switchLanguage('python')">Python</button>
    </div>
    <div ref="editorContainer" class="editor" />
  </div>
</template>
```

### 在非 Vue 环境使用（Vanilla）

无需安装 Vue，直接在任意 TS/JS 环境中使用：

```ts
import { useMonaco } from 'stream-monaco'

const container = document.getElementById('editor')!

const { createEditor, updateCode, setTheme, cleanupEditor } = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['javascript', 'typescript'],
  MAX_HEIGHT: 500,
})

await createEditor(container, 'console.log("Hello")', 'javascript')
updateCode('console.log("World")', 'javascript')
await setTheme('vitesse-light')

cleanupEditor()
```

```html
<div id="editor" style="height: 500px; border: 1px solid #e5e7eb;"></div>
<script type="module" src="/main.ts"></script>
```

### React 基础用法

```tsx
import { useEffect, useRef } from 'react'
import { useMonaco } from 'stream-monaco'

export function MonacoEditor() {
  const containerRef = useRef<HTMLDivElement>(null)
  const { createEditor, cleanupEditor } = useMonaco({
    themes: ['vitesse-dark', 'vitesse-light'],
    languages: ['typescript', 'javascript'],
  })

  useEffect(() => {
    if (containerRef.current) {
      createEditor(
        containerRef.current,
        'console.log("Hello, Monaco!")',
        'typescript',
      )
    }
    return () => cleanupEditor()
  }, [])

  return (
    <div
      ref={containerRef}
      style={{ height: 500, border: '1px solid #e0e0e0' }}
    />
  )
}
```

说明：Svelte/Solid/Preact 的集成方式与 React 类似——在挂载时创建编辑器实例，卸载时清理即可。

### 获取当前代码（getCode）

创建编辑器后，您可以随时使用 `getCode()` 获取当前的代码内容。这在用户手动编辑编辑器内容时特别有用：

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco } from 'stream-monaco'

const container = ref<HTMLElement>()

const { createEditor, updateCode, getCode, cleanupEditor } = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['javascript', 'typescript'],
})

onMounted(async () => {
  if (container.value) {
    await createEditor(container.value, 'console.log("hello")', 'javascript')
  }
})

// 在更新或用户编辑后获取当前代码
function handleSubmit() {
  const currentCode = getCode()
  if (currentCode) {
    console.log('提交代码:', currentCode)
    // 发送到 API、保存到存储等
  }
}

// 程序化更新代码
function replaceCode() {
  updateCode('console.log("world")', 'javascript')

  // 获取新代码
  setTimeout(() => {
    const newCode = getCode()
    console.log('更新后的代码:', newCode)
  }, 100)
}
</script>

<template>
  <div>
    <div ref="container" class="editor" />
    <button @click="handleSubmit">提交代码</button>
    <button @click="replaceCode">替换代码</button>
  </div>
</template>
```

对于 Diff 编辑器，`getCode()` 返回两侧的代码：

```ts
const { createDiffEditor, getCode } = useMonaco()

await createDiffEditor(container, '旧代码', '新代码', 'javascript')

const codes = getCode()
// codes = { original: '旧代码', modified: '新代码' }
```

### Diff 编辑器使用（Vue）

#### 快速开始

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco } from 'stream-monaco'

const container = ref<HTMLElement>()

const {
  createDiffEditor,
  updateDiff,
  updateOriginal,
  updateModified,
  getDiffEditorView,
  cleanupEditor,
} = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['javascript', 'typescript'],
  readOnly: true,
  MAX_HEIGHT: 500,
  // 自动折叠大段未改动区域
  diffHideUnchangedRegions: true,
  // hover 变更块时显示上下分区的局部 Revert / Stage 操作
  diffHunkActionsOnHover: true,
})

const original = `export function add(a: number, b: number) {\n  return a + b\n}`
const modified = `export function add(a: number, b: number) {\n  return a + b\n}\n\nexport function sub(a: number, b: number) {\n  return a - b\n}`

onMounted(async () => {
  if (!container.value)
    return
  await createDiffEditor(container.value, original, modified, 'typescript')
})
```

Diff 体验增强相关配置：

- `diffHideUnchangedRegions`（默认 `true`）：折叠未改动区块；也支持直接传 Monaco 的 `hideUnchangedRegions` 对象。
- `diffLineStyle`（默认 `background`）：控制变更行的强调方式；传 `bar` 可切换到更克制的 review 风格竖条表现。
- `diffAppearance`（默认 `auto`）：控制 diff 外层 chrome 的明暗风格；可强制 `light` / `dark`，代码 token 仍跟随当前主题。
- `diffUnchangedRegionStyle`（默认 `line-info`）：控制折叠未改动区块的展示方式；`line-info`、`line-info-basic`、`metadata` 都使用更紧凑的 `32px` 折叠行，其中 `line-info-basic` 仍保留更宽的 legacy rail，`simple` 则是更紧的 `28px` 占位行。
- `diffHunkActionsOnHover`（默认 `false`）：仅在显式传 `true` 时，hover 变更 hunk 才会显示上下分区的 `Revert` / `Stage`。
- `onDiffHunkAction(context)`（可选）：返回 `false` 可拦截并跳过内置模型编辑逻辑。
- 内置的 `Revert` / `Stage` 默认只会改 Monaco model，不会直接执行 `git revert`、`git add` 或 `git stash`；如果你要接真实 Git，需要通过 `onDiffHunkAction` 接到自己的后端流程。

完整接入文档：

- [Diff 接入指南](docs/diff-integration.zh-CN.md)
- 已导出的 TS 类型包括 `UseMonacoReturn`、`DiffLineStyle`、`DiffAppearance`、`DiffUnchangedRegionStyle`、`DiffModels`、`DiffModelPair`、`DiffModelTransitionOptions`、`DiffHunkActionContext`

示例 1：开启 hidden 区折叠 + hover Revert/Stage（可理解为局部回退与暂存）

```ts
const { createDiffEditor } = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['typescript'],
  readOnly: true,
  diffHideUnchangedRegions: {
    enabled: true,
    contextLineCount: 2,
    minimumLineCount: 4,
    revealLineCount: 2,
  },
  diffLineStyle: 'bar',
  diffHunkActionsOnHover: true,
})

await createDiffEditor(container, original, modified, 'typescript')
```

示例 2：完全接管 Revert/Stage 事件（接你自己的 Git / stash / patch API）

```ts
useMonaco({
  diffHideUnchangedRegions: true,
  diffHunkActionsOnHover: true,
  onDiffHunkAction: async (ctx) => {
    const {
      action, // 'revert' | 'stage'
      side, // 'upper' | 'lower'
      lineChange,
      originalModel,
      modifiedModel,
    } = ctx

    // 这里接你的服务端逻辑，例如提交到 stash / patch 队列
    await saveHunkAction({
      action,
      side,
      range: lineChange,
      original: originalModel.getValue(),
      modified: modifiedModel.getValue(),
    })

    // 返回 false: 拦截内置编辑（由你完全接管）
    // 返回 true/undefined: 继续执行内置编辑
    return false
  },
})
```

示例 3：服务端返回刷新后的文件内容，前端再调用 `updateDiff(...)`

```ts
const monaco = useMonaco({
  diffHideUnchangedRegions: true,
  diffHunkActionsOnHover: true,
  onDiffHunkAction: async (ctx) => {
    const response = await fetch('/api/git/hunks/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: ctx.action,
        side: ctx.side,
        range: ctx.lineChange,
        original: ctx.originalModel.getValue(),
        modified: ctx.modifiedModel.getValue(),
      }),
    })

    const next = await response.json()
    monaco.updateDiff(next.original, next.modified, 'typescript')
    return false
  },
})
```

注意：

- hover `Revert` 表示 hunk 级别的局部回退，不等于 `git revert <commit>`。
- hover `Stage` 更接近 `git add -p` / `git apply --cached`。
- 如果你想做 stash 流程，建议把 `onDiffHunkAction` 当成“生成 patch 意图”的回调，把选中的 half-hunk 交给后端 stash 或 patch 队列。
- 如果你的后端会返回刷新后的整份文件内容，前端最直接的做法就是调用 `updateDiff(...)` 把 Git 已应用后的结果回灌到 diff UI。仓库里也提供了 `pnpm run validate:diff-hunk-update-diff-flow` 来覆盖这条模式。
- 更完整的 Git 绑定方式见 [Diff 接入指南](docs/diff-integration.zh-CN.md)。

视觉校验辅助命令：

- `pnpm run shot:diff-ux -- background /tmp/stream-monaco-diff-reference.png pierre-reference`
  抓取 Pierre 风格参考场景，固定视口、文件头和 `-1 / +1` 的单 hunk diff；第四个参数可额外指定 `snazzy-light` 这类 theme。
- `pnpm run compare:diff-ux -- /tmp/stream-monaco-diff-reference.png background pierre-reference`
  重新抓取同一场景并输出截图指标，例如 `diffPixels`、`mismatchRatio`、`exactMatch`；最后一个参数可指定同一套 theme 做对比。

### Shiki 高亮器（高级说明）

如果你在页面上除了 Monaco 编辑器外还使用 Shiki 的 highlighter 单独渲染代码片段（例如静态 HTML 片段），推荐的做法是：

- 调用 `registerMonacoThemes(themes, languages)` 在应用启动或编辑器创建前预注册需要的主题和语言，函数会返回一个解析为 shiki highlighter 的 Promise，便于你直接复用高亮器实例。
- 在切换主题时，先调用 `monaco.editor.setTheme(themeName)` 更新编辑器，然后显式调用 highlighter 的 `setTheme(themeName)` 或使用 `codeToHtml` 重新渲染页面片段。错误与加载状态应由调用方自行处理。

示例：

```ts
import { registerMonacoThemes } from 'stream-monaco'

// 在应用启动或创建编辑器前一次性注册全部 themes & langs
const highlighter = await registerMonacoThemes(allThemes, allLanguages)

// 创建编辑器
```

### 浏览器级基准（更接近真实 Monaco）

仓库内还提供了一个 Playwright 脚本 `scripts/playwright-bench.mjs`，它将在 headless Chromium 中加载 Monaco（通过 CDN）并运行高频更新，从而测量真实编辑器下的耗时与 long-task 计数。

安装并运行（本地）：

```bash
pnpm add -D playwright
# 若初次安装，请按 Playwright 指示安装浏览器二进制
npx playwright install

# 运行脚本（可指定参数 updates freqHz，第三个参数传 'append' 则使用 append 路径）
pnpm run bench:playwright -- 2000 200
pnpm run bench:playwright -- 2000 200 append
```

注意：该脚本会从 CDN 加载 Monaco（需网络），并在本地 headless Chromium 中执行，适合用于在本机或 CI（带浏览器支持）上做真实性能评估。

## 性能与流式更新建议

在 0.0.32 之后的版本引入了对高频流式更新的更细粒度控制：

- `updateThrottleMs`（number）: 控制 `updateCode` 的时间节流窗口（ms）。默认值为 50ms。将其设为 0 表示仅使用 RAF 合并（原始行为）。
- `minimalEditMaxChars`（number）: 控制在尝试“最小替换”之前允许的最大字符总和（prev.length + next.length）。超过该值将直接使用全量 `setValue`。可通过 `useMonaco({ minimalEditMaxChars })` 覆盖。
- `minimalEditMaxChangeRatio`（number）: 当变更比例（|new-prev|/maxLen）超过此阈值时，放弃最小替换，改为全量替换。

示例：

```ts
useMonaco({
  updateThrottleMs: 50, // 推荐：30~100ms，根据场景调优
  minimalEditMaxChars: 200000,
  minimalEditMaxChangeRatio: 0.25,
})
```

运行时调整节流：

```ts
const { setUpdateThrottleMs, getUpdateThrottleMs } = useMonaco()

// 临时关闭时间节流（仅 RAF 合并）
setUpdateThrottleMs(0)

// 恢复为 50ms
setUpdateThrottleMs(50)

console.log('current throttle', getUpdateThrottleMs())
```

快速 benchmark：仓库内提供了一个轻量脚本 `scripts/stream-benchmark.mjs`，用于在 Node 环境下模拟高频 updateCode 场景（不依赖真实 Monaco，只模拟 wrapper 行为）。运行：

```bash
pnpm run bench
# 可指定参数：pnpm run bench -- 5000 200 50
# 参数含义：updates freqHz throttleMs
```

该脚本输出 JSON，包含总用时、平均每次更新耗时和最终文本长度，便于对比不同 `updateThrottleMs` 下的表现。

// 批量（同帧）更新，两侧同时变化时更方便
function pushNewDiff(newOriginal: string, newModified: string) {
updateDiff(newOriginal, newModified, 'typescript')
}

// 仅更新其中一侧（即时增量）
function pushModifiedChunk(chunk: string) {
updateModified(chunk)
}
</script>

<template>
  <div ref="container" class="diff-editor" />
  <button @click="() => pushNewDiff(original, `${modified}\n// more`)">
    Append
  </button>
  <button @click="() => pushModifiedChunk(`${modified}\n// chunk`)">
    Append modified
  </button>
  <button @click="cleanupEditor">
    Dispose
  </button>
</template>

<style scoped>
.diff-editor {
  border: 1px solid #e0e0e0;
  border-radius: 4px;
}
</style>

````

### 流式追加 + 语言切换（快速示例）

### 自动滚动配置说明

下面是与自动滚动行为相关的可配置项及推荐值：

- `revealDebounceMs` (number, ms)
  - 说明：在流式追加或短时间内多次更新时，会把多次 reveal 请求合并成一次。减少滚动频率与抖动。
  - 默认：75
  - 建议：流式输出时保留 50-150，静态或实时编辑可设为 0 以禁用合并。

- `revealBatchOnIdleMs` (number | undefined)
  - 说明：如果设置为正数（例如 200），系统会在最后一次追加后等待该毫秒数再执行一次“最终”滚动。这适合大量小片段追加后一次性滚动到底部。
  - 默认：undefined（禁用）

- `revealStrategy` ("bottom" | "centerIfOutside" | "center")
  - 说明：控制使用哪种 reveal API。
    - `bottom`：使用 `revealLine`（靠近底部，变化明显）
    - `centerIfOutside`：使用 `revealLineInCenterIfOutsideViewport`（默认，更温和，只在目标不在视口内时居中）
    - `center`：使用 `revealLineInCenter`（总是居中）

这些选项已添加到 `useMonaco()` 的配置中，并可通过 TypeScript 的 `RevealStrategy` 枚举（库导出）进行引用。

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco } from 'stream-monaco'

const el = ref<HTMLElement>()
const { createEditor, appendCode, setLanguage, cleanupEditor } = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['markdown', 'typescript'],
  readOnly: false,
  MAX_HEIGHT: 360,
})

let i = 0
let timer: any

onMounted(async () => {
  if (!el.value)
    return
  await createEditor(el.value, '# Stream start\n', 'markdown')
  // 模拟流式输出
  timer = setInterval(() => {
    i++
    appendCode(`- line ${i}\\n`)
    if (i === 5)
      setLanguage('typescript') // 动态切换语言
    if (i >= 10) {
      clearInterval(timer)
    }
  }, 300)
})
</script>

<template>
  <div ref="el" />
  <button @click="cleanupEditor">
    Dispose
  </button>
  <p>前 5 行为 Markdown，随后切换为 TypeScript。</p>
  <p>当内容接近底部时自动滚动（可通过 autoScroll* 选项进行控制）。</p>
  <p>若是纯末尾追加，内部会走追加快路径，避免全量替换。</p>
</template>
````

更多完整示例请见 examples/ 目录。

#### 行为说明（增量与 RAF）

- `updateDiff` 使用 `requestAnimationFrame` 合并同一帧内的多次调用，减少重排与布局开销。
- 当新内容以旧内容为前缀时，采用“仅追加”的策略，避免全量替换带来的性能损耗。
- 其他情况下执行“最小中段替换”，在模型上计算公共前后缀，只替换中间变化段，减少编辑器刷新范围。
- `updateOriginal` / `updateModified` 为即时增量更新，适合单侧独立流式场景。
- 可通过 options.diffAutoScroll 关闭 Diff 编辑器 modified 侧的自动滚动；默认开启以保持与单编辑器一致的体验。

#### 显式流式追加（推荐）

当你是标准的“持续在末尾追加”场景，建议直接使用显式追加 API，可减少 diff 计算并获得最佳实时性：

```ts
const { createDiffEditor, appendOriginal, appendModified } = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['typescript'],
})

await createDiffEditor(container, '', '', 'typescript')

// 只向 original 侧持续追加
appendOriginal('line 1\n')
appendOriginal('line 2\n')

// 只向 modified 侧持续追加
appendModified('out 1\n')
appendModified('out 2\n')
```

提示：在 `updateDiff`/`updateOriginal`/`updateModified` 中，当检测到“语言未变且严格前缀追加”时，内部也会自动走“立即追加”的快路径；否则进入 `requestAnimationFrame` 合并 + 最小替换。

#### 视图模式切换与模型访问

你可以获取 Diff 的两个模型来做更底层控制，或切换视图模式：

```ts
const { createDiffEditor, getDiffEditorView, getDiffModels } = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['typescript'],
})

await createDiffEditor(container, left, right, 'typescript')

// 切换为内联模式
getDiffEditorView()?.updateOptions({ renderSideBySide: false })

// 获取模型：你可以自行订阅内容变化等底层行为
const { original, modified } = getDiffModels()
original?.onDidChangeContent?.(() => {
  /* ... */
})
modified?.onDidChangeContent?.(() => {
  /* ... */
})
```

### API 参考

#### useMonaco(options?)

##### 参数

| 参数                       | 类型                                                         | 默认值                              | 描述                                                            |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------- |
| `MAX_HEIGHT`               | `number`                                                     | `500`                               | 编辑器最大高度（像素）                                          |
| `readOnly`                 | `boolean`                                                    | `true`                              | 是否为只读模式                                                  |
| `themes`                   | `MonacoTheme[]`                                              | `['vitesse-dark', 'vitesse-light']` | 主题数组，至少包含两个主题                                      |
| `languages`                | `MonacoLanguage[]`                                           | 见默认语言列表                      | 支持的编程语言数组                                              |
| `theme`                    | `string`                                                     | -                                   | 初始主题名称                                                    |
| `isCleanOnBeforeCreate`    | `boolean`                                                    | `true`                              | 是否在创建前清理之前注册的资源                                  |
| `onBeforeCreate`           | `function`                                                   | -                                   | 编辑器创建前的钩子函数                                          |
| `autoScrollOnUpdate`       | `boolean`                                                    | `true`                              | 更新内容时若接近底部则自动滚动                                  |
| `autoScrollInitial`        | `boolean`                                                    | `true`                              | 是否默认启用自动滚动                                            |
| `autoScrollThresholdPx`    | `number`                                                     | `32`                                | 自动滚动的像素阈值                                              |
| `autoScrollThresholdLines` | `number`                                                     | `2`                                 | 自动滚动的行数阈值                                              |
| `diffAutoScroll`           | `boolean`                                                    | `true`                              | 是否启用 Diff modified 侧自动滚动                               |
| `diffHideUnchangedRegions` | `boolean \| object`                                          | `true`                              | 是否折叠 Diff 中未改动区块（支持传 Monaco 配置对象）            |
| `diffLineStyle`            | `'background' \| 'bar'`                                      | `'background'`                      | 控制变更行是偏背景块还是偏 review 竖条风格                      |
| `diffAppearance`           | `'auto' \| 'light' \| 'dark'`                                | `'auto'`                            | 控制 diff 外层 chrome 明暗，代码 token 仍跟随当前主题           |
| `diffUnchangedRegionStyle` | `'line-info' \| 'line-info-basic' \| 'metadata' \| 'simple'` | `'line-info'`                       | 控制折叠未改动区块的展示方式                                    |
| `diffHunkActionsOnHover`   | `boolean`                                                    | `false`                             | 是否启用 hover hunk 的上下分区局部 Revert / Stage（需显式开启） |
| `diffHunkHoverHideDelayMs` | `number`                                                     | `160`                               | hover 操作浮层离开后的隐藏延迟（毫秒）                          |
| `onDiffHunkAction`         | `function`                                                   | -                                   | hunk 操作回调（返回 `false` 可阻止默认编辑）                    |
| `diffUpdateThrottleMs`     | `number`                                                     | `50`                                | Diff 流式更新节流时间（毫秒）                                   |

##### 返回值

| 方法/属性                 | 类型                                                                                                                  | 描述                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createEditor`            | `(container: HTMLElement, code: string, language: string) => Promise<MonacoEditorInstance>`                           | 创建并挂载编辑器到指定容器                                                                                                                                                             |
| `createDiffEditor`        | `(container: HTMLElement, original: string, modified: string, language: string) => Promise<MonacoDiffEditorInstance>` | 创建并挂载 Diff 编辑器                                                                                                                                                                 |
| `cleanupEditor`           | `() => void`                                                                                                          | 销毁编辑器并清理容器                                                                                                                                                                   |
| `updateCode`              | `(newCode: string, codeLanguage: string) => void`                                                                     | 更新编辑器内容和语言（RAF 合并、增量优化）                                                                                                                                             |
| `appendCode`              | `(appendText: string, codeLanguage?: string) => void`                                                                 | 在编辑器末尾追加文本                                                                                                                                                                   |
| `updateDiff`              | `(original: string, modified: string, codeLanguage?: string) => void`                                                 | 批量更新 Diff 内容（RAF 合并、增量优化）                                                                                                                                               |
| `updateOriginal`          | `(newCode: string, codeLanguage?: string) => void`                                                                    | 仅更新 original（即时增量）                                                                                                                                                            |
| `updateModified`          | `(newCode: string, codeLanguage?: string) => void`                                                                    | 仅更新 modified（即时增量）                                                                                                                                                            |
| `setDiffModels`           | `(models: DiffModelPair, options?: DiffModelTransitionOptions) => Promise<void>`                                      | 原地切换整对 Diff models；当新旧内容相同，会先预热 Monaco 的 diff view model，再走保留视图状态的低抖动切换                                                                             |
| `setTheme`                | `(theme: MonacoTheme, force?: boolean) => Promise<void>`                                                              | 切换编辑器主题；`force=true` 时即使当前主题相同也会强制重应用                                                                                                                          |
| `refreshDiffPresentation` | `() => void`                                                                                                          | 在不 remount 的情况下，重算 diff chrome / unchanged overlay 的表现层                                                                                                                   |
| `setLanguage`             | `(language: MonacoLanguage) => void`                                                                                  | 切换编辑器语言                                                                                                                                                                         |
| `getCurrentTheme`         | `() => string`                                                                                                        | 获取当前主题名称                                                                                                                                                                       |
| `getEditor`               | `() => typeof monaco.editor`                                                                                          | 获取 Monaco 的静态 editor 对象                                                                                                                                                         |
| `getEditorView`           | `() => MonacoEditorInstance \| null`                                                                                  | 获取当前编辑器实例                                                                                                                                                                     |
| `getDiffEditorView`       | `() => MonacoDiffEditorInstance \| null`                                                                              | 获取当前 Diff 编辑器实例                                                                                                                                                               |
| `getDiffModels`           | `() => DiffModels`                                                                                                    | 获取 Diff 两侧模型                                                                                                                                                                     |
| `getMonacoInstance`       | `() => typeof monaco`                                                                                                 | 获取 Monaco 模块实例                                                                                                                                                                   |
| `setUpdateThrottleMs`     | `(ms: number) => void`                                                                                                | 动态调整 `updateCode` 的时间节流                                                                                                                                                       |
| `getUpdateThrottleMs`     | `() => number`                                                                                                        | 获取当前 `updateCode` 节流值                                                                                                                                                           |
| `getCode`                 | `() => MonacoCodeValue`                                                                                               | **获取编辑器当前代码**<br>- 普通编辑器返回 `string`<br>- Diff 编辑器返回 `{ original, modified }`<br>- 无编辑器返回 `null`<br>**用途**：获取用户手动编辑后的最新代码或程序更新后的内容 |
| `appendOriginal`          | `(appendText: string, codeLanguage?: string) => void`                                                                 | 在 original 末尾追加（显式流式）                                                                                                                                                       |
| `appendModified`          | `(appendText: string, codeLanguage?: string) => void`                                                                 | 在 modified 末尾追加（显式流式）                                                                                                                                                       |

#### 支持的主题

包括但不限于：

- `vitesse-dark` / `vitesse-light`
- `github-dark` / `github-light`
- `dracula` / `dracula-soft`
- `one-dark-pro` / `one-light`
- `tokyo-night`
- `material-theme` 系列
- `catppuccin` 系列
- 以及更多...

#### 支持的语言

包括但不限于：

- `javascript` / `typescript` / `jsx` / `tsx`
- `vue` / `html` / `css` / `scss` / `less`
- `python` / `java` / `csharp` / `cpp` / `rust` / `go`
- `json` / `yaml` / `toml` / `xml`
- `markdown` / `dockerfile`
- 以及 100+ 种语言...

### 最佳实践

#### 1. 性能优化

```typescript
// 只加载需要的语言，减少包体积
const { createEditor } = useMonaco({
  languages: ['javascript', 'typescript'], // 只加载必要的语言
  themes: ['vitesse-dark', 'vitesse-light'],
})
```

#### 2. 内存管理

```vue
<script setup>
import { onUnmounted } from 'vue'

const { createEditor, cleanupEditor } = useMonaco()

onUnmounted(() => {
  cleanupEditor()
})
</script>
```

### 故障排除

#### 1. 打包后编辑器无法显示

确保正确配置了 Monaco Editor 的 Web Workers。

**Vue CLI 4（Webpack 4）注意：** Webpack 4 无法解析 `import.meta.url`。请改用 `stream-monaco/legacy` 入口（不包含 `import.meta`），并在项目侧配置 Monaco workers。

推荐使用 `monaco-editor-webpack-plugin` 来处理 Monaco workers：

```bash
pnpm add -D monaco-editor-webpack-plugin
```

`vue.config.js`：

```js
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin')

module.exports = {
  configureWebpack: {
    plugins: [
      new MonacoWebpackPlugin({
        languages: ['json', 'css', 'html', 'typescript'],
      }),
    ],
  },
}
```

并尽早调用一次（例如 `main.ts`）：

```ts
import { preloadMonacoWorkers } from 'stream-monaco/legacy'

preloadMonacoWorkers()
```

默认的 `stream-monaco` 与 `stream-monaco/legacy` 入口在模块求值时会做一次 best-effort 的 Monaco worker 安装。包元数据只把这些已发布入口文件标记为有 side effects，其余内部模块仍保持正常 tree-shaking。

#### 2. Diff 编辑器流式更新时内容区空白

确保在调用 `createEditor` / `createDiffEditor` 之前已正确配置 Monaco 的 workers（建议尽早调用 `preloadMonacoWorkers()`）。

#### 3. 主题不生效

检查主题名称是否正确，确保主题已在 `themes` 数组中注册。

#### 4. 语言高亮不工作

确保语言已在 `languages` 数组中包含，并且 Shiki 支持该语言。

### 贡献

欢迎提交 Issue 或 PR 来改进此项目！

### 开发

```bash
# 克隆项目
git clone https://github.com/Simon-He95/stream-monaco.git

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev

# 构建
pnpm build
```

### :coffee:

[buy me a cup of coffee](https://github.com/Simon-He95/sponsor)

### License

[MIT](./license)

### Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.svg">
    <img src="https://cdn.jsdelivr.net/gh/Simon-He95/sponsor/sponsors.png"/>
  </a>
</p>

## 致谢

### Clearing shiki highlighter cache

The library caches shiki highlighters internally to avoid recreating them for the same theme combinations. In long-running applications that may dynamically create many distinct theme combinations, you can clear the cache to free memory or fully reset the shared highlighter state (for example in tests or on app shutdown):

- `clearHighlighterCache()` — clears cached highlighters and resets the shared Monaco/Shiki highlighter state
- `getHighlighterCacheSize()` — returns number of cached entries

Call `clearHighlighterCache()` when you are certain highlighters are no longer needed (for example during teardown), otherwise leaving the cache enabled provides a performance benefit by reusing previously-created highlighters.
