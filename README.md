## vue-use-monaco

[![npm](https://img.shields.io/npm/v/vue-use-monaco)](https://www.npmjs.com/package/vue-use-monaco)
[![license](https://img.shields.io/npm/l/vue-use-monaco)](./license)

### 项目简介

`vue-use-monaco` 是一个结合 Vue、Monaco 编辑器和 Shiki 语法高亮的组合式函数库，专为流式输入更新和高效代码高亮而设计。它提供了完整的 Monaco 编辑器集成方案，适用于需要实时代码编辑和高亮的场景。

### 特性

- 🚀 **开箱即用** - 基于 Vue 3 组合式 API 设计
- 🎨 **Shiki 高亮** - 使用 Shiki 实现高效的语法高亮，支持 TextMate 语法和 VS Code 主题
- 🌓 **主题切换** - 自动监听 isDark 模式变化，智能切换明暗主题
- 📝 **流式更新** - 支持流式输入更新，实时响应代码变化
- 🔀 **Diff 编辑器** - 一行 API 创建 Monaco Diff Editor，支持流式/增量更新 original/modified
- 🗑️ **内存管理** - 自动销毁编辑器实例，避免内存泄漏
- 🔧 **高度可配置** - 支持所有 Monaco 编辑器原生配置选项
- 🎯 **TypeScript 支持** - 完整的 TypeScript 类型定义

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
function switchTheme(theme: MonacoTheme) {
  setTheme(theme)
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

### 配置说明

#### Vite 配置

在使用 Monaco 编辑器时，建议使用 [vite-plugin-monaco-editor-esm](https://www.npmjs.com/package/vite-plugin-monaco-editor-esm) 插件处理 Web Workers。

```javascript
import path from 'node:path'
import vue from '@vitejs/plugin-vue'
// vite.config.js
import { defineConfig } from 'vite'
import monacoEditorPlugin from 'vite-plugin-monaco-editor-esm'

export default defineConfig({
  plugins: [
    vue(),
    monacoEditorPlugin({
      languageWorkers: [
        'editorWorkerService',
        'typescript',
        'css',
        'html',
        'json',
      ],
      customDistPath(root, buildOutDir, base) {
        return path.resolve(buildOutDir, 'monacoeditorwork')
      },
    }),
  ],
})
```

#### Webpack 配置

如果使用 Webpack，可以使用 `monaco-editor-webpack-plugin`：

```javascript
// webpack.config.js
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin')

module.exports = {
  plugins: [
    new MonacoWebpackPlugin({
      languages: ['javascript', 'typescript', 'css', 'html', 'json'],
    }),
  ],
}
```

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

// 组件卸载时自动清理（useMonaco 内部已处理）
// 但如果需要手动清理，可以调用：
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

本项目感谢以下开源库的支持：

- [Monaco Editor](https://microsoft.github.io/monaco-editor/) — 微软出品的强大代码编辑器内核
- [Shiki](https://shiki.matsu.io/) — 基于 TextMate 语法和 VS Code 主题的代码高亮库
- [Vue.js](https://vuejs.org/) — 渐进式 JavaScript 框架
- [@shikijs/monaco](https://github.com/shikijs/shiki) — Shiki 与 Monaco Editor 的集成
