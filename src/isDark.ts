import { ref } from './reactivity'

export const isDark = ref(false)

function computeIsDark(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return false
  const el = document.documentElement
  const hasClass = el.classList?.contains('dark') ?? false
  const mql = window.matchMedia?.('(prefers-color-scheme: dark)')
  const prefersDark = !!mql?.matches
  // 优先 DOM 上的显式 dark 类，否则跟随系统
  return hasClass || prefersDark
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const el = document.documentElement
  const mql = window.matchMedia?.('(prefers-color-scheme: dark)')
  const update = () => {
    isDark.value = computeIsDark()
  }

  // 初始化
  update()

  // 监听系统主题变化
  const onMqlChange = () => update()
  if (mql) {
    // Safari 旧版兼容
    mql.addEventListener
      ? mql.addEventListener('change', onMqlChange)
      : mql.addListener(onMqlChange)
  }

  // 监听 <html> 的 class 变化（如切换 Tailwind 的 dark 类）
  const mo = new MutationObserver(update)
  mo.observe(el, { attributes: true, attributeFilter: ['class'] })

  // 页面卸载时清理监听器
  const cleanup = () => {
    if (mql) {
      mql.removeEventListener
        ? mql.removeEventListener('change', onMqlChange)
        : mql.removeListener(onMqlChange)
    }
    mo.disconnect()
    window.removeEventListener('pagehide', cleanup)
    window.removeEventListener('beforeunload', cleanup)
  }
  window.addEventListener('pagehide', cleanup)
  window.addEventListener('beforeunload', cleanup)
}
