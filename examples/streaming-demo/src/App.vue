<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco } from 'stream-monaco'

const el = ref<HTMLElement | null>(null)
const {
  createEditor,
  appendCode,
  setLanguage,
  cleanupEditor,
} = useMonaco({
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['markdown', 'typescript'],
  readOnly: false,
  MAX_HEIGHT: 100,
})

let i = 0
let timer: any

onMounted(async () => {
  if (!el.value)
    return
  await createEditor(el.value, '# Stream start\n', 'markdown')
  timer = setInterval(() => {
    i++
    appendCode(`- line ${i}\n`)
    if (i === 5)
      setLanguage('typescript')
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
