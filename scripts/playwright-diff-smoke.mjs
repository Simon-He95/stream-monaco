#!/usr/bin/env node
// Smoke test for DiffEditor streaming rendering.
// Starts the Vite demo, opens /diff in headless Chromium, and asserts Monaco renders text.

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
    // If nothing is listening, consider it free.
    // (We only bind after Vite starts, so this is best-effort.)
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

function killProcessTree(child) {
  if (!child || child.killed)
    return
  try {
    child.kill('SIGTERM')
  }
  catch { }
  // Fallback hard kill after a short grace period.
  setTimeout(() => {
    try {
      if (!child.killed)
        child.kill('SIGKILL')
    }
    catch { }
  }, 3000).unref?.()
}

async function run() {
  const port = process.env.PORT ? Number(process.env.PORT) : await findFreePort()
  if (!Number.isFinite(port))
    throw new Error(`Invalid PORT: ${process.env.PORT}`)

  const vite = spawn(
    'pnpm',
    ['-C', demoDir, 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  )

  const logs = []
  vite.stdout.on('data', d => logs.push(String(d)))
  vite.stderr.on('data', d => logs.push(String(d)))

  const onExit = () => killProcessTree(vite)
  process.on('SIGINT', onExit)
  process.on('SIGTERM', onExit)
  process.on('exit', onExit)

  try {
    await waitForPort(port)

    const url = `http://127.0.0.1:${port}/diff`
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector('.monaco-diff-editor', { timeout: 20000 })
    await page.waitForTimeout(1200)

    const before = await page.evaluate(() => {
      const viewLines = Array.from(document.querySelectorAll('.monaco-editor .view-lines'))
      const text = viewLines.map(v => (v.textContent ?? '')).join('\n').trim()
      return { viewLinesCount: viewLines.length, textLen: text.length, sample: text.slice(0, 120) }
    })

    // Wait for at least one streaming tick from the demo.
    await page.waitForTimeout(700)
    const after = await page.evaluate(() => {
      const viewLines = Array.from(document.querySelectorAll('.monaco-editor .view-lines'))
      const text = viewLines.map(v => (v.textContent ?? '')).join('\n').trim()
      return { viewLinesCount: viewLines.length, textLen: text.length }
    })

    await browser.close()

    // We only assert that Monaco renders *some* text and stays rendered after
    // streaming ticks. Diff line wrapping/reflow can change `textLen`, so do
    // not assert monotonic growth.
    const ok = before.textLen > 0 && after.textLen > 0
    const result = { ok, url, before, after }
    console.log(JSON.stringify(result, null, 2))
    if (!ok) {
      console.error('Diff smoke failed; recent Vite logs:\n', logs.slice(-40).join(''))
      process.exit(1)
    }
  }
  finally {
    killProcessTree(vite)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
