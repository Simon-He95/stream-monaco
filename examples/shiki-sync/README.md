# Example: Monaco + Shiki theme sync

This minimal example shows how to keep Monaco editor themes and standalone Shiki-rendered code snippets in sync.

Goal

- Register (or pre-register) themes and languages for both Monaco and Shiki.
- Optionally reuse the returned Shiki highlighter from `registerMonacoThemes` for rendering HTML snippets.

Files

- A simple Vue component (see snippet below) that:
  - calls `registerMonacoThemes` to preload themes & languages,
  - creates an editor and uses a preloaded Shiki highlighter for manual preview rendering,
  - switches theme via `setTheme` and also renders a Shiki HTML snippet using the returned highlighter.

Quick steps

1. Create a new Vite + Vue project (or use the existing `examples/streaming-demo` as base).
2. Install package dependencies (you need `vue`, `monaco-editor`, `shiki`, and this library locally or from npm).
3. Add the component below and run the dev server.

Running the example

- From the repository root (recommended with pnpm workspaces):

```bash
pnpm install
pnpm --filter ./examples/shiki-sync dev
```

- Or inside the example directory:

```bash
cd examples/shiki-sync
pnpm install
pnpm dev
```

Retry behavior

- The example UI shows a small "Retry" button if loading themes fails (e.g. network or build issue). Click it to re-attempt preloading themes & languages.

Vue component (single-file component)

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { registerMonacoThemes, useMonaco } from 'stream-monaco'

const container = ref<HTMLElement | null>(null)
const preview = ref<HTMLDivElement | null>(null)

const allThemes = ['vitesse-dark', 'vitesse-light']
const allLanguages = ['javascript']

// preload themes & languages and get a shiki highlighter
let shikiHighlighter: any = null
onMounted(async () => {
  shikiHighlighter = await registerMonacoThemes(allThemes, allLanguages)
})

const { createEditor, setTheme } = useMonaco({
  themes: allThemes,
  languages: allLanguages,
})

onMounted(async () => {
  if (container.value) {
    await createEditor(container.value, 'console.log("hello world")', 'javascript')
  }
})

function applyShikiRender(themeName: string) {
  if (!shikiHighlighter || !preview.value)
    return
  try {
    const html = shikiHighlighter.codeToHtml('console.log("hello world")', { lang: 'javascript', theme: themeName })
    preview.value.innerHTML = html
  }
  catch (e) {
    // fallback: highlighter may not support codeToHtml in some builds; try setTheme instead
    try {
      shikiHighlighter.setTheme(themeName)
      // user should re-render their snippets accordingly
    }
    catch { }
  }
}

function switchToDark() {
  setTheme('vitesse-dark')
  applyShikiRender('vitesse-dark')
}

function switchToLight() {
  setTheme('vitesse-light')
  applyShikiRender('vitesse-light')
}
</script>

<template>
  <div>
    <div class="controls">
      <button @click="switchToDark">
        Dark
      </button>
      <button @click="switchToLight">
        Light
      </button>
    </div>

    <div ref="container" style="height:300px;border:1px solid #ddd;margin-top:12px" />

    <h3>Shiki preview</h3>
    <div ref="preview" />
  </div>
</template>

<style scoped>
.controls { display:flex; gap:8px }
</style>
```

Notes

- `registerMonacoThemes` now returns the Shiki highlighter Promise — you can reuse it to render static snippets or to call `setTheme` on the highlighter directly.
If you need to keep standalone Shiki-rendered snippets in sync when changing the editor theme, call `registerMonacoThemes(...)` to obtain the Shiki highlighter and then call its `setTheme(...)` / `codeToHtml(...)` methods yourself. The example demonstrates preloading and manual usage.
- If you preload a *full* set of themes & languages at app start, the library will reuse the same highlighter instance and avoid re-creating it on theme changes.

Troubleshooting

- If Shiki's `codeToHtml` isn't exposed on the highlighter build you use (some builds differ), you can still call `setTheme` on the highlighter and re-run your own rendering pipeline.
- For large numbers of themes/languages, consider on-demand loading to reduce startup cost: preload the common ones and lazily call `registerMonacoThemes` for others.
