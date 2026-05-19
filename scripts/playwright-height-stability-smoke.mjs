#!/usr/bin/env node

import net from 'node:net'
import process from 'node:process'
import { spawn } from 'node:child_process'
import path from 'node:path'
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
    if (!open)
      return port
  }
  throw new Error(`No free port found in ${start}-${end}`)
}

async function waitForPort(port, ms = 20000) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const open = await isPortOpen(port)
    if (open)
      return
    if (Date.now() - start > ms)
      throw new Error(`Timed out waiting for port ${port}`)
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 150))
  }
}

function isProcessAlive(child) {
  return child.exitCode == null && child.signalCode == null
}

function signalProcessTree(child, signal) {
  if (!child)
    return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    }
    catch {}
  }
  if (!isProcessAlive(child))
    return
  try {
    child.kill(signal)
  }
  catch {}
}

function killProcessTree(child) {
  if (!child)
    return
  signalProcessTree(child, 'SIGTERM')
  setTimeout(() => {
    signalProcessTree(child, 'SIGKILL')
  }, 3000).unref?.()
}

function assertHeightStability(report) {
  const failures = []
  if (report.smooth.largeJumps > 1)
    failures.push(`smooth.largeJumps expected <= 1, got ${report.smooth.largeJumps}`)
  if (report.constrainedSmooth.largeJumps > 1)
    failures.push(`constrainedSmooth.largeJumps expected <= 1, got ${report.constrainedSmooth.largeJumps}`)
  if (!report.smooth.monacoHasScrollbar)
    failures.push('smooth.monacoHasScrollbar expected true after full stream')
  if (!report.constrainedSmooth.monacoHasScrollbar)
    failures.push('constrainedSmooth.monacoHasScrollbar expected true after full stream')
  if (report.runtime.maxFrameGap > 250)
    failures.push(`runtime.maxFrameGap expected <= 250ms, got ${report.runtime.maxFrameGap}`)
  return failures
}

async function run() {
  const port = process.env.PORT ? Number(process.env.PORT) : await findFreePort()
  if (!Number.isFinite(port))
    throw new Error(`Invalid PORT: ${process.env.PORT}`)

  const vite = spawn(
    'pnpm',
    ['-C', demoDir, 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: process.platform !== 'win32' },
  )

  const logs = []
  vite.stdout.on('data', d => logs.push(String(d)))
  vite.stderr.on('data', d => logs.push(String(d)))

  const onExit = () => killProcessTree(vite)
  process.on('SIGINT', onExit)
  process.on('SIGTERM', onExit)
  process.on('exit', onExit)

  let browser
  try {
    await waitForPort(port)

    const url = `http://127.0.0.1:${port}/height-stability`
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => typeof window.__heightStabilityReport === 'function', null, { timeout: 20000 })
    await page.waitForFunction(() => {
      const report = window.__heightStabilityReport?.()
      return !!report
        && report.runtime.streamMs > 0
        && report.smooth.lineCount > 20
        && report.constrainedSmooth.lineCount > 20
    }, null, { timeout: 30000 })
    await page.waitForTimeout(500)

    const report = await page.evaluate(() => window.__heightStabilityReport())
    const failures = assertHeightStability(report)
    const result = { ok: failures.length === 0, url, failures, report }
    console.log(JSON.stringify(result, null, 2))
    if (failures.length > 0) {
      console.error('Height stability smoke failed; recent Vite logs:\n', logs.slice(-40).join(''))
      process.exitCode = 1
      return
    }
  }
  finally {
    await browser?.close()
    killProcessTree(vite)
  }
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
