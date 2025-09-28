## vue-use-monaco

[![npm](https://img.shields.io/npm/v/vue-use-monaco)](https://www.npmjs.com/package/vue-use-monaco)
[![license](https://img.shields.io/npm/l/vue-use-monaco)](./license)

### 项目简介

`vue-use-monaco` 是一个结合 Vue、Monaco 编辑器和 Shiki 语法高亮的组合式函数库，专为流式输入更新和高效代码高亮而设计。它提供了完整的 Monaco 编辑器集成方案，适用于需要实时代码编辑和高亮的场景。

IMPORTANT: Since v0.0.32 the library enables a default time-based throttle for `updateCode` (`updateThrottleMs = 50`) to reduce CPU usage under high-frequency streaming. Set `updateThrottleMs: 0` in `useMonaco()` options to restore previous behavior (only RAF-based coalescing).

### 特性

- 🚀 **开箱即用** - 基于 Vue 3 组合式 API 设计
- 🎨 **Shiki 高亮** - 使用 Shiki 实现高效的语法高亮，支持 TextMate 语法和 VS Code 主题
- 🌓 **主题切换** - 自动监听 isDark 模式变化，智能切换明暗主题
- 📝 **流式更新** - 支持流式输入更新，实时响应代码变化
- 🔀 **Diff 编辑器** - 一行 API 创建 Monaco Diff Editor，支持流式/增量更新 original/modified
- 🗑️ **内存管理** - 自动销毁编辑器实例，避免内存泄漏
- 🔧 **高度可配置** - 支持所有 Monaco 编辑器原生配置选项
- 🎯 **TypeScript 支持** - 完整的 TypeScript 类型定义

### 快速 API 概览

本库现在在包根导出了若干与主题/高亮器相关的辅助函数，便于高级用法：

- `registerMonacoThemes(themes, languages): Promise<Highlighter>` — 使用 shiki 创建或获取高亮器并把主题注册到 Monaco，返回解析为 shiki highlighter 的 Promise，便于复用（例如渲染页面片段）。
`getOrCreateHighlighter(themes, languages): Promise<Highlighter>` — 直接获取或创建一个 highlighter（并受内部缓存管理）。如需直接控制 shiki highlighter（例如调用 `codeToHtml` 或 `setTheme`），请使用此方法并自行处理加载/错误逻辑。

注意：如果你只使用 Monaco 编辑器并在 `createEditor` 时传入了全量 `themes`，通常只需调用 `monaco.editor.setTheme(themeName)` 即可。

配置：`useMonaco()` 不会自动同步 Shiki highlighter；如果你需要在切换主题时同步页面中独立的 Shiki 渲染，请手动使用 `getOrCreateHighlighter(...)` 并调用高亮器实例的 `setTheme`。

### 安装

使用 pnpm 安装：

```bash
pnpm add vue-use-monaco
```

使用 npm 安装：

```bash
npm install vue-use-monaco
```

使用 yarn 安装：

```bash
yarn add vue-use-monaco
```

### 基础使用

#### 简单示例

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useMonaco } from 'vue-use-monaco'

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
import type { MonacoLanguage, MonacoTheme } from 'vue-use-monaco'
import { onMounted, ref } from 'vue'
import { useMonaco } from 'vue-use-monaco'

const editorContainer = ref<HTMLElement>()

const {
  createEditor,
  updateCode,
  setTheme,
  setLanguage,
  getCurrentTheme,
  getEditor,
  getEditorView,
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
</script>

<template>
  <div>
    <div class="controls">
      <button @click="switchTheme('github-dark')">
        暗色主题
      </button>
      <button @click="switchTheme('github-light')">
        亮色主题
      </button>
      <button @click="switchLanguage('typescript')">
        TypeScript
      </button>
      <button @click="switchLanguage('python')">
        Python
      </button>
    </div>
    <div ref="editorContainer" class="editor" />
  </div>
</template>
```

### Diff 编辑器使用

#### 快速开始

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco } from 'vue-use-monaco'

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
})

const original = `export function add(a: number, b: number) {\n  return a + b\n}`
const modified = `export function add(a: number, b: number) {\n  return a + b\n}\n\nexport function sub(a: number, b: number) {\n  return a - b\n}`

onMounted(async () => {
  if (!container.value)
    return
  await createDiffEditor(container.value, original, modified, 'typescript')
})
```

### Shiki 高亮器（高级说明）

如果你在页面上除了 Monaco 编辑器外还使用 Shiki 的 highlighter 单独渲染代码片段（例如静态 HTML 片段），推荐的做法是：

- 调用 `registerMonacoThemes(themes, languages)` 在应用启动或编辑器创建前预注册需要的主题和语言，函数会返回一个解析为 shiki highlighter 的 Promise，便于你直接复用高亮器实例。
- 在切换主题时，先调用 `monaco.editor.setTheme(themeName)` 更新编辑器，然后显式调用 highlighter 的 `setTheme(themeName)` 或使用 `codeToHtml` 重新渲染页面片段。错误与加载状态应由调用方自行处理。

示例：

```ts
import { registerMonacoThemes } from 'vue-use-monaco'

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
const { createEditor, setTheme } = useMonaco({ themes: allThemes, languages: allLanguages })

// 当你切换主题时：
setTheme('vitesse-dark')
try {
  await highlighter.setTheme('vitesse-dark')
  // re-render snippets using highlighter.codeToHtml(...)
}
catch (err) {
  // handle fail-to-load or other errors
}
```

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
```

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
import { useMonaco } from 'vue-use-monaco'

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
```

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
const {
  createDiffEditor,
  appendOriginal,
  appendModified,
} = useMonaco({ themes: ['vitesse-dark', 'vitesse-light'], languages: ['typescript'] })

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
original?.onDidChangeContent?.(() => { /* ... */ })
modified?.onDidChangeContent?.(() => { /* ... */ })
```

### API 参考

#### useMonaco(options?)

##### 参数

| 参数                    | 类型               | 默认值                              | 描述                           |
| ----------------------- | ------------------ | ----------------------------------- | ------------------------------ |
| `MAX_HEIGHT`            | `number`           | `500`                               | 编辑器最大高度（像素）         |
| `readOnly`              | `boolean`          | `true`                              | 是否为只读模式                 |
| `themes`                | `MonacoTheme[]`    | `['vitesse-dark', 'vitesse-light']` | 主题数组，至少包含两个主题     |
| `languages`             | `MonacoLanguage[]` | 见默认语言列表                      | 支持的编程语言数组             |
| `theme`                 | `string`           | -                                   | 初始主题名称                   |
| `isCleanOnBeforeCreate` | `boolean`          | `true`                              | 是否在创建前清理之前注册的资源 |
| `onBeforeCreate`        | `function`         | -                                   | 编辑器创建前的钩子函数         |
| `autoScrollOnUpdate`    | `boolean`          | `true`                              | 更新内容时若接近底部则自动滚动 |
| `autoScrollInitial`     | `boolean`          | `true`                              | 是否默认启用自动滚动           |
| `autoScrollThresholdPx` | `number`           | `32`                                | 自动滚动的像素阈值             |
| `autoScrollThresholdLines` | `number`        | `2`                                 | 自动滚动的行数阈值             |
| `diffAutoScroll`        | `boolean`          | `true`                              | 是否启用 Diff modified 侧自动滚动 |

##### 返回值

| 方法/属性              | 类型                                                                                                 | 描述                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `createEditor`         | `(container: HTMLElement, code: string, language: string) => Promise<MonacoEditor>`                  | 创建并挂载编辑器到指定容器                     |
| `createDiffEditor`     | `(container: HTMLElement, original: string, modified: string, language: string) => Promise<MonacoDiffEditor>` | 创建并挂载 Diff 编辑器                          |
| `cleanupEditor`        | `() => void`                                                                                         | 销毁编辑器并清理容器                           |
| `updateCode`           | `(newCode: string, codeLanguage: string) => void`                                                    | 更新编辑器内容和语言（RAF 合并、增量优化）     |
| `appendCode`           | `(appendText: string, codeLanguage?: string) => void`                                                | 在编辑器末尾追加文本                           |
| `updateDiff`           | `(original: string, modified: string, codeLanguage?: string) => void`                                | 批量更新 Diff 内容（RAF 合并、增量优化）       |
| `updateOriginal`       | `(newCode: string, codeLanguage?: string) => void`                                                   | 仅更新 original（即时增量）                     |
| `updateModified`       | `(newCode: string, codeLanguage?: string) => void`                                                   | 仅更新 modified（即时增量）                     |
| `setTheme`             | `(theme: MonacoTheme) => void`                                                                       | 切换编辑器主题                                 |
| `setLanguage`          | `(language: MonacoLanguage) => void`                                                                 | 切换编辑器语言                                 |
| `getCurrentTheme`      | `() => string`                                                                                       | 获取当前主题名称                               |
| `getEditor`            | `() => typeof monaco.editor`                                                                         | 获取 Monaco 的静态 editor 对象                 |
| `getEditorView`        | `() => MonacoEditor \| null`                                                                          | 获取当前编辑器实例                             |
| `getDiffEditorView`    | `() => MonacoDiffEditor \| null`                                                                      | 获取当前 Diff 编辑器实例                       |
| `appendOriginal`       | `(appendText: string, codeLanguage?: string) => void`                                                | 在 original 末尾追加（显式流式）               |
| `appendModified`       | `(appendText: string, codeLanguage?: string) => void`                                                | 在 modified 末尾追加（显式流式）               |

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

#### 3. 主题跟随系统

```typescript
import { useDark } from '@vueuse/core'

const isDark = useDark()

const { createEditor, setTheme } = useMonaco({
  themes: ['github-dark', 'github-light'],
})

// 主题会自动跟随 isDark 状态切换
```

### 故障排除

#### 1. 打包后编辑器无法显示

确保正确配置了 Monaco Editor 的 Web Workers（参考上面的 Vite/Webpack 配置）。

#### 2. 主题不生效

检查主题名称是否正确，确保主题已在 `themes` 数组中注册。

#### 3. 语言高亮不工作

确保语言已在 `languages` 数组中包含，并且 Shiki 支持该语言。

### 贡献

欢迎提交 Issue 或 PR 来改进此项目！

### 开发

```bash
# 克隆项目
git clone https://github.com/Simon-He95/vue-use-monaco.git

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

The library caches shiki highlighters internally to avoid recreating them for the same theme combinations. In long-running applications that may dynamically create many distinct theme combinations, you can clear the cache to free memory or reset state (for example in tests or on app shutdown):

- `clearHighlighterCache()` — clears the internal cache
- `getHighlighterCacheSize()` — returns number of cached entries

Call `clearHighlighterCache()` when you are certain highlighters are no longer needed (for example during teardown), otherwise leaving the cache enabled provides a performance benefit by reusing previously-created highlighters.
