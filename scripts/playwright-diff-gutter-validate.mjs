#!/usr/bin/env node
// Validate reference diff gutter spacing across multiple line-count scales.

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

function parseTargets(args) {
  const values = args
    .map((arg) => Number(arg))
    .filter((value) => Number.isInteger(value) && value >= 6)
  return values.length > 0 ? values : [6, 48, 512, 4096]
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

async function collectMetrics(page, lines, port) {
  const url = `http://127.0.0.1:${port}/diff-ux?style=background&scenario=pierre-reference&theme=snazzy-light&lines=${encodeURIComponent(
    String(lines),
  )}&capture=1`
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForSelector('.editor-card', { timeout: 20000 })
  await page.waitForTimeout(1400)

  const screenshotPath = path.join('/tmp', `stream-monaco-diff-gutter-${lines}.png`)
  await page.locator('.editor-card').screenshot({ path: screenshotPath })

  const metrics = await page.evaluate(() => {
    const getTextRect = (el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const rect = range.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width }
    }

    const firstVisibleTokenRect = (line) => {
      const spans = Array.from(line.querySelectorAll('span'))
      for (const span of spans) {
        const text = span.textContent || ''
        if (!text.trim()) continue
        const rect = getTextRect(span)
        if (rect.width > 0) return rect
      }
      return null
    }

    const root = document.querySelector('.editor')
    const markerWidth =
      Number.parseFloat(
        getComputedStyle(root ?? document.body).getPropertyValue(
          '--stream-monaco-gutter-marker-width',
        ),
      ) || 4

    const getPaneMetrics = (rootSelector) => {
      const pane = document.querySelector(rootSelector)
      const margin = pane?.querySelector('.margin')
      const lineNumber = pane?.querySelector('.line-numbers')
      const viewLine = pane?.querySelector('.view-lines .view-line')
      if (!margin || !lineNumber || !viewLine) return null

      const marginRect = margin.getBoundingClientRect()
      const lineNumberBoxRect = lineNumber.getBoundingClientRect()
      const lineNumberTextRect = getTextRect(lineNumber)
      const tokenRect = firstVisibleTokenRect(viewLine)
      if (!tokenRect) return null

      return {
        marginWidth: marginRect.width,
        numberBoxWidth: lineNumberBoxRect.width,
        numberTextWidth: lineNumberTextRect.width,
        visibleLineNumber: lineNumber.textContent?.trim() ?? '',
        boxLeftGap: lineNumberBoxRect.left - marginRect.left,
        boxRightGap: tokenRect.left - lineNumberBoxRect.right,
        textStripeGap: lineNumberTextRect.left - marginRect.left - markerWidth,
        textCodeGap: tokenRect.left - lineNumberTextRect.right,
      }
    }

    return {
      original: getPaneMetrics('.editor.original'),
      modified: getPaneMetrics('.editor.modified'),
    }
  })

  const original = metrics.original
  const modified = metrics.modified
  if (!original || !modified) {
    return {
      ok: false,
      lines,
      screenshotPath,
      reason: 'Unable to resolve pane metrics',
    }
  }

  const summary = {
    lines,
    screenshotPath,
    original: {
      marginWidth: round(original.marginWidth),
      numberBoxWidth: round(original.numberBoxWidth),
      visibleLineNumber: original.visibleLineNumber,
      boxLeftGap: round(original.boxLeftGap),
      boxRightGap: round(original.boxRightGap),
      textStripeGap: round(original.textStripeGap),
      textCodeGap: round(original.textCodeGap),
      symmetryDelta: round(Math.abs(original.textStripeGap - original.textCodeGap)),
    },
    modified: {
      marginWidth: round(modified.marginWidth),
      numberBoxWidth: round(modified.numberBoxWidth),
      visibleLineNumber: modified.visibleLineNumber,
      boxLeftGap: round(modified.boxLeftGap),
      boxRightGap: round(modified.boxRightGap),
      textStripeGap: round(modified.textStripeGap),
      textCodeGap: round(modified.textCodeGap),
      symmetryDelta: round(Math.abs(modified.textStripeGap - modified.textCodeGap)),
    },
  }

  const marginWidthDelta = Math.abs(
    summary.original.marginWidth - summary.modified.marginWidth,
  )
  const symmetryDelta = Math.max(
    summary.original.symmetryDelta,
    summary.modified.symmetryDelta,
  )
  const paneDelta = Math.max(
    Math.abs(summary.original.textStripeGap - summary.modified.textStripeGap),
    Math.abs(summary.original.textCodeGap - summary.modified.textCodeGap),
  )

  return {
    ...summary,
    ok: marginWidthDelta < 0.5 && symmetryDelta < 0.5 && paneDelta < 0.5,
    marginWidthDelta: round(marginWidthDelta),
    paneDelta: round(paneDelta),
  }
}

async function run() {
  const targets = parseTargets(process.argv.slice(2))
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
      viewport: { width: 1960, height: 720 },
      deviceScaleFactor: 2,
    })

    const results = []
    for (const lines of targets) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await collectMetrics(page, lines, port))
    }

    await browser.close()

    const ok = results.every((result) => result.ok)
    console.log(
      JSON.stringify(
        {
          ok,
          targets,
          results,
        },
        null,
        2,
      ),
    )

    if (!ok) process.exitCode = 1
  } catch (error) {
    console.error('Diff gutter validation failed.')
    console.error(logs.slice(-40).join(''))
    throw error
  } finally {
    killProcessTree(vite)
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
