<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco, preloadMonacoWorkers } from '../../../src/index'

const perf: any = (globalThis as any).__streamMonacoPerf ??= {
  marks: [],
  mark(name: string, detail?: Record<string, any>) {
    if (typeof performance === 'undefined')
      return
    this.marks.push({ name, t: performance.now(), ...detail })
  },
}

function mark(name: string, detail?: Record<string, any>) {
  try {
    perf.mark(name, detail)
  }
  catch {}
}

mark('module_init')

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !perf._observerInstalled) {
  perf._observerInstalled = true
  try {
    let firstTextLen = -1
    const markOnce = (name: string, detail?: Record<string, any>) => {
      if (perf.marks.some((m: any) => m.name === name))
        return
      mark(name, detail)
    }
    const obs = new MutationObserver(() => {
      const editor = document.querySelector('.monaco-editor')
      if (editor)
        markOnce('monaco_dom')
      const view = document.querySelector('.monaco-editor .view-lines')
      const text = view?.textContent ?? ''
      const len = text.trim().length
      if (len > 0)
        markOnce('view_lines_text', { len })
      if (len > 0) {
        if (firstTextLen === -1)
          firstTextLen = len
        else if (len > firstTextLen)
          markOnce('view_lines_text_growth', { len })
      }
    })
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  }
  catch {}

  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any) {
        if (entry && entry.duration && entry.duration > 50) {
          perf.longTasks = (perf.longTasks || 0) + 1
        }
      }
    })
    obs.observe({ type: 'longtask', buffered: true })
  }
  catch {}
}

const el = ref<HTMLElement | null>(null)
const {
  createEditor,
  appendCode,
  updateCode,
  setLanguage,
  cleanupEditor,
} = useMonaco({
  wordWrap: 'on',
  wrappingIndent: 'same',
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['markdown', 'typescript'],
  readOnly: true,
  MAX_HEIGHT: 400,
})
preloadMonacoWorkers()
mark('preload_workers_called')
let i = 0
let timer: any
const base = `
# Create Vue project
npm create vue@latest electron-vue-chat

# Navigate to project
cd electron-vue-chat

# Install dependencies
npm install
npm install electron electron-builder vue-router

# Install dev dependencies
npm install -D electron-dev-server concurrently wait-on
`
// repeat the base chunk to create a large test document so the editor shows a scrollbar
const repeatCount = 120
const markdown = Array.from({ length: repeatCount }).map(() => base).join('\n')
let contents = ''
onMounted(async () => {
  if (!el.value)
    return

  mark('onMounted_start')
  mark('createEditor_start')
  await createEditor(el.value, contents, 'shellscript')
  mark('createEditor_done')
  // append faster in small chunks so the editor fills quickly and scrollbar appears
  timer = setInterval(() => {
    if (i >= markdown.length) {
      clearInterval(timer)
      mark('stream_done', { len: contents.length })
      return
    }
    // increase by a few chars per tick for visible streaming without being too slow
    i += 50
    contents = markdown.slice(0, Math.min(i, markdown.length))
    if (i === 50)
      mark('stream_first_update', { len: contents.length })
    updateCode(contents, 'shellscript')
  }, 40)
})
</script>

<template>
  <div>
    <div ref="el" class="editor" />
    <div class="actions">
      <button @click="cleanupEditor">
        Dispose
      </button>
    </div>
  </div>
</template>

<style scoped>
.editor {
  border: 1px solid #e0e0e0;
  border-radius: 4px;
}
.actions { margin-top: 12px; }
button { padding: 6px 10px; }
</style>
