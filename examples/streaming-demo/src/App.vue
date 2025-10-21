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
const markdown = `
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
let contents = ''
onMounted(async () => {
  if (!el.value)
    return

  await createEditor(el.value, contents, "shellscript")
  timer = setInterval(() => {
    if(i>markdown.length){
      clearInterval(timer)
      return
    }
    i++
    contents = markdown.slice(0, i)
    updateCode(contents,"shellscript")
    // if (i === 5)
      // setLanguage('typescript')
    // if (i >= 10)
    //   clearInterval(timer)
  }, 0)
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
