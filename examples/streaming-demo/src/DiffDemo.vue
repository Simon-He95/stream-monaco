<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco, preloadMonacoWorkers } from '../../../src/index'

const el = ref<HTMLElement | null>(null)
const {
  createDiffEditor,
  updateDiff,
  appendModified,
  appendOriginal,
  cleanupEditor,
} = useMonaco({
  // options forwarded to monaco
  wordWrap: 'on',
  wrappingIndent: 'same',
  themes: ['vitesse-dark', 'vitesse-light'],
  languages: ['markdown', 'typescript'],
  readOnly: true,
  MAX_HEIGHT: 400,
})
preloadMonacoWorkers()

let timer: any
const leftBase = `// original file\nfunction hello() {\n  console.log(\"hello world\")\n}\n`
const rightBase = `// modified file\nfunction hello(name) {\n  console.log('hello ' + name)\n}\n`
const repeat = 400
let original = Array.from({ length: repeat }).map(() => leftBase).join('\n')
let modified = Array.from({ length: repeat }).map(() => rightBase).join('\n')

onMounted(async () => {
  if (!el.value) return
  await createDiffEditor(el.value, original.slice(0, 1), modified.slice(0, 1), 'typescript')
  // gradually append to simulate streaming diffs
  let i = 0
  const combined = modified
  timer = setInterval(() => {
    i += 10
    if (i >= combined.length) {
      clearInterval(timer)
      return
    }
    const next = combined.slice(0, i)
    const prevOriginal = original.slice(0, i)
    updateDiff(prevOriginal, next, 'typescript')
  }, 40)
})
</script>

<template>
  <div>
    <div ref="el" class="editor" />
    <div class="actions">
      <button @click="cleanupEditor">Dispose</button>
    </div>
  </div>
</template>

<style scoped>
.editor { border: 1px solid #e0e0e0; border-radius: 4px; }
.actions { margin-top: 12px }
button { padding: 6px 10px }
</style>
