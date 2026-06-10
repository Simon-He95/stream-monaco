#!/usr/bin/env node

import process from 'node:process'
import { spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'

function runPnpmScript(script, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['run', script], {
      stdio: 'inherit',
      shell: isWindows,
      env: process.env,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        const err = new Error(`${script} was terminated by ${signal}`)
        err.code = 1
        reject(err)
        return
      }
      const exitCode = code ?? 0
      if (exitCode !== 0 && !allowFailure) {
        const err = new Error(`${script} failed with exit code ${exitCode}`)
        err.code = exitCode
        reject(err)
        return
      }
      resolve(exitCode)
    })
  })
}

async function runRequired(script) {
  console.log(`\n[release:verify] ${script}`)
  await runPnpmScript(script)
}

async function runAnalyzeBestEffort() {
  console.log('\n[release:verify] perf:analyze')
  try {
    await runPnpmScript('perf:analyze', { allowFailure: true })
  }
  catch (err) {
    console.warn(
      '[release:verify] perf:analyze could not run:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

async function main() {
  const prePerfSteps = [
    'lint',
    'typecheck',
    'test',
    'smoke:diff',
    'smoke:height-stability',
  ]

  for (const step of prePerfSteps)
    await runRequired(step)

  let perfExitCode = 0
  console.log('\n[release:verify] perf:gate:release')
  try {
    await runPnpmScript('perf:gate:release')
  }
  catch (err) {
    perfExitCode = typeof err?.code === 'number' ? err.code : 1
    await runAnalyzeBestEffort()
    process.exitCode = perfExitCode
    return
  }

  await runAnalyzeBestEffort()
}

main().catch((err) => {
  console.error(
    '\n[release:verify] failed:',
    err instanceof Error ? err.message : String(err),
  )
  process.exit(typeof err?.code === 'number' ? err.code : 1)
})
