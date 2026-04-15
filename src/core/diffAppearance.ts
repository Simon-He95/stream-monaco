import type * as monaco from '../monaco-shim'

type DiffAppearance = 'light' | 'dark'
type DiffAppearanceOption = DiffAppearance | 'auto' | undefined

interface DiffUnchangedLineInfoRailMetrics {
  leftInset: number
  width: number | null
}

interface ApplyDiffRootAppearanceClassOptions {
  container: HTMLElement | null
  diffEditorView: monaco.editor.IStandaloneDiffEditor | null
  diffAppearance: DiffAppearanceOption
  themeName: string | null | undefined
  currentSignature: string | null
  lineStyle: 'background' | 'bar'
  unchangedRegionStyle: 'line-info' | 'line-info-basic' | 'metadata' | 'simple'
  isInlineMode: boolean
  lineStyleClasses: readonly string[]
  unchangedRegionStyleClasses: readonly string[]
  layoutModeClasses: readonly string[]
  appearanceClasses: readonly string[]
}

function parseCssColorRgb(color: string): [number, number, number] | null {
  const normalized = color.trim().toLowerCase()
  const rgbMatch = normalized.match(
    /^rgba?\(\s*([+\-.\d]+)\s*,\s*([+\-.\d]+)\s*,\s*([+\-.\d]+)/,
  )
  if (rgbMatch) {
    return [
      Number.parseFloat(rgbMatch[1]),
      Number.parseFloat(rgbMatch[2]),
      Number.parseFloat(rgbMatch[3]),
    ]
  }

  const hexMatch = normalized.match(/^#([\da-f]{3,8})$/i)
  if (!hexMatch)
    return null

  const hex = hexMatch[1]
  if (hex.length === 3 || hex.length === 4) {
    return [
      Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    ]
  }
  if (hex.length === 6 || hex.length === 8) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ]
  }
  return null
}

function resolveCssColorLuminance(color: string): number | null {
  const rgb = parseCssColorRgb(color)
  if (!rgb)
    return null

  const channel = (value: number) => {
    const normalized = Math.max(0, Math.min(255, value)) / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }

  const [r, g, b] = rgb
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function looksLikeDarkThemeName(themeName: string | null | undefined) {
  if (!themeName)
    return false
  const normalized = themeName.toLowerCase()
  return (
    [
      'dark',
      'night',
      'moon',
      'black',
      'dracula',
      'mocha',
      'frappe',
      'macchiato',
      'palenight',
      'ocean',
      'poimandres',
      'monokai',
      'laserwave',
      'tokyo',
      'slack-dark',
      'rose-pine',
      'github-dark',
      'material-theme',
      'one-dark',
      'catppuccin-mocha',
      'catppuccin-frappe',
      'catppuccin-macchiato',
    ].some(token => normalized.includes(token))
    && !normalized.includes('light')
    && !normalized.includes('latte')
    && !normalized.includes('dawn')
    && !normalized.includes('lotus')
  )
}

function looksLikeLightThemeName(themeName: string | null | undefined) {
  if (!themeName)
    return false
  const normalized = themeName.toLowerCase()
  return [
    'light',
    'day',
    'dawn',
    'latte',
    'solarized-light',
    'github-light',
    'rose-pine-dawn',
    'catppuccin-latte',
    'one-light',
    'vitesse-light',
    'snazzy-light',
    'material-lighter',
    'material-theme-lighter',
    'lotus',
  ].some(token => normalized.includes(token))
}

function resolveDiffAppearance({
  container,
  diffAppearance,
  diffEditorView,
  themeName,
}: Pick<
  ApplyDiffRootAppearanceClassOptions,
  'container' | 'diffAppearance' | 'diffEditorView' | 'themeName'
>): DiffAppearance {
  if (diffAppearance === 'light')
    return 'light'
  if (diffAppearance === 'dark')
    return 'dark'

  if (looksLikeDarkThemeName(themeName))
    return 'dark'
  if (looksLikeLightThemeName(themeName))
    return 'light'

  const appearanceProbeNodes = [
    diffEditorView?.getModifiedEditor().getContainerDomNode?.(),
    diffEditorView?.getOriginalEditor().getContainerDomNode?.(),
    container,
  ]

  for (const node of appearanceProbeNodes) {
    if (!(node instanceof HTMLElement))
      continue
    const style = globalThis.getComputedStyle(node)
    const editorSurface = node.querySelector<HTMLElement>(
      '.monaco-editor .monaco-editor-background, .monaco-editor .margin, .monaco-editor .lines-content',
    )
    const candidates = [
      style.getPropertyValue('--stream-monaco-editor-bg'),
      style.getPropertyValue('--vscode-editor-background'),
      editorSurface
        ? globalThis.getComputedStyle(editorSurface).backgroundColor
        : '',
      style.backgroundColor,
    ]
    for (const color of candidates) {
      const luminance = resolveCssColorLuminance(color)
      if (luminance == null)
        continue
      return luminance <= 0.42 ? 'dark' : 'light'
    }
  }

  return looksLikeDarkThemeName(themeName) ? 'dark' : 'light'
}

function syncDiffRootThemeVariables(
  container: HTMLElement,
  diffEditorView: monaco.editor.IStandaloneDiffEditor | null,
  appearance: DiffAppearance,
) {
  const probeNodes = [
    diffEditorView?.getModifiedEditor().getContainerDomNode?.(),
    diffEditorView?.getOriginalEditor().getContainerDomNode?.(),
    container,
  ]

  const containerStyle = globalThis.getComputedStyle(container)
  const fixedBackgroundColor = containerStyle
    .getPropertyValue('--stream-monaco-fixed-editor-bg')
    .trim() || null

  let backgroundColor: string | null = null
  let foregroundColor: string | null = null

  for (const node of probeNodes) {
    if (!(node instanceof HTMLElement))
      continue
    const backgroundProbe = node.querySelector<HTMLElement>(
      '.monaco-editor-background, .margin, .lines-content',
    ) ?? node
    const foregroundProbe = node.querySelector<HTMLElement>(
      '.view-lines, .monaco-editor, .view-overlays',
    ) ?? node

    const nextBackground = globalThis.getComputedStyle(backgroundProbe)
      .backgroundColor
    if (
      !backgroundColor
      && resolveCssColorLuminance(nextBackground) != null
    ) {
      backgroundColor = nextBackground
    }

    const nextForeground = globalThis.getComputedStyle(foregroundProbe).color
    if (
      !foregroundColor
      && resolveCssColorLuminance(nextForeground) != null
    ) {
      foregroundColor = nextForeground
    }

    if (backgroundColor && foregroundColor)
      break
  }

  const resolvedBackgroundColor = fixedBackgroundColor
    || backgroundColor
    || (appearance === 'dark' ? 'rgb(10 10 11)' : 'rgb(255 255 255)')

  if (resolvedBackgroundColor) {
    container.style.setProperty(
      '--stream-monaco-editor-bg',
      resolvedBackgroundColor,
    )
  }
  else {
    container.style.removeProperty('--stream-monaco-editor-bg')
  }

  if (foregroundColor) {
    container.style.setProperty('--stream-monaco-editor-fg', foregroundColor)
  }
  else {
    container.style.removeProperty('--stream-monaco-editor-fg')
  }
}

export function resolveDiffUnchangedLineInfoRailMetrics(
  node: HTMLElement,
): DiffUnchangedLineInfoRailMetrics {
  const editorRoot = node.closest<HTMLElement>('.monaco-editor')
  if (!editorRoot) {
    return {
      leftInset: 0,
      width: null,
    }
  }

  const editorRect = editorRoot.getBoundingClientRect()
  const lineNumberNode = Array.from(
    editorRoot.querySelectorAll<HTMLElement>('.line-numbers'),
  ).find((candidate) => {
    const rect = candidate.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  if (!lineNumberNode) {
    return {
      leftInset: 0,
      width: null,
    }
  }

  const lineNumberRect = lineNumberNode.getBoundingClientRect()
  return {
    leftInset: Math.max(0, lineNumberRect.left - editorRect.left),
    width: Math.max(0, lineNumberRect.width) || null,
  }
}

export function applyDiffRootAppearanceClass({
  appearanceClasses,
  container,
  currentSignature,
  diffAppearance,
  diffEditorView,
  isInlineMode,
  layoutModeClasses,
  lineStyle,
  lineStyleClasses,
  themeName,
  unchangedRegionStyle,
  unchangedRegionStyleClasses,
}: ApplyDiffRootAppearanceClassOptions): string | null {
  if (!container)
    return currentSignature

  const resolvedAppearance = resolveDiffAppearance({
    container,
    diffAppearance,
    diffEditorView,
    themeName,
  })
  syncDiffRootThemeVariables(container, diffEditorView, resolvedAppearance)

  const containerClassList = container.classList
  const activeLineStyleClass = `stream-monaco-diff-style-${lineStyle}`
  const activeUnchangedRegionStyleClass
    = `stream-monaco-diff-unchanged-style-${unchangedRegionStyle}`
  const activeLayoutModeClass = isInlineMode
    ? 'stream-monaco-diff-inline'
    : 'stream-monaco-diff-side-by-side'
  const activeAppearanceClass
    = `stream-monaco-diff-appearance-${resolvedAppearance}`
  const nextSignature = [
    activeLineStyleClass,
    activeUnchangedRegionStyleClass,
    activeLayoutModeClass,
    activeAppearanceClass,
  ].join('|')

  if (
    currentSignature === nextSignature
    && containerClassList.contains('stream-monaco-diff-root')
  ) {
    return currentSignature
  }

  containerClassList.add('stream-monaco-diff-root')

  for (const className of lineStyleClasses) {
    containerClassList.toggle(className, className === activeLineStyleClass)
  }
  for (const className of unchangedRegionStyleClasses) {
    containerClassList.toggle(
      className,
      className === activeUnchangedRegionStyleClass,
    )
  }
  for (const className of layoutModeClasses) {
    containerClassList.toggle(className, className === activeLayoutModeClass)
  }
  for (const className of appearanceClasses) {
    containerClassList.toggle(className, className === activeAppearanceClass)
  }

  return nextSignature
}
