#!/usr/bin/env node
// Validate narrow-width inline diff layout and hover behavior.

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

async function findFreePort(start = 5181, end = 5190) {
  for (let port = start; port <= end; port++) {
    // eslint-disable-next-line no-await-in-loop
    const open = await isPortOpen(port)
    if (!open) return port
  }
  throw new Error(`No free port found in ${start}-${end}`)
}

async function waitForPort(port, ms = 20000) {
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

function parseScenario(value) {
  if (value === 'streaming') return 'streaming'
  if (value === 'pierre-reference' || value === 'reference')
    return 'pierre-reference'
  return 'line-info-reference'
}

function parseUnchangedStyle(value) {
  if (value === 'line-info-basic') return 'line-info-basic'
  if (value === 'metadata') return 'metadata'
  if (value === 'simple') return 'simple'
  return 'line-info'
}

function parseWidths(values) {
  const parsed = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 320)
  return parsed.length > 0 ? parsed : [980, 760, 620, 520, 420]
}

async function forceFrameWidth(page, width) {
  await page.evaluate((targetWidth) => {
    const frame = document.querySelector('.line-info-compare-frame')
    const card = document.querySelector('.editor-card')
    const pageRoot = document.querySelector('.page')
    if (frame instanceof HTMLElement) {
      frame.style.width = `${targetWidth}px`
      frame.style.maxWidth = `${targetWidth}px`
    }
    if (card instanceof HTMLElement) {
      card.style.width = `${targetWidth}px`
      card.style.maxWidth = `${targetWidth}px`
    }
    if (pageRoot instanceof HTMLElement) {
      pageRoot.style.width = `${targetWidth}px`
      pageRoot.style.maxWidth = `${targetWidth}px`
    }
  }, width)
}

async function hoverFirstVisibleDiff(page) {
  const rect = await page.evaluate(() => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden')
        return false
      const bounds = node.getBoundingClientRect()
      return bounds.width > 0 && bounds.height > 0
    }

    const selectors = [
      '.editor.modified .char-insert',
      '.editor.modified .char-delete',
      '.editor.modified .inline-deleted-text',
      '.editor.modified .line-insert',
      '.editor.modified .line-delete',
      '.editor.original .inline-deleted-text',
      '.editor.original .line-delete',
    ]

    for (const selector of selectors) {
      const node = Array.from(document.querySelectorAll(selector)).find(
        isVisible,
      )
      if (!(node instanceof HTMLElement)) continue
      const bounds = node.getBoundingClientRect()
      return {
        x: bounds.left + Math.min(bounds.width * 0.5, 180),
        y: bounds.top + bounds.height / 2,
      }
    }

    return null
  })

  if (!rect) return false
  await page.mouse.move(rect.x, rect.y)
  await page.waitForTimeout(320)
  return true
}

async function collectMetrics(page, options) {
  const {
    port,
    scenario,
    width,
    style = 'background',
    theme = 'snazzy-light',
    lines = '6',
    unchangedStyle = 'line-info',
  } = options
  const url = `http://127.0.0.1:${port}/diff-ux?style=${style}&scenario=${scenario}&theme=${encodeURIComponent(
    theme,
  )}&lines=${encodeURIComponent(lines)}&unchangedStyle=${encodeURIComponent(
    unchangedStyle,
  )}&capture=1`

  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForSelector('.editor-card', { timeout: 20000 })
  await forceFrameWidth(page, width)
  await page.waitForTimeout(1400)
  await hoverFirstVisibleDiff(page)

  const screenshotPath = path.join(
    '/tmp',
    `stream-monaco-inline-${scenario}-${unchangedStyle}-${width}.png`,
  )
  await page
    .locator(
      scenario === 'line-info-reference'
        ? '.line-info-compare-frame'
        : '.editor-card',
    )
    .screenshot({ path: screenshotPath })

  const metrics = await page.evaluate(() => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden')
        return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    const rectData = (node) => {
      if (!(node instanceof HTMLElement)) return null
      const rect = node.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    }

    const countVisible = (selector) =>
      Array.from(document.querySelectorAll(selector)).filter(isVisible).length

    const frame =
      document.querySelector('.line-info-compare-frame') ??
      document.querySelector('.editor-card')
    const card = document.querySelector('.editor-card')
    const tabs = document.querySelector('.line-info-tabs')
    const fileStats = document.querySelector('.file-stats')
    const diffRoot = document.querySelector('.monaco-diff-editor')
    const original = document.querySelector('.editor.original')
    const modified = document.querySelector('.editor.modified')

    return {
      diffClass: diffRoot?.className || '',
      frame: rectData(frame),
      card: rectData(card),
      tabs: rectData(tabs),
      fileStats: rectData(fileStats),
      original: rectData(original),
      modified: rectData(modified),
      originalCenters: countVisible(
        '.editor.original .diff-hidden-lines .center',
      ),
      originalWidgets: countVisible(
        '.editor.original .diff-hidden-lines-widget, .editor.original .fold-unchanged',
      ),
      bridgeCount: countVisible('.stream-monaco-diff-unchanged-bridge'),
      paneDividerCount: countVisible('.stream-monaco-unchanged-pane-divider'),
      deletedMarginCount: countVisible('.inline-deleted-margin-view-zone'),
      tooltipCount: countVisible(
        '.monaco-hover, .monaco-editor-hover, .hover-widget, [role="tooltip"]',
      ),
      visibleHunkActionCount: countVisible('.stream-monaco-diff-hunk-actions'),
      rootClasses:
        document.querySelector('.editor')?.className ||
        document.querySelector('.editor-card')?.className ||
        '',
    }
  })

  const frameWidth = round(metrics.frame?.width ?? width)
  const cardWidth = round(metrics.card?.width ?? 0)
  const tabsWidth = round(metrics.tabs?.width ?? 0)
  const fileStatsRight = round(metrics.fileStats?.right ?? 0)
  const cardRight = round(metrics.card?.right ?? 0)
  const cardOverflow = round(Math.max(0, cardWidth - frameWidth))
  const tabsOverflow = round(
    Math.max(0, (metrics.tabs?.right ?? 0) - (metrics.frame?.right ?? 0)),
  )
  const fileStatsOverflow = round(Math.max(0, fileStatsRight - cardRight))
  const inlineMode =
    !metrics.diffClass.includes('side-by-side') ||
    (metrics.original?.width ?? 0) < 24

  let ok = cardOverflow <= 1 && tabsOverflow <= 1 && fileStatsOverflow <= 1
  if (inlineMode) {
    ok =
      ok &&
      metrics.originalCenters === 0 &&
      metrics.originalWidgets === 0 &&
      metrics.bridgeCount === 0 &&
      metrics.paneDividerCount === 0 &&
      metrics.tooltipCount <= 1 &&
      metrics.visibleHunkActionCount <= 1
  }

  return {
    ok,
    width,
    inlineMode,
    screenshotPath,
    frameWidth,
    cardWidth,
    tabsWidth,
    cardOverflow,
    tabsOverflow,
    fileStatsOverflow,
    diffClass: metrics.diffClass,
    originalWidth: round(metrics.original?.width ?? 0),
    modifiedWidth: round(metrics.modified?.width ?? 0),
    originalCenters: metrics.originalCenters,
    originalWidgets: metrics.originalWidgets,
    bridgeCount: metrics.bridgeCount,
    paneDividerCount: metrics.paneDividerCount,
    deletedMarginCount: metrics.deletedMarginCount,
    tooltipCount: metrics.tooltipCount,
    visibleHunkActionCount: metrics.visibleHunkActionCount,
  }
}

async function run() {
  const scenario = parseScenario(process.argv[2])
  const unchangedStyle = parseUnchangedStyle(process.argv[3])
  const widths = parseWidths(process.argv.slice(4))
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
      viewport: { width: 1600, height: 1700 },
      deviceScaleFactor: 2,
    })

    const results = []
    for (const width of widths) {
      // eslint-disable-next-line no-await-in-loop
      results.push(
        await collectMetrics(page, {
          port,
          scenario,
          width,
          unchangedStyle,
        }),
      )
    }

    await browser.close()

    const ok = results.every((result) => result.ok)
    console.log(
      JSON.stringify(
        {
          ok,
          scenario,
          unchangedStyle,
          widths,
          results,
        },
        null,
        2,
      ),
    )

    if (!ok) process.exitCode = 1
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          scenario,
          unchangedStyle,
          widths,
          error: error instanceof Error ? error.message : String(error),
          logs: logs.slice(-40),
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
  } finally {
    onExit()
  }
}

run()
