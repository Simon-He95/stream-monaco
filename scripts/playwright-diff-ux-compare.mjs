#!/usr/bin/env node
// Capture the diff UX demo and compare it against a reference screenshot.

import fs from 'node:fs/promises'
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

async function captureScreenshot(
  browser,
  port,
  style,
  scenario,
  theme,
  unchangedStyle,
  outputPath,
) {
  const page = await browser.newPage({
    viewport: viewportForScenario(scenario),
    deviceScaleFactor: 2,
  })
  const url = `http://127.0.0.1:${port}/diff-ux?style=${style}&scenario=${scenario}&theme=${encodeURIComponent(
    theme,
  )}&unchangedStyle=${encodeURIComponent(unchangedStyle)}&capture=1`

  await page.goto(url, { waitUntil: 'networkidle' })
  const captureSelector = captureSelectorForScenario(scenario)
  await page.waitForSelector(captureSelector, { timeout: 20000 })
  await page.waitForTimeout(1400)

  const target = page.locator(captureSelector)
  await target.screenshot({ path: outputPath })

  const stats = await page.evaluate(() => {
    const values = Array.from(
      document.querySelectorAll('.file-stats .delta'),
    ).map((node) => node.textContent?.trim() ?? '')
    return {
      deltas: values,
      title: document.querySelector('.file-name')?.textContent?.trim() ?? '',
    }
  })

  await page.close()
  return { outputPath, url, captureSelector, unchangedStyle, stats }
}

async function compareImages(
  browser,
  actualPath,
  referencePath,
  diffPath,
  threshold,
) {
  const [actualBase64, referenceBase64] = await Promise.all([
    fs.readFile(actualPath, 'base64'),
    fs.readFile(referencePath, 'base64'),
  ])

  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
  })

  await page.setContent('<!doctype html><html><body></body></html>')
  const result = await page.evaluate(
    async ({ actualBase64, referenceBase64, threshold }) => {
      const loadImage = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () =>
            reject(new Error(`Failed to load image: ${src.slice(0, 32)}...`))
          img.src = src
        })

      const actual = await loadImage(`data:image/png;base64,${actualBase64}`)
      const reference = await loadImage(
        `data:image/png;base64,${referenceBase64}`,
      )
      const width = Math.max(actual.width, reference.width)
      const height = Math.max(actual.height, reference.height)

      const actualCanvas = document.createElement('canvas')
      actualCanvas.width = width
      actualCanvas.height = height
      const actualCtx = actualCanvas.getContext('2d')
      actualCtx.clearRect(0, 0, width, height)
      actualCtx.drawImage(actual, 0, 0)

      const referenceCanvas = document.createElement('canvas')
      referenceCanvas.width = width
      referenceCanvas.height = height
      const referenceCtx = referenceCanvas.getContext('2d')
      referenceCtx.clearRect(0, 0, width, height)
      referenceCtx.drawImage(reference, 0, 0)

      const diffCanvas = document.createElement('canvas')
      diffCanvas.width = width
      diffCanvas.height = height
      const diffCtx = diffCanvas.getContext('2d')

      const actualData = actualCtx.getImageData(0, 0, width, height).data
      const referenceData = referenceCtx.getImageData(0, 0, width, height).data
      const diffImage = diffCtx.createImageData(width, height)

      let diffPixels = 0
      let totalDelta = 0
      let maxChannelDelta = 0

      for (let i = 0; i < actualData.length; i += 4) {
        const ar = actualData[i]
        const ag = actualData[i + 1]
        const ab = actualData[i + 2]
        const aa = actualData[i + 3]

        const rr = referenceData[i]
        const rg = referenceData[i + 1]
        const rb = referenceData[i + 2]
        const ra = referenceData[i + 3]

        const deltaR = Math.abs(ar - rr)
        const deltaG = Math.abs(ag - rg)
        const deltaB = Math.abs(ab - rb)
        const deltaA = Math.abs(aa - ra)
        const pixelDelta = deltaR + deltaG + deltaB + deltaA

        totalDelta += pixelDelta
        maxChannelDelta = Math.max(
          maxChannelDelta,
          deltaR,
          deltaG,
          deltaB,
          deltaA,
        )

        const outIndex = i
        const baseR = Math.round(rr * 0.82 + ar * 0.18)
        const baseG = Math.round(rg * 0.82 + ag * 0.18)
        const baseB = Math.round(rb * 0.82 + ab * 0.18)

        if (pixelDelta > threshold) {
          diffPixels += 1
          diffImage.data[outIndex] = 255
          diffImage.data[outIndex + 1] = Math.max(80, Math.round(baseG * 0.45))
          diffImage.data[outIndex + 2] = 160
          diffImage.data[outIndex + 3] = 255
          continue
        }

        diffImage.data[outIndex] = baseR
        diffImage.data[outIndex + 1] = baseG
        diffImage.data[outIndex + 2] = baseB
        diffImage.data[outIndex + 3] = Math.max(40, ra)
      }

      diffCtx.putImageData(diffImage, 0, 0)

      return {
        width,
        height,
        sameDimensions:
          actual.width === reference.width &&
          actual.height === reference.height,
        actualSize: { width: actual.width, height: actual.height },
        referenceSize: { width: reference.width, height: reference.height },
        diffPixels,
        totalPixels: width * height,
        mismatchRatio: diffPixels / (width * height),
        meanChannelDelta: totalDelta / (width * height * 4),
        maxChannelDelta,
        diffDataUrl: diffCanvas.toDataURL('image/png'),
      }
    },
    { actualBase64, referenceBase64, threshold },
  )

  const diffBase64 = result.diffDataUrl.replace(/^data:image\/png;base64,/, '')
  await fs.writeFile(diffPath, Buffer.from(diffBase64, 'base64'))
  await page.close()

  const { diffDataUrl: _diffDataUrl, ...metrics } = result

  return {
    ...metrics,
    diffPath,
    exactMatch: metrics.diffPixels === 0,
  }
}

async function run() {
  const referenceArg = process.argv[2]
  if (!referenceArg) {
    throw new Error(
      'Usage: node scripts/playwright-diff-ux-compare.mjs <reference.png> [background|bar] [pierre-reference|streaming|line-info-reference] [actual.png] [diff.png] [pixel-threshold] [theme] [line-info|line-info-basic|metadata|simple]',
    )
  }

  const styleArg = process.argv[3] === 'bar' ? 'bar' : 'background'
  const scenarioArg = parseScenario(process.argv[4])
  const referencePath = path.resolve(referenceArg)
  const actualPath = process.argv[5]
    ? path.resolve(process.argv[5])
    : path.join('/tmp', `stream-monaco-diff-ux-${scenarioArg}-${styleArg}.png`)
  const diffPath = process.argv[6]
    ? path.resolve(process.argv[6])
    : path.join(
        '/tmp',
        `stream-monaco-diff-ux-${scenarioArg}-${styleArg}-diff.png`,
      )
  const rawThreshold = Number(process.argv[7] ?? '28')
  const threshold = Number.isFinite(rawThreshold) ? rawThreshold : 28
  const themeArg = process.argv[8] || 'snazzy-light'
  const unchangedStyleArg = parseUnchangedStyle(process.argv[9])
  const port = process.env.PORT
    ? Number(process.env.PORT)
    : await findFreePort()

  await fs.access(referencePath)

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

  let browser
  try {
    await waitForPort(port)
    browser = await chromium.launch({ headless: true })

    const capture = await captureScreenshot(
      browser,
      port,
      styleArg,
      scenarioArg,
      themeArg,
      unchangedStyleArg,
      actualPath,
    )
    const comparison = await compareImages(
      browser,
      actualPath,
      referencePath,
      diffPath,
      threshold,
    )

    await browser.close()

    console.log(
      JSON.stringify(
        {
          ok: true,
          style: styleArg,
          scenario: scenarioArg,
          theme: themeArg,
          unchangedStyle: unchangedStyleArg,
          threshold,
          referencePath,
          actualPath,
          diffPath,
          capture,
          comparison,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    if (browser) {
      try {
        await browser.close()
      } catch {}
    }
    console.error('Diff UX comparison failed.')
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
