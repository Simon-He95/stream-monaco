#!/usr/bin/env node
// Validate that streaming appends do not leave stale full-tail diff
// highlights when only sparse earlier lines actually differ.

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
    const socket = net.createConnection({ host, port })
    socket.on('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => {
      socket.destroy()
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

async function waitForPort(port, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortOpen(port)) return
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for port ${port}`)
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
  const port = await findFreePort()
  const vite = spawn(
    'pnpm',
    ['-C', demoDir, 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
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
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } })
    await page.goto(`http://127.0.0.1:${port}/diff`, { waitUntil: 'networkidle' })

    const result = await page.evaluate(async () => {
      const mod = await import('/@fs/Users/Simon/Github/stream-monaco/src/index.ts')
      document.body.innerHTML = '<div id="probe" style="width:1600px;height:900px"></div>'
      const container = document.getElementById('probe')
      if (!(container instanceof HTMLElement))
        throw new Error('Missing probe container')

      mod.preloadMonacoWorkers?.()

      const api = mod.useMonaco({
        readOnly: true,
        theme: 'vitesse-light',
        themes: ['vitesse-dark', 'vitesse-light'],
        diffAlgorithm: 'legacy',
        renderSideBySide: true,
        diffLineStyle: 'background',
        diffHideUnchangedRegions: false,
        diffUpdateThrottleMs: 120,
        ignoreTrimWhitespace: false,
        renderIndicators: true,
      })

      const readChangedLineNumbers = () => {
        const readSide = (selector) =>
          [...new Set(
            Array.from(document.querySelectorAll(selector))
            .map((node) => ({
              line: Number.parseInt(node.textContent?.trim() || '', 10),
              className: node.className,
            }))
            .filter((entry) =>
              Number.isFinite(entry.line) &&
              /line-delete|line-insert|stream-monaco-fallback-line-number-delete|stream-monaco-fallback-line-number-insert/.test(
                entry.className,
              ),
            )
            .map(entry => entry.line),
          )].sort((a, b) => a - b)

        return {
          original: readSide('.editor.original .line-numbers'),
          modified: readSide('.editor.modified .line-numbers'),
          stale: document.querySelector('.stream-monaco-diff-root')?.classList.contains(
            'stream-monaco-diff-native-stale',
          ) ?? false,
        }
      }

      const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

      const buildLines = (count) =>
        Array.from({ length: count }, (_, index) => {
          const lineNumber = index + 1
          return `  "line${String(lineNumber).padStart(2, '0')}": "value-${String(lineNumber).padStart(2, '0')}",`
        })

      const scenarios = [
        {
          name: 'single-early-diff',
          originalLines: ['{', ...buildLines(22), '}'],
          mutate(modifiedLines) {
            modifiedLines[3] = '  "line03": "value-03-updated",'
          },
          startLine: 4,
          sampleUntilLine: 24,
          expectedAtLine(uptoLine) {
            return uptoLine >= 4 ? [4] : []
          },
        },
        {
          name: 'sparse-double-diff',
          originalLines: ['{', ...buildLines(22), '}'],
          mutate(modifiedLines) {
            modifiedLines[3] = '  "line03": "value-03-updated",'
            modifiedLines[19] = '  "line19": "value-19-updated",'
          },
          startLine: 4,
          sampleUntilLine: 24,
          expectedAtLine(uptoLine) {
            if (uptoLine < 4) return []
            if (uptoLine < 20) return [4]
            return [4, 20]
          },
        },
      ]

      const runScenario = async (scenario) => {
        const modifiedLines = [...scenario.originalLines]
        scenario.mutate(modifiedLines)

        await api.createDiffEditor(
          container,
          scenario.originalLines.slice(0, scenario.startLine).join('\n'),
          modifiedLines.slice(0, scenario.startLine).join('\n'),
          'json',
        )

        const frames = []
        for (let lineNumber = scenario.startLine + 1; lineNumber <= scenario.sampleUntilLine; lineNumber++) {
          api.updateDiff(
            scenario.originalLines.slice(0, lineNumber).join('\n'),
            modifiedLines.slice(0, lineNumber).join('\n'),
            'json',
          )
          // Intentionally sample before Monaco's native diff is guaranteed to
          // have settled so we validate the stale-diff fallback path.
          // eslint-disable-next-line no-await-in-loop
          await wait(40)
          frames.push({
            uptoLine: lineNumber,
            expected: scenario.expectedAtLine(lineNumber),
            ...readChangedLineNumbers(),
          })
        }

        await wait(240)
        const settled = {
          expected: scenario.expectedAtLine(scenario.sampleUntilLine),
          ...readChangedLineNumbers(),
        }

        return {
          name: scenario.name,
          frames,
          settled,
        }
      }

      const scenarioResults = []
      for (const scenario of scenarios) {
        // eslint-disable-next-line no-await-in-loop
        scenarioResults.push(await runScenario(scenario))
      }

      return { scenarios: scenarioResults }
    })

    const scenarios = result.scenarios.map((scenario) => {
      const framesOk = scenario.frames.every((frame) => {
        return (
          JSON.stringify(frame.original) === JSON.stringify(frame.expected) &&
          JSON.stringify(frame.modified) === JSON.stringify(frame.expected)
        )
      })
      const settledOk
        = JSON.stringify(scenario.settled.original) === JSON.stringify(scenario.settled.expected)
          && JSON.stringify(scenario.settled.modified) === JSON.stringify(scenario.settled.expected)

      return {
        ...scenario,
        ok: framesOk && settledOk,
      }
    })
    const ok = scenarios.every(scenario => scenario.ok)

    console.log(JSON.stringify({ ok, scenarios }, null, 2))

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
