# stream-monaco

[![NPM version](https://img.shields.io/npm/v/stream-monaco?color=a1b858&label=)](https://www.npmjs.com/package/stream-monaco)
[![中文版](https://img.shields.io/badge/docs-中文文档-blue)](README.zh-CN.md)
[![NPM downloads](https://img.shields.io/npm/dm/stream-monaco)](https://www.npmjs.com/package/stream-monaco)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/stream-monaco)](https://bundlephobia.com/package/stream-monaco)
[![License](https://img.shields.io/npm/l/stream-monaco)](./LICENSE)

Streaming Monaco Editor integration with Shiki syntax highlighting. Framework-agnostic core for Vue, React, Svelte, Solid, Preact, and Vanilla JS.

### Introduction

stream-monaco provides a framework-agnostic core for integrating Monaco Editor with Shiki syntax highlighting, optimized for streaming updates and efficient highlighting. It works great without Vue, while also offering a Vue-friendly API and examples.

IMPORTANT: Since v0.0.32, `updateCode` is time-throttled by default (`updateThrottleMs = 50`) to reduce CPU usage under high-frequency streaming. Set `updateThrottleMs: 0` in `useMonaco()` options to restore previous RAF-only behavior.

Note: Internally, reactivity now uses a thin adapter over `alien-signals`, so Vue is no longer a hard requirement at runtime for the core logic. Vue remains supported, but is an optional peer dependency. This makes the package more portable in non-Vue environments while keeping the same API.

### Features

- 🚀 Works without Vue (framework-agnostic core)
- 🌿 Ready to use with Vue 3 Composition API
- 🔁 Use in any framework: Vue, React, Svelte, Solid, Preact, or plain JS/TS
- 🎨 Shiki highlighting with TextMate grammars and VS Code themes
- 🌓 Dark/Light theme switching
- 📝 Streaming updates (append/minimal-edit)
- 🔀 Diff editor with efficient incremental updates
- 🗑️ Auto cleanup to avoid memory leaks
- 🔧 Highly configurable (all Monaco options)
- 🎯 Full TypeScript support

### Quick API overview

The package exports helpers around theme/highlighter for advanced use:

- `registerMonacoThemes(themes, languages): Promise<Highlighter>` — create or reuse a Shiki highlighter and register themes to Monaco. Returns a Promise resolving to the highlighter for reuse (e.g., rendering snippets).
- `getOrCreateHighlighter(themes, languages): Promise<Highlighter>` — get or create a highlighter (managed by internal cache). If you need to call `codeToHtml` or `setTheme` manually, use this and handle loading/errors.

Note:

- If the target theme is already included in the `themes` you passed to `useMonaco()`, calling `monaco.editor.setTheme(themeName)` is fine.
- If you switch to a theme that was not pre-registered (e.g. dynamic theme name like `andromeeda`), prefer `await setTheme(themeName)` from `useMonaco()`. It will ensure the theme is registered, and when possible it will also try to `loadTheme` on the underlying Shiki highlighter to avoid "Theme not found, you may need to load it first" errors.

Config: `useMonaco()` does not auto-sync an external Shiki highlighter; if you need external Shiki snippets to follow theme changes, call `getOrCreateHighlighter(...)` and `highlighter.setTheme(...)` yourself.

### API Reference

#### useMonaco(options?)

##### Parameters

| Parameter                   | Type                                                         | Default                             | Description                                                                                |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `MAX_HEIGHT`                | `number \| string`                                           | `500`                               | Maximum editor height                                                                      |
| `readOnly`                  | `boolean`                                                    | `true`                              | Whether the editor is read-only                                                            |
| `themes`                    | `MonacoTheme[]`                                              | `['vitesse-dark', 'vitesse-light']` | Theme list; should include at least one dark and one light theme                           |
| `languages`                 | `MonacoLanguage[]`                                           | built-in default language list      | Languages to register                                                                      |
| `theme`                     | `string`                                                     | -                                   | Initial theme name                                                                         |
| `isCleanOnBeforeCreate`     | `boolean`                                                    | `true`                              | Whether to dispose previously registered resources before creating a new editor            |
| `onBeforeCreate`            | `function`                                                   | -                                   | Hook called before editor creation                                                         |
| `autoScrollOnUpdate`        | `boolean`                                                    | `true`                              | Auto-scroll when content updates and the viewport is already near the bottom               |
| `autoScrollInitial`         | `boolean`                                                    | `true`                              | Whether auto-scroll starts enabled                                                         |
| `autoScrollThresholdPx`     | `number`                                                     | `32`                                | Pixel threshold for considering the viewport "near bottom"                                 |
| `autoScrollThresholdLines`  | `number`                                                     | `2`                                 | Line-based threshold for considering the viewport "near bottom"                            |
| `diffAutoScroll`            | `boolean`                                                    | `true`                              | Whether diff auto-scroll is enabled for the modified side                                  |
| `diffHideUnchangedRegions`  | `boolean \| object`                                          | `true`                              | Fold unchanged regions in diff mode; accepts Monaco `hideUnchangedRegions` config too      |
| `diffLineStyle`             | `'background' \| 'bar'`                                      | `'background'`                      | Controls whether changed lines are emphasized more as filled blocks or review-style bars   |
| `diffAppearance`            | `'auto' \| 'light' \| 'dark'`                                | `'auto'`                            | Controls the diff shell chrome appearance while token colors still follow the active theme |
| `diffUnchangedRegionStyle`  | `'line-info' \| 'line-info-basic' \| 'metadata' \| 'simple'` | `'line-info'`                       | Controls how collapsed unchanged regions are rendered                                      |
| `diffHunkActionsOnHover`    | `boolean`                                                    | `false`                             | Enables split upper/lower hunk hover actions: `Revert` / `Stage`                           |
| `diffHunkHoverHideDelayMs`  | `number`                                                     | `160`                               | Hide delay for hunk hover action widgets                                                   |
| `onDiffHunkAction`          | `function`                                                   | -                                   | Hunk action callback; return `false` to skip built-in edits                                |
| `revealDebounceMs`          | `number`                                                     | `75`                                | Debounce for auto-reveal during streaming updates                                          |
| `revealStrategy`            | `'bottom' \| 'centerIfOutside' \| 'center'`                  | `'centerIfOutside'`                 | Reveal strategy used when auto-scrolling                                                   |
| `revealBatchOnIdleMs`       | `number \| undefined`                                        | -                                   | Final idle-time reveal window for append-heavy scenarios                                   |
| `updateThrottleMs`          | `number`                                                     | `50`                                | Time-based throttle for `updateCode`                                                       |
| `diffUpdateThrottleMs`      | `number`                                                     | `50`                                | Time-based throttle for diff streaming updates                                             |
| `minimalEditMaxChars`       | `number`                                                     | built-in constant                   | Fallback to `setValue` when documents are too large for minimal-edit diffing               |
| `minimalEditMaxChangeRatio` | `number`                                                     | built-in constant                   | Fallback to `setValue` when the change ratio is too large                                  |

`MonacoOptions` also includes Monaco's native editor and diff-editor construction options, so you can pass options such as `renderSideBySide`, `ignoreTrimWhitespace`, `originalEditable`, or `enableSplitViewResizing` directly.

##### Returns

| Method / property         | Type                                                                                                                  | Description                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `createEditor`            | `(container: HTMLElement, code: string, language: string) => Promise<MonacoEditorInstance>`                           | Create and mount a standalone editor                                                                                            |
| `createDiffEditor`        | `(container: HTMLElement, original: string, modified: string, language: string) => Promise<MonacoDiffEditorInstance>` | Create and mount a diff editor                                                                                                  |
| `cleanupEditor`           | `() => void`                                                                                                          | Dispose editor instances and cleanup resources                                                                                  |
| `safeClean`               | `() => void`                                                                                                          | Cancel pending update queues/RAFs without fully tearing down the integration                                                    |
| `updateCode`              | `(newCode: string, codeLanguage: string) => void`                                                                     | Update single-editor content and language                                                                                       |
| `appendCode`              | `(appendText: string, codeLanguage?: string) => void`                                                                 | Append to the single editor, optimized for streaming                                                                            |
| `updateDiff`              | `(original: string, modified: string, codeLanguage?: string) => void`                                                 | Update both sides of a diff editor                                                                                              |
| `updateOriginal`          | `(newCode: string, codeLanguage?: string) => void`                                                                    | Update only the original side                                                                                                   |
| `updateModified`          | `(newCode: string, codeLanguage?: string) => void`                                                                    | Update only the modified side                                                                                                   |
| `appendOriginal`          | `(appendText: string, codeLanguage?: string) => void`                                                                 | Append to the original side                                                                                                     |
| `appendModified`          | `(appendText: string, codeLanguage?: string) => void`                                                                 | Append to the modified side                                                                                                     |
| `setDiffModels`           | `(models: DiffModelPair, options?: DiffModelTransitionOptions) => Promise<void>`                                      | Swap the whole diff model pair in place; same-content swaps prewarm Monaco's diff view model and preserve view state by default |
| `setTheme`                | `(theme: MonacoTheme, force?: boolean) => Promise<void>`                                                              | Switch editor theme; `force=true` re-applies even if the theme is already active                                                |
| `refreshDiffPresentation` | `() => void`                                                                                                          | Recompute diff chrome / unchanged overlay presentation without remounting                                                       |
| `setLanguage`             | `(language: MonacoLanguage) => void`                                                                                  | Switch editor language                                                                                                          |
| `getCurrentTheme`         | `() => string`                                                                                                        | Get the current theme name                                                                                                      |
| `getEditor`               | `() => typeof monaco.editor`                                                                                          | Get Monaco's static editor API                                                                                                  |
| `getEditorView`           | `() => MonacoEditorInstance \| null`                                                                                  | Get the current standalone editor instance                                                                                      |
| `getDiffEditorView`       | `() => MonacoDiffEditorInstance \| null`                                                                              | Get the current diff editor instance                                                                                            |
| `getDiffModels`           | `() => DiffModels`                                                                                                    | Get both diff models                                                                                                            |
| `getMonacoInstance`       | `() => typeof monaco`                                                                                                 | Get the Monaco module instance                                                                                                  |
| `setUpdateThrottleMs`     | `(ms: number) => void`                                                                                                | Change `updateCode` throttling at runtime                                                                                       |
| `getUpdateThrottleMs`     | `() => number`                                                                                                        | Get the current `updateCode` throttle value                                                                                     |
| `getCode`                 | `() => MonacoCodeValue`                                                                                               | Get the latest code value from the current editor or diff editor                                                                |

##### Exported TypeScript helpers

The package exports named types for diff integration too:

- `UseMonacoReturn`
- `MonacoOptions`
- `MonacoTheme`
- `MonacoLanguage`
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

For a more complete integration walkthrough, see [Diff Integration Guide](docs/diff-integration.md).

#### Diff streaming highlight tip

Monaco's diff computation is async and cancels/restarts when models change. If you stream updates too frequently (e.g. per token / every frame), the diff may only finish once streaming stops, so the difference highlights appear "at the end".

- Set `diffUpdateThrottleMs` to let the diff worker complete intermediate computations during streaming.
- The library defaults to `50ms`.
- When `diffHideUnchangedRegions` is enabled, unchanged-region folding is deferred until diff streaming goes idle to avoid collapsing and re-expanding while content is still arriving.
- Set it to `0` to restore pure RAF batching (most responsive, but may delay diff highlights under heavy streaming).

### Install

```bash
pnpm add stream-monaco
# or
npm install stream-monaco
# or
yarn add stream-monaco
```

Note: Vue is optional. If you don't use Vue, you don't need to install it.

### Basic usage (Vue)

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

onMounted(async () => {
  if (codeEditor.value) {
    await createEditor(codeEditor.value, props.code, props.language)
  }
})

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

### Basic usage (React)

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

Note: Svelte, Solid, and Preact integrations follow the same pattern — create a container element, call `createEditor` on mount, and `cleanupEditor` on unmount.

### Full config example (Vue)

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
  themes: ['github-dark', 'github-light'],
  languages: ['javascript', 'typescript', 'python', 'vue', 'json'],
  MAX_HEIGHT: 500,
  readOnly: false,
  isCleanOnBeforeCreate: true,
  onBeforeCreate: (monaco) => {
    console.log('Monaco editor is about to be created', monaco)
    return []
  },
  fontSize: 14,
  lineNumbers: 'on',
  wordWrap: 'on',
  minimap: { enabled: false },
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    alwaysConsumeMouseWheel: false,
  },
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

async function switchTheme(theme: MonacoTheme) {
  await setTheme(theme)
  // await setTheme(theme, true) // force re-apply even if same
}

function switchLanguage(language: MonacoLanguage) {
  setLanguage(language)
}

function updateEditorCode(code: string, language: string) {
  updateCode(code, language)
}

const currentTheme = getCurrentTheme()
console.log('Current theme:', currentTheme)

const monacoEditor = getEditor()
console.log('Monaco editor API:', monacoEditor)

const editorInstance = getEditorView()
console.log('Editor instance:', editorInstance)

// Get current code from editor (useful after user manually edits)
function getCurrentCode() {
  const code = getCode()
  if (code) {
    console.log('Current code:', code)
    return code
  }
  return null
}
</script>

<template>
  <div>
    <div class="controls">
      <button @click="switchTheme('github-dark')">Dark</button>
      <button @click="switchTheme('github-light')">Light</button>
      <button @click="switchLanguage('typescript')">TypeScript</button>
      <button @click="switchLanguage('python')">Python</button>
    </div>
    <div ref="editorContainer" class="editor" />
  </div>
</template>
```

### Get current code (getCode)

After creating an editor, you can retrieve the current code content at any time using `getCode()`. This is especially useful when users manually edit the editor content:

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

// Get current code after updates or user edits
function handleSubmit() {
  const currentCode = getCode()
  if (currentCode) {
    console.log('Submitting code:', currentCode)
    // Send to API, save to storage, etc.
  }
}

// Update code programmatically
function replaceCode() {
  updateCode('console.log("world")', 'javascript')

  // Get the new code
  setTimeout(() => {
    const newCode = getCode()
    console.log('Updated code:', newCode)
  }, 100)
}
</script>

<template>
  <div>
    <div ref="container" class="editor" />
    <button @click="handleSubmit">Submit Code</button>
    <button @click="replaceCode">Replace Code</button>
  </div>
</template>
```

For Diff editors, `getCode()` returns both sides:

```ts
const { createDiffEditor, getCode } = useMonaco()

await createDiffEditor(container, 'old code', 'new code', 'javascript')

const codes = getCode()
// codes = { original: 'old code', modified: 'new code' }
```

### Diff editor quick start (Vue)

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
  // Collapse long unchanged regions automatically.
  diffHideUnchangedRegions: true,
  // Hover a changed hunk to show split upper/lower Revert/Stage actions.
  diffHunkActionsOnHover: true,
})

const original = `export function add(a: number, b: number) {\n  return a + b\n}`
const modified = `export function add(a: number, b: number) {\n  return a + b\n}\n\nexport function sub(a: number, b: number) {\n  return a - b\n}`

onMounted(async () => {
  if (container.value)
    await createDiffEditor(container.value, original, modified, 'typescript')
})
</script>

<template>
  <div ref="container" class="diff-editor" />
</template>
```

Diff UX options:

- `diffHideUnchangedRegions` (default `true`): fold unchanged ranges (can pass Monaco `hideUnchangedRegions` object).
- `diffLineStyle` (default `background`): choose the changed-line emphasis style. Use `bar` for a subtler review-style leading bar treatment.
- `diffAppearance` (default `auto`): controls the diff shell chrome; use `light` / `dark` to force the surface style while keeping token colors theme-driven.
- `diffUnchangedRegionStyle` (default `line-info`): choose collapsed unchanged-region rendering: `line-info`, `line-info-basic`, and `metadata` use compact 32px rows, while `line-info-basic` keeps the wider legacy rail and `simple` uses a tighter 28px row.
- `diffHunkActionsOnHover` (default `false`): explicitly set `true` to enable split upper/lower `Revert` and `Stage` on hunk hover.
- `onDiffHunkAction(context)` (optional): return `false` to intercept and skip built-in model edits.
- Built-in `Revert` / `Stage` only edit Monaco models locally. They do not run `git revert`, `git add`, or `git stash` unless you intercept `onDiffHunkAction` and connect your own backend flow.

Full integration guide:

- [Diff Integration Guide](docs/diff-integration.md)
- exported TS helpers include `UseMonacoReturn`, `DiffLineStyle`, `DiffAppearance`, `DiffUnchangedRegionStyle`, `DiffModels`, and `DiffHunkActionContext`

Example 1: enable unchanged folding + hover Revert/Stage

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

Example 2: fully intercept Revert/Stage and handle your own Git/stash/patch flow

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

    await saveHunkAction({
      action,
      side,
      range: lineChange,
      original: originalModel.getValue(),
      modified: modifiedModel.getValue(),
    })

    // false => skip built-in edit, fully controlled by user code
    // true/undefined => continue built-in edit
    return false
  },
})
```

Example 3: backend returns refreshed file contents, then the client calls `updateDiff(...)`

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

Important:

- Hover `Revert` is hunk-level undo, not `git revert <commit>`.
- Hover `Stage` is closer to `git add -p` / `git apply --cached`.
- If you want a stash flow, treat `onDiffHunkAction` as a patch-intent callback and hand the selected half-hunk to your backend stash or patch queue.
- If your backend returns refreshed file contents, `updateDiff(...)` is the most direct way to reflect the Git-applied result in the diff UI. The repo includes `pnpm run validate:diff-hunk-update-diff-flow` for that pattern.
- See [Diff Integration Guide](docs/diff-integration.md) for a concrete Git binding pattern.

Visual review helpers:

- `pnpm run shot:diff-ux -- background /tmp/stream-monaco-diff-reference.png pierre-reference`
  Captures the Pierre-like reference scene with a fixed viewport, file chrome, and `-1 / +1` single-hunk diff. Pass an optional fourth argument such as `snazzy-light`.
- `pnpm run compare:diff-ux -- /tmp/stream-monaco-diff-reference.png background pierre-reference`
  Re-captures the same scene and prints screenshot metrics such as `diffPixels`, `mismatchRatio`, and `exactMatch`. Pass an optional final theme argument to compare the exact same palette.

### Shiki highlighter (advanced)

If you also render Shiki snippets outside Monaco:

```ts
import { registerMonacoThemes } from 'stream-monaco'

const highlighter = await registerMonacoThemes(allThemes, allLanguages)

// later on theme switch
monaco.editor.setTheme('vitesse-dark')
await highlighter.setTheme('vitesse-dark')
// re-render snippets via highlighter.codeToHtml(...)
```

### Streaming performance tips

After 0.0.32, more fine-grained controls:

- `updateThrottleMs` (default 50): time-based throttle for `updateCode`. Set 0 for RAF-only.
- `minimalEditMaxChars`: cap for attempting minimal replace before falling back to `setValue`.
- `minimalEditMaxChangeRatio`: fallback to full replace when change ratio is high.

```ts
useMonaco({
  updateThrottleMs: 50,
  minimalEditMaxChars: 200000,
  minimalEditMaxChangeRatio: 0.25,
})
```

Auto-reveal options for streaming append:

- `revealDebounceMs` (default 75)
- `revealBatchOnIdleMs` (optional final reveal)
- `revealStrategy`: "bottom" | "centerIfOutside" (default) | "center"

For pure tail-append, prefer explicit `appendCode` / `appendOriginal` / `appendModified`.

### Best practices

1. Performance: only load required languages

```ts
const { createEditor } = useMonaco({
  languages: ['javascript', 'typescript'],
  themes: ['vitesse-dark', 'vitesse-light'],
})
```

2. Memory management: dispose on unmount

```vue
<script setup>
import { onUnmounted } from 'vue'
import { useMonaco } from 'stream-monaco'

const { cleanupEditor } = useMonaco()

onUnmounted(() => {
  cleanupEditor()
})
</script>
```

3. Follow system theme (via your own dark state) and call `setTheme` accordingly.

### Use without Vue (Vanilla)

You can use the core in any environment. Here's a plain TypeScript/HTML example:

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

// later
cleanupEditor()
```

```html
<div id="editor" style="height: 500px; border: 1px solid #e5e7eb;"></div>
<script type="module" src="/main.ts"></script>
```

### Migration notes

- v0.0.34+: Internal reactivity is implemented via a thin adapter over `alien-signals`, removing the hard dependency on Vue. Vue remains fully supported but is optional. No breaking changes to the public API.

### Troubleshooting

- Editor invisible after build: configure Monaco web workers correctly.
- Diff editor renders blank during early mount/streaming: ensure Monaco workers are configured before `createEditor`/`createDiffEditor` (e.g. call `preloadMonacoWorkers()` as early as possible).
- Theme not applied: ensure theme name is included in `themes`.
- Language highlighting missing: ensure the language is included and supported by Shiki.

#### Vue CLI 4 (Webpack 4)

Webpack 4 cannot parse `import.meta.url`. Use the `stream-monaco/legacy` entry (no `import.meta`) and configure Monaco workers in your app.

Recommended: use `monaco-editor-webpack-plugin`.

```bash
pnpm add -D monaco-editor-webpack-plugin
```

`vue.config.js`:

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

And call once early (e.g. `main.ts`):

```ts
import { preloadMonacoWorkers } from 'stream-monaco/legacy'

preloadMonacoWorkers()
```

If you load Monaco via CDN/AMD (e.g. `<script src=".../vs/loader.js">`), `stream-monaco/legacy` also includes a best-effort auto worker setup that creates a same-origin `blob:` worker and `importScripts()` Monaco’s `vs/base/worker/workerMain.js`. If auto-detection can’t find your Monaco base URL, call:

```ts
import { ensureMonacoWorkersLegacy } from 'stream-monaco/legacy'

ensureMonacoWorkersLegacy({
  baseUrl: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/',
})
```

### Development

```bash
git clone https://github.com/Simon-He95/stream-monaco.git
pnpm install
pnpm dev
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

## Acknowledgements

### Clearing shiki highlighter cache

The library caches Shiki highlighters internally to avoid recreating them for the same theme combinations. In long-running apps that dynamically create many combinations, you can clear the cache to free memory or reset state (e.g., in tests or on shutdown):

- `clearHighlighterCache()` — clears the internal cache
- `getHighlighterCacheSize()` — returns number of cached entries

Call `clearHighlighterCache()` only when highlighters are no longer needed; otherwise, the cache improves performance by reusing instances.
