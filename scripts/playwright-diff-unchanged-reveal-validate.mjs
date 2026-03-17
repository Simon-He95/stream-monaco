#!/usr/bin/env node
// Validate that unchanged-region rail arrows reveal only the targeted region
// and reveal exactly five lines in the expected direction.

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

async function findFreePort(start = 4205, end = 4215) {
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
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

function killProcessTree(child) {
  if (!child || child.killed) return
  try {
    child.kill('SIGTERM')
  }
  catch {}
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL')
    }
    catch {}
  }, 3000).unref?.()
}

function parseCount(label) {
  const match = label.match(/\d+/)
  return match ? Number.parseInt(match[0], 10) : Number.NaN
}

function formatCountLabel(count) {
  return `${count} unmodified ${count === 1 ? 'line' : 'lines'}`
}

function buildExpectedCounts(beforeLabels, targetLabel, delta) {
  const counts = new Map()
  beforeLabels.forEach((label) => {
    counts.set(label, (counts.get(label) || 0) + 1)
  })
  counts.set(targetLabel, (counts.get(targetLabel) || 0) - 1)
  if (counts.get(targetLabel) === 0) counts.delete(targetLabel)
  const nextLabel = formatCountLabel(parseCount(targetLabel) - delta)
  counts.set(nextLabel, (counts.get(nextLabel) || 0) + 1)
  return Object.fromEntries(Array.from(counts.entries()).sort())
}

async function collectState(page, targetLabel) {
  return page.evaluate((label) => {
    const bridgeSelector =
      '.stream-monaco-diff-unchanged-overlay .stream-monaco-diff-unchanged-bridge:not([hidden])'
    const bridges = Array.from(document.querySelectorAll(bridgeSelector))
    const modifiedEditor =
      document.querySelector('.editor.modified') ||
      document.querySelector('.monaco-editor.modified') ||
      document.querySelector('.monaco-editor')

    const findNeighbors = (bridge) => {
      const rect = bridge.getBoundingClientRect()
      let previousVisibleLine = null
      let nextVisibleLine = null
      const lineNumbers = modifiedEditor?.querySelectorAll('.line-numbers') || []
      lineNumbers.forEach((node) => {
        const lineNumber = Number.parseInt(node.textContent?.trim() || '', 10)
        if (!Number.isFinite(lineNumber)) return
        const top = node.getBoundingClientRect().top
        if (top < rect.top - 1) {
          previousVisibleLine =
            previousVisibleLine == null
              ? lineNumber
              : Math.max(previousVisibleLine, lineNumber)
        }
        else if (top > rect.bottom + 1) {
          nextVisibleLine =
            nextVisibleLine == null
              ? lineNumber
              : Math.min(nextVisibleLine, lineNumber)
        }
      })
      return { previousVisibleLine, nextVisibleLine }
    }

    const items = bridges.map((bridge) => {
      const summary = bridge.querySelector('.stream-monaco-unchanged-summary')
      const labelText = summary?.textContent?.trim() || ''
      const rect = bridge.getBoundingClientRect()
      const { previousVisibleLine, nextVisibleLine } = findNeighbors(bridge)
      return {
        label: labelText,
        top: +rect.top.toFixed(2),
        previousVisibleLine,
        nextVisibleLine,
      }
    })

    const counts = {}
    items.forEach((item) => {
      counts[item.label] = (counts[item.label] || 0) + 1
    })

    const target = items.find(item => item.label === label) || null
    return {
      items,
      labels: items.map(item => item.label),
      counts,
      target,
    }
  }, targetLabel)
}

async function runDirectionCase(page, targetLabel, direction) {
  const before = await collectState(page, targetLabel)
  if (!before.target)
    throw new Error(`Could not find target unchanged block: ${targetLabel}`)

  const button = page
    .locator('.stream-monaco-diff-unchanged-bridge:not([hidden])')
    .filter({ has: page.locator('.stream-monaco-unchanged-summary', { hasText: targetLabel }) })
    .locator(`.stream-monaco-unchanged-reveal[data-direction="${direction}"]`)
    .first()

  await button.click()
  await page.waitForTimeout(350)

  const after = await collectState(page, targetLabel)
  const revealCount = 5
  const targetAfterLabel = formatCountLabel(
    parseCount(targetLabel) - revealCount,
  )
  const expectedCounts = buildExpectedCounts(
    before.labels,
    targetLabel,
    revealCount,
  )

  const expectedPreviousVisibleLine =
    direction === 'down'
      ? before.target.previousVisibleLine + revealCount
      : before.target.previousVisibleLine
  const expectedNextVisibleLine =
    direction === 'up'
      ? before.target.nextVisibleLine - revealCount
      : before.target.nextVisibleLine

  const matchingTarget = after.items.find(
    item =>
      item.label === targetAfterLabel &&
      item.previousVisibleLine === expectedPreviousVisibleLine &&
      item.nextVisibleLine === expectedNextVisibleLine,
  )

  const normalizedAfterCounts = Object.fromEntries(
    Object.entries(after.counts).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  )

  const ok =
    before.target.previousVisibleLine != null &&
    before.target.nextVisibleLine != null &&
    Boolean(matchingTarget) &&
    JSON.stringify(normalizedAfterCounts) === JSON.stringify(expectedCounts)

  return {
    ok,
    direction,
    targetLabel,
    targetAfterLabel,
    before,
    after,
    expectedCounts,
    expectedPreviousVisibleLine,
    expectedNextVisibleLine,
    matchingTarget,
  }
}

async function main() {
  const targetLabel = process.argv[2] || '71 unmodified lines'
  const scenario = process.argv[3] || 'streaming'
  const style = process.argv[4] || 'background'
  const theme = process.argv[5] || 'snazzy-light'
  const unchangedStyle = process.argv[6] || 'line-info'

  const port = await findFreePort()
  const vite = spawn(
    process.execPath,
    ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: demoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const logs = []
  vite.stdout.on('data', data => logs.push(String(data)))
  vite.stderr.on('data', data => logs.push(String(data)))
  const onExit = () => killProcessTree(vite)
  process.on('exit', onExit)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))

  try {
    await waitForPort(port)
    const browser = await chromium.launch({ headless: true })
    const runCase = async (direction) => {
      const page = await browser.newPage({ viewport: { width: 1465, height: 1100 } })
      const url =
        `http://127.0.0.1:${port}/diff-ux?style=${style}&scenario=${scenario}` +
        `&theme=${encodeURIComponent(theme)}&unchangedStyle=${encodeURIComponent(unchangedStyle)}`
      await page.goto(url, { waitUntil: 'networkidle' })
      await page.waitForSelector(
        '.stream-monaco-diff-unchanged-overlay .stream-monaco-diff-unchanged-bridge',
        { timeout: 20000 },
      )
      const result = await runDirectionCase(page, targetLabel, direction)
      await page.close()
      return result
    }

    const down = await runCase('down')
    const up = await runCase('up')
    await browser.close()

    const ok = down.ok && up.ok
    console.log(
      JSON.stringify(
        {
          ok,
          targetLabel,
          down,
          up,
        },
        null,
        2,
      ),
    )
    if (!ok) process.exitCode = 1
  }
  catch (error) {
    console.error(String(error))
    if (logs.length > 0) console.error(logs.join(''))
    process.exitCode = 1
  }
  finally {
    killProcessTree(vite)
  }
}

main()
