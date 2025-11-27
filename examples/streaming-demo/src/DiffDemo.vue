<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMonaco, preloadMonacoWorkers } from '../../../src/index'

const el = ref<HTMLElement | null>(null)
const {
  createDiffEditor,
  updateDiff,
  appendModified,
  appendOriginal,
  getDiffModels,
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
    i += 50
    if (i >= combined.length) {
      clearInterval(timer)
      return
    }
    const next = combined.slice(0, i)
    const prevOriginal = original.slice(0, i)
    updateDiff(prevOriginal, next, 'typescript')
  }, 400)
})

// Stress test controls
const running = ref(false)
const result = ref<string | null>(null)
async function runStressTest({ iterations = 2000, blockSize = 50, intervalMs = 1 } = {}) {
  if (!el.value) return
  if (running.value) return
  running.value = true
  result.value = null
  // prepare base block and expected
  const block = rightBase.repeat(Math.ceil(blockSize / rightBase.length)).slice(0, blockSize)
  let expected = ''
  // ensure editor is initialized to small values
  await createDiffEditor(el.value, original.slice(0, 1), modified.slice(0, 1), 'typescript')
  for (let j = 0; j < iterations; j++) {
    expected += block
    updateDiff(original.slice(0, Math.min(expected.length, original.length)), expected, 'typescript')
    // yield to event loop and respect interval
    await new Promise(r => setTimeout(r, intervalMs))
  }
  // wait for final flush
  await new Promise(r => setTimeout(r, 500))
  try {
    const models = getDiffModels()
    const actual = models.modified?.getValue() ?? ''
    if (actual === expected) {
      result.value = `PASS - length ${actual.length}`
    }
    else {
      // find first mismatch
      let idx = 0
      while (idx < Math.min(actual.length, expected.length) && actual[idx] === expected[idx]) idx++
      result.value = `FAIL at ${idx} (expected ${expected.length}, actual ${actual.length})`
    }
  }
  catch (err) {
    result.value = `ERROR: ${String(err)}`
  }
  running.value = false
}
</script>

<template>
  <div>
    <div ref="el" class="editor" />
    <div class="actions">
      <button @click="cleanupEditor">Dispose</button>
      <button @click.prevent="runStressTest({ iterations: 2000, blockSize: 50, intervalMs: 1 })" :disabled="running">Run Stress (1ms,50ch x2000)</button>
      <button @click.prevent="runStressTest({ iterations: 2000, blockSize: 50, intervalMs: 4 })" :disabled="running">Run Stress (4ms)</button>
      <div style="margin-top:8px">Result: {{ result ?? 'n/a' }}</div>
    </div>
  </div>
</template>

<style scoped>
.editor { border: 1px solid #e0e0e0; border-radius: 4px; }
.actions { margin-top: 12px }
button { padding: 6px 10px }
</style>
