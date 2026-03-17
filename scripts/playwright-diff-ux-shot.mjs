#!/usr/bin/env node
// Capture a deterministic screenshot of the diff UX demo for visual review.

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
  if (value === 'line-info-reference' || value === 'line-info')
    return 'line-info-reference'
  return 'pierre-reference'
}

function captureSelectorForScenario(scenario) {
  return scenario === 'line-info-reference'
    ? '.line-info-compare-frame'
    : '.editor-card'
}

function viewportForScenario(scenario) {
  return scenario === 'line-info-reference'
    ? { width: 1960, height: 1600 }
    : { width: 1960, height: 720 }
}

function parseUnchangedStyle(value) {
  if (value === 'line-info-basic') return 'line-info-basic'
  if (value === 'simple') return 'simple'
  return value === 'metadata' ? 'metadata' : 'line-info'
}

async function run() {
  const styleArg = process.argv[2] === 'bar' ? 'bar' : 'background'
  const outputArg = process.argv[3]
  const scenarioArg = parseScenario(process.argv[4])
  const themeArg = process.argv[5] || 'snazzy-light'
  const linesArg = process.argv[6] || '6'
  const unchangedStyleArg = parseUnchangedStyle(process.argv[7])
  const port = process.env.PORT
    ? Number(process.env.PORT)
    : await findFreePort()
  const outputPath = outputArg
    ? path.resolve(outputArg)
    : path.join(
        '/tmp',
        `stream-monaco-diff-ux-${scenarioArg}-${themeArg}-${styleArg}.png`,
      )

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
      viewport: viewportForScenario(scenarioArg),
      deviceScaleFactor: 2,
    })
    const url = `http://127.0.0.1:${port}/diff-ux?style=${styleArg}&scenario=${scenarioArg}&theme=${encodeURIComponent(
      themeArg,
    )}&lines=${encodeURIComponent(
      linesArg,
    )}&unchangedStyle=${encodeURIComponent(unchangedStyleArg)}&capture=1`

    await page.goto(url, { waitUntil: 'networkidle' })
    const captureSelector = captureSelectorForScenario(scenarioArg)
    await page.waitForSelector(captureSelector, { timeout: 20000 })
    await page.waitForTimeout(1400)

    const target = page.locator(captureSelector)
    await target.screenshot({ path: outputPath })

    const stats = await page.evaluate(() => {
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
          visibleLineNumber: lineNumber.textContent?.trim() ?? '',
          boxLeftGap: lineNumberBoxRect.left - marginRect.left,
          boxRightGap: tokenRect.left - lineNumberBoxRect.right,
          textStripeGap:
            lineNumberTextRect.left - marginRect.left - markerWidth,
          textCodeGap: tokenRect.left - lineNumberTextRect.right,
        }
      }

      const values = Array.from(
        document.querySelectorAll('.file-stats .delta'),
      ).map((node) => node.textContent?.trim() ?? '')
      return {
        deltas: values,
        title: document.querySelector('.file-name')?.textContent?.trim() ?? '',
        gutter: {
          original: getPaneMetrics('.editor.original'),
          modified: getPaneMetrics('.editor.modified'),
        },
      }
    })

    await browser.close()

    console.log(
      JSON.stringify(
        {
          ok: true,
          style: styleArg,
          scenario: scenarioArg,
          theme: themeArg,
          lines: linesArg,
          unchangedStyle: unchangedStyleArg,
          captureSelector,
          outputPath,
          url,
          stats: {
            ...stats,
            gutter:
              stats.gutter?.original && stats.gutter?.modified
                ? {
                    original: {
                      marginWidth: round(stats.gutter.original.marginWidth),
                      numberBoxWidth: round(
                        stats.gutter.original.numberBoxWidth,
                      ),
                      visibleLineNumber:
                        stats.gutter.original.visibleLineNumber,
                      boxLeftGap: round(stats.gutter.original.boxLeftGap),
                      boxRightGap: round(stats.gutter.original.boxRightGap),
                      textStripeGap: round(stats.gutter.original.textStripeGap),
                      textCodeGap: round(stats.gutter.original.textCodeGap),
                      symmetryDelta: round(
                        Math.abs(
                          stats.gutter.original.textStripeGap -
                            stats.gutter.original.textCodeGap,
                        ),
                      ),
                    },
                    modified: {
                      marginWidth: round(stats.gutter.modified.marginWidth),
                      numberBoxWidth: round(
                        stats.gutter.modified.numberBoxWidth,
                      ),
                      visibleLineNumber:
                        stats.gutter.modified.visibleLineNumber,
                      boxLeftGap: round(stats.gutter.modified.boxLeftGap),
                      boxRightGap: round(stats.gutter.modified.boxRightGap),
                      textStripeGap: round(stats.gutter.modified.textStripeGap),
                      textCodeGap: round(stats.gutter.modified.textCodeGap),
                      symmetryDelta: round(
                        Math.abs(
                          stats.gutter.modified.textStripeGap -
                            stats.gutter.modified.textCodeGap,
                        ),
                      ),
                    },
                  }
                : null,
          },
        },
        null,
        2,
      ),
    )
  } catch (error) {
    console.error('Diff UX screenshot capture failed.')
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
