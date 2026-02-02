#!/usr/bin/env node
// Measure Monaco load/render/stream timings using the streaming-demo.

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
    if (child.pid)
      process.kill(-child.pid, 'SIGTERM')
    else
      child.kill('SIGTERM')
  }
  catch {}
  setTimeout(() => {
    try {
      if (child.pid)
        process.kill(-child.pid, 'SIGKILL')
      else if (!child.killed)
        child.kill('SIGKILL')
    }
    catch {}
  }, 3000).unref?.()
}

function waitForExit(child, ms = 5000) {
  return new Promise((resolve) => {
    if (!child)
      return resolve(true)
    if (child.exitCode != null)
      return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function spanFor(entries) {
  if (!entries.length)
    return null
  const start = Math.min(...entries.map(e => e.startTime))
  const end = Math.max(...entries.map(e => e.startTime + e.duration))
  return { count: entries.length, start, end, duration: end - start }
}

function markMap(marks) {
  const map = {}
  for (const m of marks || [])
    map[m.name] = m.t
  return map
}

async function run() {
  const port = process.env.PORT ? Number(process.env.PORT) : await findFreePort()
  if (!Number.isFinite(port))
    throw new Error(`Invalid PORT: ${process.env.PORT}`)

  const vite = spawn(
    'pnpm',
    ['-C', demoDir, 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true },
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
    const url = `http://127.0.0.1:${port}/`

    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle' })

    // Wait for key marks (best-effort)
    await page.waitForFunction(() => {
      const m = (window).__streamMonacoPerf?.marks || []
      return m.some(x => x.name === 'createEditor_done')
    }, null, { timeout: 20000 })

    await page.waitForFunction(() => {
      const m = (window).__streamMonacoPerf?.marks || []
      return m.some(x => x.name === 'stream_done')
    }, null, { timeout: 60000 })

    const pageResult = await page.evaluate(() => {
      const perf = (window).__streamMonacoPerf || { marks: [] }
      const marks = perf.marks || []
      const nav = performance.getEntriesByType('navigation')[0]
      const resources = performance.getEntriesByType('resource')
      const by = (re) => resources.filter(r => re.test(r.name))
      const monaco = by(/monaco-editor/i)
      const shiki = by(/shiki|@shikijs/i)
      const workers = by(/worker\.js|workerMain\.js/i)
      return {
        url: location.href,
        marks,
        longTasks: perf.longTasks || 0,
        nav: nav ? {
          startTime: nav.startTime,
          domContentLoaded: nav.domContentLoadedEventEnd,
          loadEvent: nav.loadEventEnd,
        } : null,
        resourceSpans: {
          monaco: monaco.length ? {
            count: monaco.length,
            start: Math.min(...monaco.map(e => e.startTime)),
            end: Math.max(...monaco.map(e => e.startTime + e.duration)),
          } : null,
          shiki: shiki.length ? {
            count: shiki.length,
            start: Math.min(...shiki.map(e => e.startTime)),
            end: Math.max(...shiki.map(e => e.startTime + e.duration)),
          } : null,
          workers: workers.length ? {
            count: workers.length,
            start: Math.min(...workers.map(e => e.startTime)),
            end: Math.max(...workers.map(e => e.startTime + e.duration)),
          } : null,
        },
      }
    })

    await browser.close()

    const m = markMap(pageResult.marks)
    const durations = {
      to_monaco_dom: m.monaco_dom ?? null,
      to_view_lines_text: m.view_lines_text ?? null,
      to_view_lines_text_growth: m.view_lines_text_growth ?? null,
      to_create_editor_done: m.createEditor_done ?? null,
      create_editor_duration: (m.createEditor_done != null && m.createEditor_start != null)
        ? (m.createEditor_done - m.createEditor_start)
        : null,
      to_first_stream_update: m.stream_first_update ?? null,
      to_stream_done: m.stream_done ?? null,
      stream_duration: (m.stream_done != null && m.stream_first_update != null)
        ? (m.stream_done - m.stream_first_update)
        : null,
    }

    const spans = pageResult.resourceSpans
    const spansOut = {
      monaco: spans.monaco
        ? { ...spans.monaco, duration: spans.monaco.end - spans.monaco.start }
        : null,
      shiki: spans.shiki
        ? { ...spans.shiki, duration: spans.shiki.end - spans.shiki.start }
        : null,
      workers: spans.workers
        ? { ...spans.workers, duration: spans.workers.end - spans.workers.start }
        : null,
    }

    const out = {
      ok: true,
      url: pageResult.url,
      longTasks: pageResult.longTasks,
      nav: pageResult.nav,
      durations,
      resourceSpans: spansOut,
      marks: pageResult.marks,
    }

    console.log(JSON.stringify(out, null, 2))
  }
  catch (err) {
    console.error(err)
    console.error('Recent Vite logs:\n', logs.slice(-40).join(''))
    process.exitCode = 1
  }
  finally {
    killProcessTree(vite)
    await waitForExit(vite, 5000)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
