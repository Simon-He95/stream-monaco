<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco,preloadMonacoWorkers } from 'stream-monaco'

const el = ref<HTMLElement | null>(null)
const {
  createEditor,
  appendCode,
  updateCode,
  setLanguage,
  cleanupEditor,
} = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['markdown', 'typescript'],
  readOnly: false,
  MAX_HEIGHT: 100,
})
preloadMonacoWorkers()
let i = 0
let timer: any
const markdown = `
# Streaming Demo
This demo shows how to stream code into the editor line by line.

You can see the code being appended every 300ms.

Feel free to modify the code or change the language after a few lines.

-- Enjoy!

`
const streamedLines = markdown.split('\n')
onMounted(async () => {
  if (!el.value)
    return

  await createEditor(el.value, streamedLines[0], 'markdown')
  timer = setInterval(() => {
    i++
    appendCode(`\n${streamedLines[i]}`)
    // if (i === 5)
      // setLanguage('typescript')
    if (i >= 10)
      clearInterval(timer)
  }, 300)
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
