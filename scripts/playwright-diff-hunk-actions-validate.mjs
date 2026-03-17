#!/usr/bin/env node
// Validate default Diff UX hunk actions against Monaco model contents.

import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const demoDir = path.join(repoRoot, 'examples', 'streaming-demo')

const fixtures = {
  inserted: {
    pair: {
      original: [
        'const alpha = 1',
        'const beta = 2',
        'const gamma = 3',
      ].join('\n'),
      modified: [
        'const alpha = 1',
        'const beta = 2',
        'const inserted = 99',
        'const gamma = 3',
      ].join('\n'),
    },
    hoverRootSelector: '.editor.modified',
    hoverLineText: 'inserted = 99',
  },
  deleted: {
    pair: {
      original: [
        'const alpha = 1',
        'const legacy = 0',
        'const beta = 2',
        'const gamma = 3',
      ].join('\n'),
      modified: [
        'const alpha = 1',
        'const beta = 2',
        'const gamma = 3',
      ].join('\n'),
    },
    hoverRootSelector: '.editor.original',
    hoverLineText: 'legacy = 0',
  },
}

const cases = [
  {
    name: 'revert-lower-removes-inserted-lines',
    fixture: 'inserted',
    side: 'lower',
    action: 'revert',
    expected: {
      original: fixtures.inserted.pair.original,
      modified: fixtures.inserted.pair.original,
    },
    expectedDiffCount: 0,
  },
  {
    name: 'revert-upper-restores-deleted-lines',
    fixture: 'deleted',
    side: 'upper',
    action: 'revert',
    expected: {
      original: fixtures.deleted.pair.original,
      modified: fixtures.deleted.pair.original,
    },
    expectedDiffCount: 0,
  },
  {
    name: 'stage-lower-copies-inserted-lines-to-original',
    fixture: 'inserted',
    side: 'lower',
    action: 'stage',
    expected: {
      original: fixtures.inserted.pair.modified,
      modified: fixtures.inserted.pair.modified,
    },
    expectedDiffCount: 0,
  },
  {
    name: 'stage-upper-drops-deleted-lines-from-original',
    fixture: 'deleted',
    side: 'upper',
    action: 'stage',
    expected: {
      original: fixtures.deleted.pair.modified,
      modified: fixtures.deleted.pair.modified,
    },
    expectedDiffCount: 0,
  },
]

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

async function findFreePort(start = 5173, end = 5290) {
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
    await new Promise((resolve) => setTimeout(resolve, 150))
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

async function invokeDiffTestApi(page, methodName, ...args) {
  return page.evaluate(
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

async function waitForDiffFixture(page) {
  await page.waitForFunction(() => {
    const api = window.__streamMonacoDiffTestApi
    const values = api?.getDiffValues?.()
    const summary = api?.getDiffSummary?.()
    return (
      values &&
      summary &&
      values.original !== values.modified &&
      summary.diffCount > 0
    )
  }, { timeout: 8000 })
}

async function hoverDiffLine(page, rootSelector, lineText) {
  const line = page
    .locator(`${rootSelector} .view-lines .view-line`)
    .filter({ hasText: lineText })
    .first()

  await line.waitFor({ state: 'visible', timeout: 5000 })
  await line.hover()
  await page.waitForTimeout(400)
}

async function clickHunkAction(page, side, action) {
  const button = page.locator(
    `.stream-monaco-diff-hunk-actions[data-side="${side}"] button[data-action="${action}"]`,
  )
  await button.waitFor({ state: 'visible', timeout: 5000 })
  if (await button.isDisabled()) {
    throw new Error(`Expected ${side}/${action} button to be enabled`)
  }
  await button.click()
}

async function waitForExpectedState(page, expected, expectedDiffCount) {
  await page.waitForFunction(
    ({ expected, expectedDiffCount }) => {
      const api = window.__streamMonacoDiffTestApi
      const values = api?.getDiffValues?.()
      const summary = api?.getDiffSummary?.()
      return (
        values &&
        summary &&
        values.original === expected.original &&
        values.modified === expected.modified &&
        summary.diffCount === expectedDiffCount
      )
    },
    { expected, expectedDiffCount },
    { timeout: 8000 },
  )
}

async function runCase(page, scenario) {
  const fixture = fixtures[scenario.fixture]
  if (!fixture) throw new Error(`Unknown fixture: ${scenario.fixture}`)

  let before = null

  try {
    await invokeDiffTestApi(page, 'setDiffPair', fixture.pair, {
      preserveViewState: false,
    })
    await waitForDiffFixture(page)

    before = await invokeDiffTestApi(page, 'getDiffValues')
    await hoverDiffLine(page, fixture.hoverRootSelector, fixture.hoverLineText)
    await clickHunkAction(page, scenario.side, scenario.action)
    await waitForExpectedState(
      page,
      scenario.expected,
      scenario.expectedDiffCount ?? 0,
    )

    const after = await invokeDiffTestApi(page, 'getDiffValues')
    const summary = await invokeDiffTestApi(page, 'getDiffSummary')
    const actionLogs = await invokeDiffTestApi(page, 'getActionLogs')
    const expectedPrefix = `${scenario.action.toUpperCase()} ${scenario.side} |`
    const firstLog = actionLogs[0] ?? null
    const ok =
      after.original === scenario.expected.original &&
      after.modified === scenario.expected.modified &&
      summary.diffCount === (scenario.expectedDiffCount ?? 0) &&
      typeof firstLog === 'string' &&
      firstLog.startsWith(expectedPrefix)

    return {
      name: scenario.name,
      side: scenario.side,
      action: scenario.action,
      ok,
      firstLog,
      before,
      after,
      summary,
    }
  } catch (error) {
    const after =
      await invokeDiffTestApi(page, 'getDiffValues').catch(() => null)
    const summary =
      await invokeDiffTestApi(page, 'getDiffSummary').catch(() => null)
    const actionLogs =
      await invokeDiffTestApi(page, 'getActionLogs').catch(() => [])

    return {
      name: scenario.name,
      side: scenario.side,
      action: scenario.action,
      ok: false,
      error: String(error),
      before,
      after,
      summary,
      actionLogs,
    }
  }
}

async function run() {
  const port = process.env.PORT ? Number(process.env.PORT) : await findFreePort()
  if (!Number.isFinite(port))
    throw new Error(`Invalid PORT: ${process.env.PORT}`)

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
  vite.stdout.on('data', (chunk) => logs.push(String(chunk)))
  vite.stderr.on('data', (chunk) => logs.push(String(chunk)))

  const onExit = () => killProcessTree(vite)
  process.on('SIGINT', onExit)
  process.on('SIGTERM', onExit)
  process.on('exit', onExit)

  try {
    await waitForPort(port)

    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 1,
    })

    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => {
      pageErrors.push(String(error))
    })
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    const url = `http://127.0.0.1:${port}/diff-ux?style=background&scenario=streaming&theme=vitesse-light&appearance=light`
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForSelector('.editor-card', { timeout: 20000 })
    await page.waitForSelector('.monaco-diff-editor', { timeout: 20000 })
    await page.waitForFunction(
      () => typeof window.__streamMonacoDiffTestApi?.getDiffValues === 'function',
      { timeout: 20000 },
    )
    await page.waitForTimeout(800)

    const results = []
    for (const scenario of cases) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runCase(page, scenario))
    }

    await browser.close()

    const ok =
      pageErrors.length === 0 &&
      consoleErrors.length === 0 &&
      results.every((result) => result.ok)

    const result = {
      ok,
      url,
      pageErrors,
      consoleErrors,
      results,
    }

    console.log(JSON.stringify(result, null, 2))

    if (!ok) {
      console.error('Diff hunk action validation failed; recent Vite logs:\n')
      console.error(logs.slice(-60).join(''))
      process.exit(1)
    }
  } finally {
    killProcessTree(vite)
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
