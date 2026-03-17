# Diff 接入指南

本文档聚焦 `stream-monaco` 的 Diff Editor 接入方式、参数传法，以及当前可直接使用的 TypeScript 类型。

## 1. 最小接入

```ts
import { useMonaco } from 'stream-monaco'

const container = document.getElementById('diff')!

const { createDiffEditor, updateDiff, cleanupEditor } = useMonaco({
  themes: ['github-dark', 'github-light'],
  languages: ['typescript', 'javascript', 'json'],
  readOnly: true,
  MAX_HEIGHT: 560,
})

await createDiffEditor(
  container,
  'export const a = 1\n',
  'export const a = 2\n',
  'typescript',
)

updateDiff('export const a = 1\n', 'export const a = 3\n', 'typescript')

cleanupEditor()
```

Vue/React/Svelte/Solid 的接入方式都一样：

- 挂载时调用 `createDiffEditor(...)`
- 内容变化时调用 `updateDiff(...)` / `updateOriginal(...)` / `updateModified(...)`
- 卸载时调用 `cleanupEditor()`

## 2. 常用参数怎么传

所有参数都通过 `useMonaco(options)` 传入。

### 基础参数

```ts
const monaco = useMonaco({
  themes: ['github-dark', 'github-light'],
  languages: ['typescript', 'javascript'],
  theme: 'github-light',
  readOnly: true,
  MAX_HEIGHT: 560,
})
```

最常用的是：

- `themes`: 主题列表，建议至少提供一套 dark/light
- `languages`: 允许高亮的语言列表
- `theme`: 初始主题
- `readOnly`: Diff 预览通常建议 `true`
- `MAX_HEIGHT`: 编辑器最大高度

### Diff 专属增强参数

```ts
const monaco = useMonaco({
  themes: ['github-dark', 'github-light'],
  languages: ['typescript'],
  readOnly: true,

  diffHideUnchangedRegions: {
    enabled: true,
    contextLineCount: 3,
    minimumLineCount: 3,
    revealLineCount: 5,
  },
  diffLineStyle: 'background',
  diffAppearance: 'auto',
  diffUnchangedRegionStyle: 'line-info',
  diffHunkActionsOnHover: true,
  diffHunkHoverHideDelayMs: 160,
  diffUpdateThrottleMs: 50,
  revealDebounceMs: 75,
})
```

这几个参数的作用：

- `diffHideUnchangedRegions`
  控制未改动区折叠。支持 `true` / `false`，也支持直接传 Monaco 原生 `hideUnchangedRegions` 配置对象。
- `diffLineStyle`
  变更行的强调方式。
  - `background`: 背景块更明显
  - `bar`: 更接近 review UI 的竖条风格
- `diffAppearance`
  控制 diff chrome 的明暗。
  - `auto`: 跟随当前 Monaco 主题明暗
  - `light`: 强制浅色外框
  - `dark`: 强制深色外框
- `diffUnchangedRegionStyle`
  折叠未改动区的展示方式。
  - `line-info`: `71 unmodified lines`，展开按钮背景宽度跟随行号区，折叠行高为 `32px`
  - `line-info-basic`: `71 unmodified lines`，保留当前更宽的 legacy rail 效果，折叠行高为 `32px`
  - `metadata`: `@@ -59,9 +59,11 @@`，更紧凑的 `32px` 折叠行；切换过去时，下方内容会一起回流，避免多余留白
  - `simple`: 灰色占位条，折叠行高为 `28px`
- `diffHunkActionsOnHover`
  是否启用 hunk hover 的 `Revert / Stage`
- `diffHunkHoverHideDelayMs`
  hover 浮层隐藏延迟
- `diffUpdateThrottleMs`
  流式 diff 更新节流。默认是 `50`。
  如果开启未改动区折叠，库会等流式更新进入 idle 后再恢复折叠，避免内容还在持续流入时就开始收起未改动区。
- `revealDebounceMs`
  自动滚动 reveal 的合并延迟

### Monaco 原生 Diff 参数

`MonacoOptions` 现在同时包含：

- `monaco.editor.IStandaloneEditorConstructionOptions`
- `monaco.editor.IDiffEditorConstructionOptions`

所以除了上面这些 `stream-monaco` 自己的参数，你也可以直接传 Monaco 原生 diff 参数，例如：

```ts
useMonaco({
  renderSideBySide: true,
  enableSplitViewResizing: true,
  ignoreTrimWhitespace: false,
  originalEditable: false,
})
```

如果你想在运行时切换单列/双列，也可以直接操作实例：

```ts
const diff = monaco.getDiffEditorView()
diff?.updateOptions({ renderSideBySide: false })
```

## 3. 运行时常用方法

```ts
const {
  createDiffEditor,
  updateDiff,
  updateOriginal,
  updateModified,
  appendOriginal,
  appendModified,
  setDiffModels,
  setTheme,
  refreshDiffPresentation,
  getDiffEditorView,
  getDiffModels,
  getCode,
} = useMonaco()
```

Diff 常用方法：

- `createDiffEditor(container, original, modified, language)`
- `updateDiff(original, modified, language?)`
- `updateOriginal(code, language?)`
- `updateModified(code, language?)`
- `appendOriginal(text, language?)`
- `appendModified(text, language?)`
- `await setDiffModels({ original, modified }, options?)`
- `setTheme(theme, force?)`
- `refreshDiffPresentation()`
- `getDiffEditorView()`
- `getDiffModels()`
- `getCode()`

`getCode()` 在 diff 模式下会返回：

```ts
{
  original: string
  modified: string
}
```

### 运行时切换主题 / 展现层

如果你切换的只是 theme、appearance、line style、unchanged-region style 这类“换皮”能力，优先走运行时原地刷新，而不是 remount 整个 diff editor：

```ts
await monaco.setTheme('github-dark')
monaco.refreshDiffPresentation()
```

这样会保留现有 diff 壳、滚动位置和 unchanged overlay，只重算表现层。

theme / appearance 切换本身应该保持稳定不抖动。对于 `metadata`、`simple` 这种折叠高度不同的模式切换，外层 editor shell 仍然原地复用，但 Monaco 会把折叠区下方的内容一起回流到新的高度。

### 整对 model 切换但不 remount

如果你的场景是一次性替换整对 `original / modified` model，优先使用 `await setDiffModels(...)`，不要自己直接调用 `diffEditor.setModel(...)`：

```ts
const monacoApi = useMonaco()

const originalModel = monacoApi
  .getMonacoInstance()
  .editor.createModel(leftText, 'typescript')
const modifiedModel = monacoApi
  .getMonacoInstance()
  .editor.createModel(rightText, 'typescript')

await monacoApi.setDiffModels(
  {
    original: originalModel,
    modified: modifiedModel,
  },
  {
    codeLanguage: 'typescript',
  },
)
```

它比直接调原生 `setModel(...)` 更适合这套 diff UX，原因是：

- 库会在可见切换前预热 Monaco 的 diff view model，所以同内容切换可以避开首帧 scroll jump
- 如果新旧 models 的文本内容相同，会自动走默认的低抖动路径并保留 view state
- unchanged-region 状态和 diff chrome 会一起刷新，不会只换了 model、overlay 却不同步
- 库自己创建的 models 会安全 dispose，外部传入的 models 仍由调用方自己管理

可选项：

- `codeLanguage`：切换前先把两侧 model 归一到目标语言
- `preserveViewState`：即使内容变了，也强制保留当前 diff 视图状态

## 4. Hunk 操作回调

如果你想接管 `Revert / Stage`，可以用 `onDiffHunkAction`：

```ts
useMonaco({
  diffHunkActionsOnHover: true,
  onDiffHunkAction: async (ctx) => {
    await saveHunk(ctx)
    return false
  },
})
```

返回值语义：

- `false`: 阻止内置编辑逻辑，完全由你接管
- `true` 或 `undefined`: 继续执行内置逻辑

回调上下文类型是 `DiffHunkActionContext`。

## 5. 如何绑定到真实 Git（`revert` / `stage` / `stash`）

`stream-monaco` 默认并不会直接操作 Git。内置 hover action 只会修改内存中的 Monaco model。

先区分三个概念：

- hover `Revert` 表示 hunk 级别的局部回退，不等于 `git revert <commit>`；后者是 commit 粒度。
- hover `Stage` 更接近 `git add -p` / `git apply --cached`。
- 如果你要做 stash 流程，建议把 `onDiffHunkAction` 当成“生成 patch 意图”的回调，把选中的 half-hunk 交给后端 stash API 或 patch 队列。

一条比较稳妥的真实 Git 绑定链路是：

1. 在前端拦截 `onDiffHunkAction`。
2. 把 `action`、`side`、`lineChange`、`original`、`modified` 发给后端。
3. 后端根据这次 half-hunk 操作，算出目标文件内容。
4. 再把“当前内容 -> 目标内容”的差异生成为该文件的 unified patch。
5. 应用到 Git：
   - 回退 working tree：`git apply --recount -`
   - 暂存到 index：`git apply --cached --recount -`
   - 自定义 stash：把同一份 patch 存进你自己的 stash 服务，或在服务端包装 Git stash 流程
6. 把刷新后的 `original` / `modified` 返回前端，再调用 `updateDiff(...)` 或 `setDiffModels(...)`。

前端示例：

```ts
const monaco = useMonaco({
  diffHunkActionsOnHover: true,
  onDiffHunkAction: async (ctx) => {
    const response = await fetch('/api/git/hunks/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath,
        filePath,
        action: ctx.action,
        side: ctx.side,
        range: ctx.lineChange,
        original: ctx.originalModel.getValue(),
        modified: ctx.modifiedModel.getValue(),
      }),
    })

    const next = await response.json()
    monaco.updateDiff(next.original, next.modified, language)

    // Git 已经完成实际修改，这里跳过内置的本地 model 编辑。
    return false
  },
})
```

另一种很常见的接法是：后端直接返回刷新后的左右文件内容，前端再用 `updateDiff(...)` 原地刷新当前 diff。

当服务端已经能算出 Git apply 之后两侧文件应该是什么内容时，这通常是最直接的一种集成方式：

```ts
const monaco = useMonaco({
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

    // 服务端返回 Git 应用后的左右文件内容，前端直接刷新当前 diff。
    monaco.updateDiff(next.original, next.modified, language)
    return false
  },
})
```

这种方式更适合：

- 后端已经能直接给出完整的 `original` / `modified`
- 你希望保留当前 diff editor 实例，只刷新内容
- 你不需要切换成外部持有的 Monaco models

如果后端返回的是全新的 Monaco models，而不是普通字符串内容，那么更适合用 `setDiffModels(...)`。

后端侧的语义映射可以按这张表理解：

- `revert + lower`：把 modified 侧这部分内容从 working tree 里去掉
- `revert + upper`：把 original 侧这部分内容补回 working tree
- `stage + lower`：把 modified 侧这部分内容写进 index
- `stage + upper`：把 original 侧这部分内容从 index 移除

对于同时有 upper/lower 两半的 replace hunk，不建议硬套某一个 Git 子命令名。更稳妥的方式是：先算出“这次点击之后文件应该长什么样”，再针对这份精确 delta 生成 patch，然后把 patch 应用到 worktree 或 index。

如果你产品里真的想要一个“stash 这个 hunk”的动作，通常最稳的实现不是直接在浏览器里调 Git，而是后端维护一层“已保存 patch”队列。`git stash push --patch` 虽然存在，但它是交互式、并且是 repo 级行为，所以 review 工具更常见的做法是服务端包装，或者直接实现自己的 stash 层。

仓库里现在也提供了几条可直接参考的验证脚本：

- `pnpm run validate:diff-hunk-actions`：验证内置 local Revert / Stage 语义
- `pnpm run validate:diff-hunk-custom-flow`：验证异步自定义拦截后，业务代码直接改 model 的流程
- `pnpm run validate:diff-hunk-update-diff-flow`：验证异步自定义拦截后，由服务端返回刷新后的文件内容，再调用 `updateDiff(...)` 的流程

## 6. TS 类型是否完善

目前对外类型已经比较完整，Diff 接入常用到的都已经有正式导出：

- `MonacoOptions`
- `UseMonacoReturn`
- `MonacoTheme`
- `MonacoLanguage`
- `MonacoEditorInstance`
- `MonacoDiffEditorInstance`
- `DiffHideUnchangedRegions`
- `DiffLineStyle`
- `DiffAppearance`
- `DiffUnchangedRegionStyle`
- `DiffModels`
- `DiffModelPair`
- `DiffModelTransitionOptions`
- `DiffCodeValue`
- `MonacoCodeValue`
- `DiffHunkActionContext`

### 当前类型覆盖到什么程度

- `useMonaco(options)` 的返回值现在有显式 `UseMonacoReturn`
- Diff 自定义参数都有独立联合类型，不需要手写字符串
- `MonacoOptions` 同时覆盖单编辑器和原生 Diff Editor 的 construction options
- `getCode()`、`getDiffModels()` 这类返回值都有正式类型

### 结论

如果你的问题是“接入时会不会还要自己补一堆声明”，现在答案基本是不会。

更直接地说：

- 自定义 diff 参数：类型已完善
- `useMonaco()` 返回值：类型已完善
- Monaco 原生 diff 参数透传：类型已补齐

## 6. 建议的接入写法

如果你是在业务里做代码 review / patch 预览，我建议按这套接：

```ts
import type {
  DiffAppearance,
  DiffUnchangedRegionStyle,
  MonacoOptions,
  UseMonacoReturn,
} from 'stream-monaco'

const options: MonacoOptions = {
  themes: ['github-dark', 'github-light'],
  languages: ['typescript'],
  readOnly: true,
  diffAppearance: 'auto',
  diffLineStyle: 'background',
  diffUnchangedRegionStyle: 'line-info',
  diffHideUnchangedRegions: true,
  diffHunkActionsOnHover: true,
}

const monacoApi: UseMonacoReturn = useMonaco(options)
```

这样 IDE 补全会比较完整，后面接 `Reference / Streaming / Metadata / Simple` 这些模式也更稳。
