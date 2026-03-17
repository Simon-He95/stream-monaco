#!/usr/bin/env node
// Validate that diff presentation toggles refresh in place without remounting
// the Monaco diff tree or shifting the host geometry.

import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const demoDir = path.join(repoRoot, 'examples', 'streaming-demo')

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port })
    sock.on('connect', () => {
      sock.end()
      resolve(true)
    })
    sock.on('error', () => {
      sock.destroy()
      resolve(false)
    })
  })
}

async function findFreePort(start = 5173, end = 5190) {
  for (let port = start; port <= end; port++) {
    // eslint-disable-next-line no-await-in-loop
    const open = await isPortOpen(port)
    if (!open) return port
  }
  throw new Error(`No free port found in ${start}-${end}`)
}

async function waitForPort(port, ms = 30000) {
  const start = Date.now()
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const open = await isPortOpen(port)
    if (open) return
    if (Date.now() - start > ms)
      throw new Error(`Timed out waiting for port ${port}`)
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150))
  }
}

function killProcessTree(child) {
  if (!child || child.killed) return
  try {
    child.kill('SIGTERM')
  } catch {}
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL')
    } catch {}
  }, 3000).unref?.()
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function colorLuminance(color) {
  const channels = String(color || '').match(/\d+(?:\.\d+)?/g)
  if (!channels || channels.length < 3) return null
  const [r, g, b] = channels.slice(0, 3).map(Number)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function rectDelta(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY
  return Math.max(
    Math.abs((a.left ?? 0) - (b.left ?? 0)),
    Math.abs((a.top ?? 0) - (b.top ?? 0)),
    Math.abs((a.width ?? 0) - (b.width ?? 0)),
    Math.abs((a.height ?? 0) - (b.height ?? 0)),
  )
}

function maxRectDelta(frames, key, baseline) {
  return frames.reduce((max, frame) => {
    return Math.max(max, rectDelta(frame[key], baseline[key]))
  }, 0)
}

function allFramesTrue(frames, selector) {
  return frames.every((frame) => selector(frame) === true)
}

async function invokeDiffTestApi(page, methodName, ...args) {
  await page.evaluate(
    ({ methodName, args }) => {
      const api = window.__streamMonacoDiffTestApi
      const method = api?.[methodName]
      if (typeof method !== 'function')
        throw new Error(`Missing diff test API method: ${methodName}`)
      return method(...args)
    },
    { methodName, args },
  )
}

async function primeModifiedScroll(page, top = 240) {
  await invokeDiffTestApi(page, 'setModifiedScrollTop', top)
  await page.waitForTimeout(180)
  const actual = await page.evaluate(() => {
    return window.__streamMonacoDiffTestApi?.getModifiedScrollTop?.() ?? 0
  })
  if (actual < Math.min(40, top * 0.2)) {
    throw new Error(
      `Failed to prime modified scroll position. expected around ${top}, got ${actual}`,
    )
  }
}

async function startTransitionProbe(page, frameCount = 42) {
  await page.evaluate((requestedFrames) => {
    const rectData = (node) => {
      if (!(node instanceof HTMLElement)) return null
      const rect = node.getBoundingClientRect()
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }
    }

    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden')
        return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    const countVisible = (selector) =>
      Array.from(document.querySelectorAll(selector)).filter(isVisible).length

    const readVisibleWidgets = (rootSelector) => {
      const root = document.querySelector(rootSelector)
      if (!(root instanceof HTMLElement)) return []
      const rootRect = root.getBoundingClientRect()
      return Array.from(root.querySelectorAll('.diff-hidden-lines-widget'))
        .map((node) => {
          if (!(node instanceof HTMLElement)) return null
          const rect = node.getBoundingClientRect()
          if (
            rect.height <= 0 ||
            rect.bottom <= rootRect.top + 1 ||
            rect.top >= rootRect.bottom - 1
          ) {
            return null
          }
          return {
            topOffset: rect.top - rootRect.top,
            height: rect.height,
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.topOffset - b.topOffset)
    }

    const readVisibleAnchor = (rootSelector) => {
      const root = document.querySelector(rootSelector)
      if (!(root instanceof HTMLElement)) return null
      const rootRect = root.getBoundingClientRect()
      const anchor = Array.from(root.querySelectorAll('.line-numbers'))
        .map((node) => {
          const rect = node.getBoundingClientRect()
          const lineNumber = Number.parseInt(node.textContent?.trim() || '', 10)
          return { lineNumber, rect }
        })
        .filter(({ lineNumber, rect }) => {
          return (
            Number.isFinite(lineNumber) &&
            rect.height > 0 &&
            rect.bottom > rootRect.top + 1 &&
            rect.top < rootRect.bottom - 1
          )
        })
        .sort((a, b) => a.rect.top - b.rect.top)[0]
      if (!anchor) return null
      return {
        lineNumber: anchor.lineNumber,
        topOffset: anchor.rect.top - rootRect.top,
      }
    }

    const readVisibleLineTops = (rootSelector) => {
      const root = document.querySelector(rootSelector)
      if (!(root instanceof HTMLElement)) return {}
      const rootRect = root.getBoundingClientRect()
      return Object.fromEntries(
        Array.from(root.querySelectorAll('.line-numbers'))
          .map((node) => {
            if (!(node instanceof HTMLElement)) return null
            const lineNumber = Number.parseInt(
              node.textContent?.trim() || '',
              10,
            )
            const rect = node.getBoundingClientRect()
            if (
              !Number.isFinite(lineNumber) ||
              rect.height <= 0 ||
              rect.bottom <= rootRect.top + 1 ||
              rect.top >= rootRect.bottom - 1
            ) {
              return null
            }
            return [String(lineNumber), rect.top - rootRect.top]
          })
          .filter(Boolean),
      )
    }

    const readVisibleSummaryStates = (selector) => {
      return Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .map((node) => {
          if (!(node instanceof HTMLButtonElement)) return null
          const style = getComputedStyle(node)
          return {
            cursor: style.cursor,
            pointerEvents: style.pointerEvents,
            disabled: node.disabled,
          }
        })
        .filter(Boolean)
    }

    const baselineNodes = {
      host: document.querySelector('.editor-card'),
      diffRoot: document.querySelector('.monaco-diff-editor'),
      original: document.querySelector('.editor.original'),
      modified: document.querySelector('.editor.modified'),
      overlay: document.querySelector('.stream-monaco-diff-unchanged-overlay'),
    }

    const capture = () => {
      const host = document.querySelector('.editor-card')
      const frame = document.querySelector('.line-info-compare-frame')
      const diffRoot = document.querySelector('.monaco-diff-editor')
      const original = document.querySelector('.editor.original')
      const modified = document.querySelector('.editor.modified')
      const overlay = document.querySelector(
        '.stream-monaco-diff-unchanged-overlay',
      )
      const backgroundProbe =
        diffRoot?.querySelector('.monaco-editor .monaco-editor-background') ??
        diffRoot?.querySelector('.monaco-editor-background')
      const rootContainer = document.querySelector('.stream-monaco-diff-root')
      return {
        frameRect: rectData(frame),
        hostRect: rectData(host),
        diffRect: rectData(diffRoot),
        overlayRect: rectData(overlay),
        modifiedScrollTop:
          window.__streamMonacoDiffTestApi?.getModifiedScrollTop?.() ?? 0,
        modifiedAnchor: readVisibleAnchor('.editor.modified'),
        modifiedVisibleWidgets: readVisibleWidgets('.editor.modified'),
        modifiedVisibleLineTops: readVisibleLineTops('.editor.modified'),
        visibleBridgeRailCount: countVisible(
          '.stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-rail',
        ),
        visibleBridgeRevealCount: countVisible(
          '.stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-reveal',
        ),
        visibleMetadataSummaryStates: readVisibleSummaryStates(
          '.stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary-metadata',
        ),
        visibleSimpleSummaryStates: readVisibleSummaryStates(
          '.stream-monaco-diff-unchanged-bridge .stream-monaco-unchanged-summary-simple',
        ),
        bridgeCount: countVisible('.stream-monaco-diff-unchanged-bridge'),
        backgroundColor:
          backgroundProbe instanceof HTMLElement
            ? getComputedStyle(backgroundProbe).backgroundColor
            : '',
        rootClasses:
          rootContainer instanceof HTMLElement
            ? Array.from(rootContainer.classList)
            : [],
        nodes: {
          hostSame: host === baselineNodes.host,
          diffRootSame: diffRoot === baselineNodes.diffRoot,
          originalSame: original === baselineNodes.original,
          modifiedSame: modified === baselineNodes.modified,
          overlaySame: overlay === baselineNodes.overlay,
        },
      }
    }

    const baseline = capture()
    window.__streamMonacoTransitionProbe = new Promise((resolve) => {
      const frames = []
      let remaining = Math.max(1, requestedFrames)
      const tick = () => {
        frames.push(capture())
        remaining--
        if (remaining <= 0) {
          resolve({ baseline, frames })
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, frameCount)
}

async function collectTransition(page, trigger) {
  await startTransitionProbe(page)
  await trigger()
  return page.evaluate(() => window.__streamMonacoTransitionProbe)
}

function summarizeTransition(name, result, options = {}) {
  const {
    expectedRootClass,
    geometryBudget = 0.75,
    requireGeometryStable = true,
    expectLuminance = null,
    requireModifiedScrollStable = true,
    scrollBudget = 1,
    requireModifiedAnchorStable = false,
    anchorBudget = 1,
    expectedVisibleWidgetHeight = null,
    expectAnyModifiedLineShiftUpAtLeast = null,
    expectedVisibleRailCount = null,
    expectedVisibleRevealCount = null,
    requireMetadataSummaryNonInteractive = false,
    requireSimpleSummaryNonInteractive = false,
  } = options

  const baseline = result.baseline
  const frames = result.frames
  const finalFrame = frames.at(-1) ?? baseline
  const hostMaxDelta = maxRectDelta(frames, 'hostRect', baseline)
  const diffMaxDelta = maxRectDelta(frames, 'diffRect', baseline)
  const frameMaxDelta = maxRectDelta(frames, 'frameRect', baseline)
  const overlayMaxDelta =
    baseline.overlayRect && finalFrame.overlayRect
      ? maxRectDelta(frames, 'overlayRect', baseline)
      : 0
  const modifiedScrollMaxDelta = frames.reduce((max, frame) => {
    return Math.max(
      max,
      Math.abs(
        (frame.modifiedScrollTop ?? 0) - (baseline.modifiedScrollTop ?? 0),
      ),
    )
  }, 0)
  const anchorLineStable = frames.every((frame) => {
    return (
      frame.modifiedAnchor?.lineNumber != null &&
      frame.modifiedAnchor?.lineNumber === baseline.modifiedAnchor?.lineNumber
    )
  })
  const modifiedAnchorMaxDelta = frames.reduce((max, frame) => {
    if (
      baseline.modifiedAnchor?.lineNumber == null ||
      frame.modifiedAnchor?.lineNumber !== baseline.modifiedAnchor?.lineNumber
    ) {
      return Number.POSITIVE_INFINITY
    }
    return Math.max(
      max,
      Math.abs(
        (frame.modifiedAnchor?.topOffset ?? 0) -
          (baseline.modifiedAnchor?.topOffset ?? 0),
      ),
    )
  }, 0)
  const finalWidgetHeights = (finalFrame.modifiedVisibleWidgets ?? []).map(
    (widget) => round(widget.height),
  )
  const widgetHeightOk =
    expectedVisibleWidgetHeight == null
      ? true
      : finalWidgetHeights.length > 0 &&
        finalWidgetHeights.every(
          (height) => Math.abs(height - expectedVisibleWidgetHeight) <= 1,
        )
  const baselineVisibleLineTops = baseline.modifiedVisibleLineTops ?? {}
  const finalVisibleLineTops = finalFrame.modifiedVisibleLineTops ?? {}
  const sharedLineShiftDeltas = Object.keys(baselineVisibleLineTops)
    .filter((lineNumber) => lineNumber in finalVisibleLineTops)
    .map((lineNumber) => {
      return round(
        finalVisibleLineTops[lineNumber] - baselineVisibleLineTops[lineNumber],
      )
    })
  const minSharedLineShift =
    sharedLineShiftDeltas.length > 0 ? Math.min(...sharedLineShiftDeltas) : null
  const maxSharedLineShift =
    sharedLineShiftDeltas.length > 0 ? Math.max(...sharedLineShiftDeltas) : null
  const lineShiftOk =
    expectAnyModifiedLineShiftUpAtLeast == null
      ? true
      : sharedLineShiftDeltas.some(
          (delta) => delta <= -expectAnyModifiedLineShiftUpAtLeast,
        )
  const visibleRailCountOk =
    expectedVisibleRailCount == null
      ? true
      : (finalFrame.visibleBridgeRailCount ?? 0) === expectedVisibleRailCount
  const visibleRevealCountOk =
    expectedVisibleRevealCount == null
      ? true
      : (finalFrame.visibleBridgeRevealCount ?? 0) ===
        expectedVisibleRevealCount
  const metadataSummaryStates = finalFrame.visibleMetadataSummaryStates ?? []
  const metadataSummaryNonInteractiveOk = requireMetadataSummaryNonInteractive
    ? metadataSummaryStates.length > 0 &&
      metadataSummaryStates.every((state) => {
        return (
          state.cursor !== 'pointer' &&
          state.pointerEvents === 'none' &&
          state.disabled === true
        )
      })
    : true
  const simpleSummaryStates = finalFrame.visibleSimpleSummaryStates ?? []
  const simpleSummaryNonInteractiveOk = requireSimpleSummaryNonInteractive
    ? simpleSummaryStates.length > 0 &&
      simpleSummaryStates.every((state) => {
        return (
          state.cursor !== 'pointer' &&
          state.pointerEvents === 'none' &&
          state.disabled === true
        )
      })
    : true
  const nodeStable = {
    host: allFramesTrue(frames, (frame) => frame.nodes.hostSame),
    diffRoot: allFramesTrue(frames, (frame) => frame.nodes.diffRootSame),
    original: allFramesTrue(frames, (frame) => frame.nodes.originalSame),
    modified: allFramesTrue(frames, (frame) => frame.nodes.modifiedSame),
    overlay: allFramesTrue(frames, (frame) => frame.nodes.overlaySame),
  }
  const finalLuminance = colorLuminance(finalFrame.backgroundColor)
  const luminanceOk =
    expectLuminance == null
      ? true
      : expectLuminance === 'dark'
      ? finalLuminance != null && finalLuminance < 120
      : finalLuminance != null && finalLuminance > 150
  const geometryOk = requireGeometryStable
    ? hostMaxDelta <= geometryBudget &&
      diffMaxDelta <= geometryBudget &&
      frameMaxDelta <= geometryBudget
    : true
  const scrollOk = requireModifiedScrollStable
    ? modifiedScrollMaxDelta <= scrollBudget
    : true
  const anchorOk = requireModifiedAnchorStable
    ? anchorLineStable && modifiedAnchorMaxDelta <= anchorBudget
    : true
  const rootClassOk = expectedRootClass
    ? finalFrame.rootClasses.includes(expectedRootClass)
    : true
  const ok =
    Object.values(nodeStable).every(Boolean) &&
    geometryOk &&
    scrollOk &&
    anchorOk &&
    widgetHeightOk &&
    lineShiftOk &&
    visibleRailCountOk &&
    visibleRevealCountOk &&
    metadataSummaryNonInteractiveOk &&
    simpleSummaryNonInteractiveOk &&
    rootClassOk &&
    luminanceOk

  return {
    name,
    ok,
    expectedRootClass,
    geometryBudget,
    requireGeometryStable,
    requireModifiedScrollStable,
    scrollBudget,
    requireModifiedAnchorStable,
    anchorBudget,
    rootClassOk,
    scrollOk,
    anchorOk,
    widgetHeightOk,
    lineShiftOk,
    visibleRailCountOk,
    visibleRevealCountOk,
    metadataSummaryNonInteractiveOk,
    simpleSummaryNonInteractiveOk,
    luminanceOk,
    finalLuminance: round(finalLuminance ?? Number.NaN),
    nodeStable,
    geometry: {
      hostMaxDelta: round(hostMaxDelta),
      diffMaxDelta: round(diffMaxDelta),
      frameMaxDelta: round(frameMaxDelta),
      overlayMaxDelta: round(overlayMaxDelta),
    },
    scroll: {
      before: round(baseline.modifiedScrollTop ?? 0),
      after: round(finalFrame.modifiedScrollTop ?? 0),
      maxDelta: round(modifiedScrollMaxDelta),
    },
    anchor: {
      before: baseline.modifiedAnchor ?? null,
      after: finalFrame.modifiedAnchor ?? null,
      lineStable: anchorLineStable,
      maxDelta: round(modifiedAnchorMaxDelta),
    },
    unchangedWidgets: {
      expectedHeight: expectedVisibleWidgetHeight,
      finalHeights: finalWidgetHeights,
    },
    lineShift: {
      min: minSharedLineShift,
      max: maxSharedLineShift,
      expectedShiftUpAtLeast: expectAnyModifiedLineShiftUpAtLeast,
    },
    bridgeChrome: {
      expectedVisibleRailCount,
      actualVisibleRailCount: finalFrame.visibleBridgeRailCount ?? 0,
      expectedVisibleRevealCount,
      actualVisibleRevealCount: finalFrame.visibleBridgeRevealCount ?? 0,
    },
    metadataSummary: {
      requireNonInteractive: requireMetadataSummaryNonInteractive,
      states: metadataSummaryStates,
    },
    simpleSummary: {
      requireNonInteractive: requireSimpleSummaryNonInteractive,
      states: simpleSummaryStates,
    },
    bridgeCount: {
      before: baseline.bridgeCount,
      after: finalFrame.bridgeCount,
    },
    finalRootClasses: finalFrame.rootClasses,
  }
}

async function main() {
  const port = process.env.PORT
    ? Number(process.env.PORT)
    : await findFreePort()
  const vite = spawn(
    'pnpm',
    [
      '-C',
      demoDir,
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  )

  const logs = []
  vite.stdout.on('data', (d) => logs.push(String(d)))
  vite.stderr.on('data', (d) => logs.push(String(d)))

  const onExit = () => killProcessTree(vite)
  process.on('SIGINT', onExit)
  process.on('SIGTERM', onExit)
  process.on('exit', onExit)

  try {
    await waitForPort(port)

    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 1960, height: 1600 },
      deviceScaleFactor: 2,
    })

    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => {
      pageErrors.push(String(error))
    })
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    const url = `http://127.0.0.1:${port}/diff-ux?style=background&scenario=line-info-reference&theme=vitesse-light&appearance=light&unchangedStyle=line-info`
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector('.editor-card', { timeout: 20000 })
    await page.waitForSelector('.monaco-diff-editor', { timeout: 20000 })
    await page.waitForSelector('.stream-monaco-diff-unchanged-overlay', {
      timeout: 20000,
    })
    await page.waitForTimeout(1400)

    const results = []

    await primeModifiedScroll(page)
    results.push(
      summarizeTransition(
        'appearance-light-to-dark',
        await collectTransition(page, async () => {
          await page.getByRole('button', { name: /^Dark$/ }).click()
        }),
        {
          expectedRootClass: 'stream-monaco-diff-appearance-dark',
          requireGeometryStable: true,
          expectLuminance: 'dark',
          requireModifiedScrollStable: true,
          expectedVisibleWidgetHeight: 32,
        },
      ),
    )

    await primeModifiedScroll(page)
    results.push(
      summarizeTransition(
        'appearance-dark-to-light',
        await collectTransition(page, async () => {
          await page.getByRole('button', { name: /^Light$/ }).click()
        }),
        {
          expectedRootClass: 'stream-monaco-diff-appearance-light',
          requireGeometryStable: true,
          expectLuminance: 'light',
          requireModifiedScrollStable: true,
          expectedVisibleWidgetHeight: 32,
        },
      ),
    )

    await primeModifiedScroll(page)
    results.push(
      summarizeTransition(
        'style-line-info-to-basic',
        await collectTransition(page, async () => {
          await page.getByRole('button', { name: /^Line Info Basic$/ }).click()
        }),
        {
          expectedRootClass:
            'stream-monaco-diff-unchanged-style-line-info-basic',
          requireGeometryStable: true,
          requireModifiedScrollStable: true,
          expectedVisibleWidgetHeight: 32,
        },
      ),
    )

    await primeModifiedScroll(page)
    results.push(
      summarizeTransition(
        'style-basic-to-metadata',
        await collectTransition(page, async () => {
          await page
            .getByRole('button', { name: /^Metadata$/ })
            .first()
            .click()
        }),
        {
          expectedRootClass: 'stream-monaco-diff-unchanged-style-metadata',
          requireGeometryStable: true,
          requireModifiedScrollStable: true,
          expectedVisibleWidgetHeight: 32,
          expectedVisibleRailCount: 0,
          expectedVisibleRevealCount: 0,
          requireMetadataSummaryNonInteractive: true,
        },
      ),
    )

    await primeModifiedScroll(page)
    results.push(
      summarizeTransition(
        'set-diff-models-same-content',
        await collectTransition(page, async () => {
          await invokeDiffTestApi(page, 'swapModelsSameContent')
        }),
        {
          expectedRootClass: 'stream-monaco-diff-unchanged-style-metadata',
          requireGeometryStable: true,
          requireModifiedScrollStable: false,
          requireModifiedAnchorStable: true,
          anchorBudget: 1,
        },
      ),
    )

    await primeModifiedScroll(page)
    results.push(
      summarizeTransition(
        'set-diff-models-changed-content',
        await collectTransition(page, async () => {
          await invokeDiffTestApi(page, 'swapModelsChangedContent')
        }),
        {
          expectedRootClass: 'stream-monaco-diff-unchanged-style-metadata',
          requireGeometryStable: true,
          requireModifiedScrollStable: false,
        },
      ),
    )

    await primeModifiedScroll(page)
    results.push(
      summarizeTransition(
        'style-metadata-to-simple',
        await collectTransition(page, async () => {
          await page
            .getByRole('button', { name: /^Simple$/ })
            .first()
            .click()
        }),
        {
          expectedRootClass: 'stream-monaco-diff-unchanged-style-simple',
          requireGeometryStable: false,
          requireModifiedScrollStable: true,
          expectedVisibleRailCount: 0,
          expectedVisibleRevealCount: 0,
          requireSimpleSummaryNonInteractive: true,
        },
      ),
    )

    await browser.close()

    const ok =
      pageErrors.length === 0 &&
      consoleErrors.length === 0 &&
      results.every((result) => result.ok)

    const output = {
      ok,
      url,
      pageErrors,
      consoleErrors,
      results,
    }

    console.log(JSON.stringify(output, null, 2))

    if (!ok) {
      console.error('Transition validation failed; recent Vite logs:\n')
      console.error(logs.slice(-60).join(''))
      process.exit(1)
    }
  } catch (error) {
    console.error('Transition validation startup/runtime error:')
    console.error(error)
    if (logs.length > 0) {
      console.error('Recent Vite logs:\n')
      console.error(logs.slice(-60).join(''))
    }
    throw error
  } finally {
    killProcessTree(vite)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
