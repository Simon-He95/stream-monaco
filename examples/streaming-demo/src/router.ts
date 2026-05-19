import { createRouter, createWebHistory } from 'vue-router'
import DiffDemo from './DiffDemo.vue'
import DiffUXDemo from './DiffUXDemo.vue'
import HeightStabilityDemo from './HeightStabilityDemo.vue'
import StreamingDemo from './StreamingDemo.vue'

const routes = [
  { path: '/', name: 'stream', component: StreamingDemo },
  { path: '/diff', name: 'diff', component: DiffDemo },
  { path: '/diff-ux', name: 'diff-ux', component: DiffUXDemo },
  { path: '/height-stability', name: 'height-stability', component: HeightStabilityDemo },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
