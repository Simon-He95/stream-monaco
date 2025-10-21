## vue-use-monaco

[![NPM version](https://img.shields.io/npm/v/vue-use-monaco?color=a1b858&label=)](https://www.npmjs.com/package/vue-use-monaco)
[![中文版](https://img.shields.io/badge/docs-中文文档-blue)](README.zh-CN.md)
[![NPM downloads](https://img.shields.io/npm/dm/vue-use-monaco)](https://www.npmjs.com/package/vue-use-monaco)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/vue-use-monaco)](https://bundlephobia.com/package/vue-use-monaco)
[![License](https://img.shields.io/npm/l/vue-use-monaco)](./LICENSE)

### Introduction

vue-use-monaco is a Vue 3 composable that integrates Monaco Editor with Shiki syntax highlighting, optimized for streaming updates and efficient highlighting. It provides a complete Monaco integration suitable for real-time editing and theming.

IMPORTANT: Since v0.0.32, `updateCode` is time-throttled by default (`updateThrottleMs = 50`) to reduce CPU usage under high-frequency streaming. Set `updateThrottleMs: 0` in `useMonaco()` options to restore previous RAF-only behavior.

### Features

- 🚀 Ready to use with Vue 3 Composition API
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

Note: If you only use Monaco and pass all `themes` to `createEditor`, typically just call `monaco.editor.setTheme(themeName)`.

Config: `useMonaco()` does not auto-sync an external Shiki highlighter; if you need external Shiki snippets to follow theme changes, call `getOrCreateHighlighter(...)` and `highlighter.setTheme(...)` yourself.

### Install

```bash
pnpm add vue-use-monaco
# or
npm install vue-use-monaco
# or
yarn add vue-use-monaco
```

### Basic usage

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

### Full config example

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
</script>

<template>
  <div>
    <div class="controls">
      <button @click="switchTheme('github-dark')">
        Dark
      </button>
      <button @click="switchTheme('github-light')">
        Light
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

### Diff editor quick start

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
  if (container.value)
    await createDiffEditor(container.value, original, modified, 'typescript')
})
</script>

<template>
  <div ref="container" class="diff-editor" />
</template>
```

### Shiki highlighter (advanced)

If you also render Shiki snippets outside Monaco:

```ts
import { registerMonacoThemes } from 'vue-use-monaco'

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

1) Performance: only load required languages

```ts
const { createEditor } = useMonaco({
  languages: ['javascript', 'typescript'],
  themes: ['vitesse-dark', 'vitesse-light'],
})
```

2) Memory management: dispose on unmount

```vue
<script setup>
import { onUnmounted } from 'vue'
import { useMonaco } from 'vue-use-monaco'

const { cleanupEditor } = useMonaco()

onUnmounted(() => {
  cleanupEditor()
})
</script>
```

3) Follow system theme (via your own dark state) and call `setTheme` accordingly.

### Troubleshooting

- Editor invisible after build: configure Monaco web workers correctly.
- Theme not applied: ensure theme name is included in `themes`.
- Language highlighting missing: ensure the language is included and supported by Shiki.

### Development

```bash
git clone https://github.com/Simon-He95/vue-use-monaco.git
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
