#!/usr/bin/env node
// Validate that expanded unchanged regions disappear immediately and stay gone while scrolling.

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
    await new Promise((r) => setTimeout(r, 150))
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
  vite.stdout.on('data', (data) => logs.push(String(data)))
  vite.stderr.on('data', (data) => logs.push(String(data)))
  const onExit = () => killProcessTree(vite)
  process.on('exit', onExit)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))

  try {
    await waitForPort(port)

    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1465, height: 1100 } })
    const url = `http://127.0.0.1:${port}/diff-ux?style=${style}&scenario=${scenario}&theme=${encodeURIComponent(
      theme,
    )}&unchangedStyle=${encodeURIComponent(unchangedStyle)}`

    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector(
      '.stream-monaco-diff-unchanged-overlay .stream-monaco-diff-unchanged-bridge',
      { timeout: 20000 },
    )

    const visibleTextsBefore = await page
      .locator(
        '.stream-monaco-diff-unchanged-overlay .stream-monaco-diff-unchanged-bridge:not([hidden]) .stream-monaco-unchanged-summary',
      )
      .allTextContents()

    await page
      .locator('.stream-monaco-diff-unchanged-overlay .stream-monaco-unchanged-summary')
      .filter({ hasText: targetLabel })
      .first()
      .click()

    await page.waitForTimeout(20)

    const immediateScrollTarget = page
      .locator('.stream-monaco-diff-unchanged-overlay .stream-monaco-unchanged-summary')
      .filter({ hasText: '66 unmodified lines' })
      .first()

    if (await immediateScrollTarget.count()) {
      const box = await immediateScrollTarget.boundingBox()
      if (box) {
        await page.mouse.move(
          box.x + box.width * 0.5,
          box.y + box.height * 0.5,
        )
        await page.mouse.wheel(0, 180)
      }
    }

    await page.waitForTimeout(180)

    const afterClick = await page.evaluate((label) => {
      const visibleTexts = Array.from(
        document.querySelectorAll(
          '.stream-monaco-diff-unchanged-overlay .stream-monaco-diff-unchanged-bridge:not([hidden]) .stream-monaco-unchanged-summary',
        ),
      ).map((node) => node.textContent?.trim())
      const visibleTarget = visibleTexts.includes(label)
      const centerTarget = Array.from(
        document.querySelectorAll('.diff-hidden-lines .center'),
      ).some((node) => node.textContent?.trim() === label)
      return { visibleTexts, visibleTarget, centerTarget }
    }, targetLabel)

    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await page.mouse.wheel(0, 120)
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(100)
    }

    await page.evaluate(() => {
      const root = document.querySelector('.stream-monaco-diff-root')
      if (root instanceof HTMLElement && root.scrollHeight > root.clientHeight) {
        root.scrollTop = Math.min(root.scrollTop + 160, root.scrollHeight)
        root.dispatchEvent(new Event('scroll', { bubbles: true }))
      }

      const scrollables = Array.from(
        document.querySelectorAll('.monaco-scrollable-element.editor-scrollable'),
      )
      scrollables.forEach((node) => {
        if (!(node instanceof HTMLElement)) return
        node.scrollTop = 1200
        node.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
    })

    await page.waitForTimeout(40)

    const afterScroll = await page.evaluate((label) => {
      const visibleTexts = Array.from(
        document.querySelectorAll(
          '.stream-monaco-diff-unchanged-overlay .stream-monaco-diff-unchanged-bridge:not([hidden]) .stream-monaco-unchanged-summary',
        ),
      ).map((node) => node.textContent?.trim())

      const bridgeNodes = Array.from(
        document.querySelectorAll(
          '.stream-monaco-diff-unchanged-overlay .stream-monaco-diff-unchanged-bridge:not([hidden])',
        ),
      )
      const centerNodes = Array.from(
        document.querySelectorAll('.diff-hidden-lines .center'),
      )

      const measurements = visibleTexts
        .filter(Boolean)
        .map((text) => {
          const bridge = bridgeNodes.find(
            node => node.textContent?.trim() === text,
          )
          const center = centerNodes.find(
            node => node.textContent?.trim() === text,
          )
          const bridgeRect = bridge?.getBoundingClientRect()
          const centerRect = center?.getBoundingClientRect()
          return {
            text,
            hasCenter: Boolean(center),
            deltaTop:
              bridgeRect && centerRect
                ? +(bridgeRect.top - centerRect.top).toFixed(2)
                : null,
          }
        })

      return {
        visibleTexts,
        visibleTarget: visibleTexts.includes(label),
        bridgeCount: document.querySelectorAll(
          '.stream-monaco-diff-unchanged-overlay .stream-monaco-diff-unchanged-bridge:not([hidden])',
        ).length,
        measurements,
      }
    }, targetLabel)

    const ok =
      visibleTextsBefore.includes(targetLabel) &&
      afterClick.visibleTarget === false &&
      afterClick.centerTarget === false &&
      afterScroll.visibleTarget === false &&
      afterScroll.measurements.every(
        item => item.hasCenter && item.deltaTop != null && Math.abs(item.deltaTop) <= 12,
      )

    console.log(
      JSON.stringify(
        {
          ok,
          targetLabel,
          visibleTextsBefore,
          afterClick,
          afterScroll,
        },
        null,
        2,
      ),
    )

    await browser.close()
    killProcessTree(vite)
    process.exit(ok ? 0 : 1)
  }
  catch (error) {
    killProcessTree(vite)
    if (logs.length > 0) console.error(logs.join(''))
    console.error(error)
    process.exit(1)
  }
}

main()
