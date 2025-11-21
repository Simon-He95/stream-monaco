import { createRouter, createWebHistory } from 'vue-router'
import DiffDemo from './DiffDemo.vue'
import StreamingDemo from './StreamingDemo.vue'

const routes = [
  { path: '/', name: 'stream', component: StreamingDemo },
  { path: '/diff', name: 'diff', component: DiffDemo },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
