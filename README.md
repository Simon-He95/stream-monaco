## stream-monaco

[![NPM version](https://img.shields.io/npm/v/stream-monaco?color=a1b858&label=)](https://www.npmjs.com/package/stream-monaco)
[![中文版](https://img.shields.io/badge/docs-中文文档-blue)](README.zh-CN.md)
[![NPM downloads](https://img.shields.io/npm/dm/stream-monaco)](https://www.npmjs.com/package/stream-monaco)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/stream-monaco)](https://bundlephobia.com/package/stream-monaco)
[![License](https://img.shields.io/npm/l/stream-monaco)](./LICENSE)

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

Note: If you only use Monaco and pass all `themes` to `createEditor`, typically just call `monaco.editor.setTheme(themeName)`.

Config: `useMonaco()` does not auto-sync an external Shiki highlighter; if you need external Shiki snippets to follow theme changes, call `getOrCreateHighlighter(...)` and `highlighter.setTheme(...)` yourself.

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
    if (containerRef.current)
      createEditor(containerRef.current, 'console.log("Hello, Monaco!")', 'typescript')
    return () => cleanupEditor()
  }, [])

  return <div ref={containerRef} style={{ height: 500, border: '1px solid #e0e0e0' }} />
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
import { useMonaco } from 'stream-monaco'

const { cleanupEditor } = useMonaco()

onUnmounted(() => {
  cleanupEditor()
})
</script>
```

3) Follow system theme (via your own dark state) and call `setTheme` accordingly.

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

The library also exposes `isDark` (a small reactive ref) that follows `<html class="dark">` or the system color-scheme. Theme switching inside the editor is handled automatically.

### Migration notes

- v0.0.34+: Internal reactivity is implemented via a thin adapter over `alien-signals`, removing the hard dependency on Vue. Vue remains fully supported but is optional. No breaking changes to the public API.

### Troubleshooting

- Editor invisible after build: configure Monaco web workers correctly.
- Theme not applied: ensure theme name is included in `themes`.
- Language highlighting missing: ensure the language is included and supported by Shiki.

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
