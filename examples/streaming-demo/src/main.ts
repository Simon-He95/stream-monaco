import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import 'monaco-editor/min/vs/editor/editor.main.css'

createApp(App).use(router).mount('#app')
