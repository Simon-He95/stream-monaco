<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco, preloadMonacoWorkers } from '../../../src/index'

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

  await createEditor(el.value, contents, 'shellscript')
  // append faster in small chunks so the editor fills quickly and scrollbar appears
  timer = setInterval(() => {
    if (i >= markdown.length) {
      clearInterval(timer)
      return
    }
    // increase by a few chars per tick for visible streaming without being too slow
    i += 100
    contents = markdown.slice(0, Math.min(i, markdown.length))
    updateCode(contents, 'shellscript')
  }, 4)
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
