import { createRouter, createWebHistory } from 'vue-router'
import DiffDemo from './DiffDemo.vue'
import DiffUXDemo from './DiffUXDemo.vue'
import StreamingDemo from './StreamingDemo.vue'

const routes = [
  { path: '/', name: 'stream', component: StreamingDemo },
  { path: '/diff', name: 'diff', component: DiffDemo },
  { path: '/diff-ux', name: 'diff-ux', component: DiffUXDemo },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
