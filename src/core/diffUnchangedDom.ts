import type { DiffUnchangedRegionStyle } from '../type'

const diffUnchangedSummaryStyleClasses = [
  'stream-monaco-unchanged-summary-line-info',
  'stream-monaco-unchanged-summary-line-info-basic',
  'stream-monaco-unchanged-summary-metadata',
  'stream-monaco-unchanged-summary-simple',
] as const

interface DiffUnchangedBridgeRect {
  height: number
  left: number
  right: number
  top: number
  width: number
}

interface DiffUnchangedBridgeTextStyle {
  color: string
  fontFamily: string
  fontSize: string
  lineHeight: string
}

interface SyncDiffUnchangedBridgeNodeOptions {
  bridge: HTMLDivElement
  bridgeLeftInset: number
  bridgeRailWidth: number | null
  containerRect: Pick<DOMRect, 'left' | 'top'>
  containerScrollLeft: number
  containerScrollTop: number
  editorBackgroundColor: string
  primaryAnchorRect: DiffUnchangedBridgeRect
  primaryStyle: DiffUnchangedBridgeTextStyle
  secondaryAnchorRect: DiffUnchangedBridgeRect
  unchangedRegionStyle: DiffUnchangedRegionStyle
}

export function createDiffUnchangedBridgeScaffold() {
  const bridge = document.createElement('div')
  bridge.className = 'stream-monaco-diff-unchanged-bridge'
  bridge.setAttribute('role', 'group')
  syncDiffUnchangedBridgeVisibility(bridge, false)

  const summary = document.createElement('button')
  summary.type = 'button'
  summary.className = 'stream-monaco-unchanged-summary'

  const visualMeta = document.createElement('div')
  visualMeta.className = 'stream-monaco-unchanged-meta'
  summary.append(visualMeta)

  const divider = document.createElement('span')
  divider.className = 'stream-monaco-unchanged-pane-divider'
  divider.setAttribute('aria-hidden', 'true')

  bridge.append(summary, divider)

  return {
    bridge,
    summary,
    visualMeta,
    divider,
  }
}

export function createDiffUnchangedBridgeOverlay() {
  const overlay = document.createElement('div')
  overlay.className = 'stream-monaco-diff-unchanged-overlay'
  return overlay
}

export function syncDiffUnchangedBridgeVisibility(
  bridge: HTMLDivElement,
  visible: boolean,
) {
  bridge.hidden = !visible
  bridge.toggleAttribute('aria-hidden', !visible)
}

export function clearDiffUnchangedBridgeSourceClasses(container: HTMLElement) {
  const bridgedCenters = container.querySelectorAll<HTMLElement>(
    '.stream-monaco-unchanged-bridge-source',
  )
  bridgedCenters.forEach(node =>
    node.classList.remove('stream-monaco-unchanged-bridge-source'),
  )
}

export function resetDiffUnchangedOverlayTransform(
  overlay: HTMLDivElement | null | undefined,
) {
  if (!overlay)
    return
  overlay.style.transform = 'translate3d(0px, 0px, 0px)'
}

export function resolveDiffUnchangedViewZoneHeight(
  unchangedRegionStyle: DiffUnchangedRegionStyle,
) {
  return unchangedRegionStyle === 'simple' ? 28 : 32
}

export function collectDiffUnchangedViewZoneIds(
  editorRoot: HTMLElement,
  scrollTop: number,
) {
  const widgetTopValues = Array.from(
    editorRoot.querySelectorAll<HTMLElement>('.diff-hidden-lines-widget'),
  )
    .map(node => Number.parseFloat(node.style.top || 'NaN'))
    .filter(value => Number.isFinite(value) && value > -100000)
  if (widgetTopValues.length === 0)
    return []

  return Array.from(
    editorRoot.querySelectorAll<HTMLElement>(
      '.view-zones > div[monaco-view-zone][monaco-visible-view-zone="true"]',
    ),
  )
    .filter((node) => {
      const zoneTop = Number.parseFloat(node.style.top || 'NaN')
      const currentHeight = Number.parseFloat(node.style.height || '0')
      return (
        Number.isFinite(zoneTop)
        && Number.isFinite(currentHeight)
        && currentHeight > 0
        && widgetTopValues.some(
          widgetTop => Math.abs(zoneTop - scrollTop - widgetTop) < 0.5,
        )
      )
    })
    .map(node => node.getAttribute('monaco-view-zone'))
    .filter((value): value is string => Boolean(value))
}

export function findDiffUnchangedActivationAction(
  ...roots: Array<ParentNode | null | undefined>
) {
  for (const root of roots) {
    const action = root?.querySelector<HTMLElement>('a, button') ?? null
    if (action)
      return action
  }
  return null
}

export function findDiffUnchangedExpandAction(
  root: ParentNode | null | undefined,
) {
  return root?.querySelector<HTMLElement>('a') ?? null
}

export function shouldIgnoreDiffUnchangedCenterClickTarget(
  target: EventTarget | null,
) {
  return target instanceof HTMLElement
    && Boolean(target.closest('a, .breadcrumb-item'))
}

export function syncDiffUnchangedCenterNode(
  node: HTMLElement,
  mergeRole: 'none' | 'primary' | 'secondary',
) {
  node.classList.add('stream-monaco-clickable')
  node.title = 'Click to expand all unmodified lines'
  node.classList.toggle(
    'stream-monaco-unchanged-merged-secondary',
    mergeRole === 'secondary',
  )
  node.classList.toggle(
    'stream-monaco-unchanged-merged-primary',
    mergeRole === 'primary',
  )
}

export function syncDiffUnchangedMetaNode(
  metaNode: HTMLElement,
  unchangedRegionStyle: DiffUnchangedRegionStyle,
  summaryLabel: string,
) {
  const lastStyle = metaNode.dataset.style
  const lastLabel = metaNode.dataset.label
  if (lastStyle === unchangedRegionStyle && lastLabel === summaryLabel)
    return

  metaNode.dataset.style = unchangedRegionStyle
  metaNode.dataset.label = summaryLabel
  metaNode.replaceChildren()
  metaNode.classList.toggle(
    'stream-monaco-unchanged-meta-simple',
    unchangedRegionStyle === 'simple',
  )

  if (unchangedRegionStyle === 'simple') {
    const simpleBar = document.createElement('span')
    simpleBar.className = 'stream-monaco-unchanged-simple-bar'
    simpleBar.setAttribute('aria-hidden', 'true')
    metaNode.append(simpleBar)
    return
  }

  const label = document.createElement('span')
  label.className = unchangedRegionStyle === 'metadata'
    ? 'stream-monaco-unchanged-metadata-label'
    : 'stream-monaco-unchanged-count'
  label.textContent = summaryLabel
  metaNode.append(label)
}

export function syncDiffUnchangedSummaryButton(
  summary: HTMLButtonElement,
  unchangedRegionStyle: DiffUnchangedRegionStyle,
  summaryLabel: string,
) {
  summary.classList.remove(...diffUnchangedSummaryStyleClasses)
  summary.classList.add(
    `stream-monaco-unchanged-summary-${unchangedRegionStyle}`,
  )

  const summaryInteractive
    = unchangedRegionStyle === 'line-info'
      || unchangedRegionStyle === 'line-info-basic'
  summary.disabled = !summaryInteractive
  summary.tabIndex = summaryInteractive ? 0 : -1

  if (summaryInteractive) {
    summary.removeAttribute('aria-hidden')
    summary.setAttribute(
      'aria-label',
      `${summaryLabel}. Expand all unmodified lines`,
    )
    summary.title = 'Expand all unmodified lines'
    return
  }

  if (unchangedRegionStyle === 'simple') {
    summary.setAttribute('aria-hidden', 'true')
    summary.removeAttribute('aria-label')
    summary.title = ''
    return
  }

  summary.removeAttribute('aria-hidden')
  summary.removeAttribute('aria-label')
  summary.title = ''
}

export function syncDiffUnchangedExpandAction(
  action: HTMLElement,
  hidden: boolean,
) {
  action.classList.add('stream-monaco-unchanged-expand')
  action.dataset.streamMonacoLabel = 'Expand all'
  action.title = 'Expand all unmodified lines'
  action.setAttribute('aria-label', 'Expand all unmodified lines')
  action.toggleAttribute('aria-hidden', hidden)
  action.tabIndex = hidden ? -1 : 0
}

export function createDiffUnchangedRevealButton(direction: 'up' | 'down') {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'stream-monaco-unchanged-reveal'
  button.innerHTML = `<span class="codicon codicon-chevron-${direction}"></span>`
  button.dataset.direction = direction
  return button
}

export function syncDiffUnchangedRevealButtonNode(
  button: HTMLButtonElement,
  handle: HTMLElement | null,
  label: string,
) {
  button.hidden = !handle
  button.disabled = !handle
  button.toggleAttribute('aria-hidden', !handle)
  button.title = handle ? label : ''
  button.setAttribute('aria-label', handle ? label : '')
}

export function syncDiffUnchangedBridgeNode(
  options: SyncDiffUnchangedBridgeNodeOptions,
) {
  const {
    bridge,
    bridgeLeftInset,
    bridgeRailWidth,
    containerRect,
    containerScrollLeft,
    containerScrollTop,
    editorBackgroundColor,
    primaryAnchorRect,
    primaryStyle,
    secondaryAnchorRect,
    unchangedRegionStyle,
  } = options

  bridge.className = 'stream-monaco-diff-unchanged-bridge'
  bridge.classList.add(
    `stream-monaco-diff-unchanged-bridge-${unchangedRegionStyle}`,
  )
  bridge.style.left = `${
    secondaryAnchorRect.left
    - containerRect.left
    + containerScrollLeft
    + bridgeLeftInset
  }px`
  bridge.style.top = `${
    primaryAnchorRect.top - containerRect.top + containerScrollTop
  }px`
  bridge.style.width = `${Math.max(
    0,
    primaryAnchorRect.right - secondaryAnchorRect.left - bridgeLeftInset,
  )}px`
  bridge.style.height = `${Math.max(
    secondaryAnchorRect.height,
    primaryAnchorRect.height,
  )}px`
  bridge.style.color = primaryStyle.color
  bridge.style.fontFamily = primaryStyle.fontFamily
  bridge.style.fontSize = primaryStyle.fontSize
  bridge.style.lineHeight = primaryStyle.lineHeight
  bridge.style.setProperty('--stream-monaco-unchanged-fg', primaryStyle.color)
  bridge.style.setProperty(
    '--stream-monaco-editor-bg',
    editorBackgroundColor,
  )
  bridge.style.setProperty(
    '--stream-monaco-unchanged-split-offset',
    `${Math.max(0, secondaryAnchorRect.width - bridgeLeftInset)}px`,
  )

  if (bridgeRailWidth) {
    bridge.style.setProperty(
      '--stream-monaco-unchanged-rail-width',
      `${bridgeRailWidth}px`,
    )
    return
  }

  bridge.style.removeProperty('--stream-monaco-unchanged-rail-width')
}

export function syncDiffUnchangedRailNode(
  rail: HTMLDivElement,
  showTopHandle: boolean,
  showBottomHandle: boolean,
) {
  const shouldRenderRail = showTopHandle || showBottomHandle
  rail.hidden = !shouldRenderRail
  rail.toggleAttribute('aria-hidden', !shouldRenderRail)
  rail.classList.toggle(
    'stream-monaco-unchanged-rail-top-only',
    showTopHandle && !showBottomHandle,
  )
  rail.classList.toggle(
    'stream-monaco-unchanged-rail-bottom-only',
    !showTopHandle && showBottomHandle,
  )
  rail.classList.toggle(
    'stream-monaco-unchanged-rail-both',
    showTopHandle && showBottomHandle,
  )
}

export function dispatchSyntheticPrimaryMouseDown(node: HTMLElement) {
  const view = node.ownerDocument.defaultView
  if (!view)
    return
  const rect = node.getBoundingClientRect()
  node.dispatchEvent(
    new view.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  )
}

export function dispatchSyntheticPrimaryMouseTap(node: HTMLElement) {
  const view = node.ownerDocument.defaultView
  if (!view)
    return
  const rect = node.getBoundingClientRect()
  const clientX = rect.left + rect.width / 2
  const clientY = rect.top + rect.height / 2
  node.dispatchEvent(
    new view.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      clientY,
    }),
  )
  node.dispatchEvent(
    new view.MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX,
      clientY,
    }),
  )
}
