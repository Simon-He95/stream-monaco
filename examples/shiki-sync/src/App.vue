<script setup lang="ts">
import type { ShikiHighlighter } from '../../../src'
import { onMounted, ref } from 'vue'
import { registerMonacoThemes, useMonaco } from '../../../src'

const container = ref<HTMLElement | null>(null)
const preview = ref<HTMLDivElement | null>(null)

const allThemes = [
  'andromeeda',
  'aurora-x',
  'ayu-dark',
  'catppuccin-frappe',
  'catppuccin-latte',
  'catppuccin-macchiato',
  'catppuccin-mocha',
  'dark-plus',
  'dracula',
  'dracula-soft',
  'everforest-dark',
  'everforest-light',
  'github-dark',
  'github-dark-default',
  'github-dark-dimmed',
  'github-dark-high-contrast',
  'github-light',
  'github-light-default',
  'github-light-high-contrast',
  'gruvbox-dark-hard',
  'gruvbox-dark-medium',
  'gruvbox-dark-soft',
  'gruvbox-light-hard',
  'gruvbox-light-medium',
  'gruvbox-light-soft',
  'houston',
  'kanagawa-dragon',
  'kanagawa-lotus',
  'kanagawa-wave',
  'laserwave',
  'light-plus',
  'material-theme',
  'material-theme-darker',
  'material-theme-lighter',
  'material-theme-ocean',
  'material-theme-palenight',
  'min-dark',
  'min-light',
  'monokai',
  'night-owl',
  'nord',
  'one-dark-pro',
  'one-light',
  'plastic',
  'poimandres',
  'red',
  'rose-pine',
  'rose-pine-dawn',
  'rose-pine-moon',
  'slack-dark',
  'slack-ochin',
  'snazzy-light',
  'solarized-dark',
  'solarized-light',
  'synthwave-84',
  'tokyo-night',
  'vesper',
  'vitesse-black',
  'vitesse-dark',
  'vitesse-light',
]
const allLanguages = ['javascript']

let shikiHighlighter: ShikiHighlighter | null = null
const loading = ref(false)
const error = ref<string | null>(null)
const selectedTheme = ref<string>(allThemes[0])

onMounted(async () => {
  loading.value = true
  error.value = null
  try {
    shikiHighlighter = await registerMonacoThemes(allThemes, allLanguages)
  }
  catch (e: any) {
    error.value = e?.message || String(e)
  }
  finally {
    loading.value = false
  }
})

async function retryLoad() {
  loading.value = true
  error.value = null
  try {
    shikiHighlighter = await registerMonacoThemes(allThemes, allLanguages)
  }
  catch (e: any) {
    error.value = e?.message || String(e)
  }
  finally {
    loading.value = false
  }
}

const { createEditor, setTheme } = useMonaco({
  themes: allThemes,
  languages: allLanguages,
  theme: selectedTheme.value,
})

onMounted(async () => {
  if (container.value) {
    await createEditor(container.value, 'console.log("hello world")', 'javascript')
    // apply initial theme to preview once editor created
    applyShikiRender(selectedTheme.value)
  }
})

function applyShikiRender(themeName: string) {
  if (!shikiHighlighter || !preview.value)
    return

  try {
    const html = shikiHighlighter.codeToHtml('console.log("hello world")', { lang: 'javascript', theme: themeName })
    preview.value.innerHTML = html
  }
  catch {
    try {
      shikiHighlighter.setTheme(themeName)
    }
    catch { }
  }
}

function onThemeChange(theme: string) {
  selectedTheme.value = theme
  setTheme(theme)
  applyShikiRender(theme)
}

function onThemeSelectChange(e: Event) {
  const el = e.target as HTMLSelectElement | null
  if (!el)
    return
  onThemeChange(el.value)
}
</script>

<template>
  <div style="padding:16px">
    <div class="controls">
      <label for="theme-select">Theme:</label>
      <select id="theme-select" v-model="selectedTheme" :disabled="loading || !!error" @change="onThemeSelectChange">
        <option v-for="t in allThemes" :key="t" :value="t">
          {{ t }}
        </option>
      </select>
      <span v-if="loading" style="margin-left:8px">Loading themes...</span>
      <span v-if="error" style="margin-left:8px;color:crimson">Error: {{ error }}</span>
      <button v-if="error" style="margin-left:8px" @click="retryLoad">
        Retry
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
