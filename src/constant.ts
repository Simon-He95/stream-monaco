import type { MonacoTheme } from './type'

export const defaultLanguages = [
  'jsx',
  'tsx',
  'vue',
  'csharp',
  'python',
  'java',
  'c',
  'cpp',
  'rust',
  'go',
  'powershell',
  'sql',
  'json',
  'html',
  'javascript',
  'typescript',
  'css',
  'markdown',
  'xml',
  'yaml',
  'toml',
  'dockerfile',
  'kotlin',
  'objective-c',
  'objective-cpp',
  'php',
  'ruby',
  'scala',
  'svelte',
  'swift',
  'erlang',
  'angular-html',
  'angular-ts',
  'dart',
  'lua',
  'mermaid',
  'cmake',
  'nginx',
]
export const defaultThemes: MonacoTheme[] = ['vitesse-dark', 'vitesse-light']
export const defaultScrollbar = {
  verticalScrollbarSize: 8,
  horizontalScrollbarSize: 8,
  handleMouseWheel: true,
  /**
   * 是否始终消费鼠标滚轮事件，默认为 false
   * 如果为 true，则鼠标滚轮事件不会传递给其他元素
   */
  alwaysConsumeMouseWheel: false,
}
export const padding = 16

// default debounce for reveal (ms) used when revealDebounceMs is not provided
export const defaultRevealDebounceMs = 75
// Default idle batching for reveal: when set, many small appends will delay
// the final "scroll to bottom" until this idle period has passed. A higher
// value reduces layout churn during rapid streaming. Default: 200ms.
export const defaultRevealBatchOnIdleMs = 200
// When strings exceed this length, avoid expensive character-by-character
// minimal edit computation and instead perform a full model.setValue(). This
// avoids O(n) CPU on extremely large documents during frequent updates.
export const minimalEditMaxChars = 200_000
// If the absolute length difference between prev and next exceeds this ratio
// of the larger string, prefer full setValue to avoid long scans.
export const minimalEditMaxChangeRatio = 0.5
