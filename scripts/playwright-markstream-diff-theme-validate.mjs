#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const markstreamRoot = '/Users/Simon/Github/markstream-vue'
const playgroundDir = path.join(markstreamRoot, 'playground')
const host = '127.0.0.1'
const node23Bin = '/Users/Simon/.local/share/fnm/node-versions/v23.11.0/installation/bin'

function isPortOpen(port) {
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

async function findFreePort(start = 4236, end = 4280) {
  for (let port = start; port <= end; port++) {
    if (!await isPortOpen(port))
      return port
  }
  throw new Error(`No free port found in ${start}-${end}`)
}

async function waitForPort(port, timeout = 30000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (await isPortOpen(port))
      return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${host}:${port}`)
}

function killProcessTree(child) {
  if (!child || child.killed)
    return
  try {
    child.kill('SIGTERM')
  }
  catch {}
  setTimeout(() => {
    try {
      if (!child.killed)
        child.kill('SIGKILL')
    }
    catch {}
  }, 3000).unref?.()
}

function resolveChromeLaunchOptions() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        executablePath: candidate,
        headless: true,
      }
    }
  }

  return {
    channel: 'chrome',
    headless: true,
  }
}

function colorLuminance(color) {
  const channels = String(color || '').match(/\d+(?:\.\d+)?/g)
  if (!channels || channels.length < 3)
    return null
  const [r, g, b] = channels.slice(0, 3).map(Number)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

async function snapshot(page) {
  return page.evaluate(() => {
    function visibleTexts(selector) {
      return Array.from(document.querySelectorAll(selector))
        .filter((node) => {
          if (!(node instanceof HTMLElement))
            return false
          const text = node.innerText?.trim() ?? ''
          if (!text)
            return false
          const style = window.getComputedStyle(node)
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number.parseFloat(style.opacity || '1') > 0.05
        })
        .map(node => node.innerText.trim())
    }

    const container = document.querySelector('.code-block-container')
    const header = document.querySelector('.code-block-header')
    const diffRoot = document.querySelector('.stream-monaco-diff-root')
    const editorBackground = diffRoot?.querySelector('.monaco-editor .monaco-editor-background')
    const themeSelect = document.querySelector('select[aria-label="Code block theme"]')
    const settingsPanel = document.querySelector('.settings-toggle')?.parentElement

    const containerStyle = container instanceof HTMLElement ? window.getComputedStyle(container) : null
    const headerStyle = header instanceof HTMLElement ? window.getComputedStyle(header) : null
    const editorStyle = editorBackground instanceof HTMLElement ? window.getComputedStyle(editorBackground) : null

    return {
      containerClass: container instanceof HTMLElement ? container.className : '',
      rootClasses: diffRoot instanceof HTMLElement ? Array.from(diffRoot.classList) : [],
      containerBg: containerStyle?.backgroundColor || '',
      headerBg: headerStyle?.backgroundColor || '',
      editorBg: editorStyle?.backgroundColor || '',
      selectedTheme: themeSelect instanceof HTMLSelectElement ? themeSelect.value : '',
      settingsOpen: settingsPanel instanceof HTMLElement
        ? settingsPanel.querySelector('select[aria-label="Code block theme"]') instanceof HTMLElement
        : false,
      visibleNativeCompactTexts: visibleTexts('.diff-hidden-lines-compact .text'),
      visibleNativeCenterTexts: visibleTexts('.diff-hidden-lines .center'),
      visibleHiddenLinesInBody: /hidden lines/i.test(document.body.innerText || ''),
    }
  })
}

async function openSettings(page) {
  const toggle = page.locator('.settings-toggle').first()
  await toggle.waitFor({ state: 'visible', timeout: 30000 })
  const select = page.locator('select[aria-label="Code block theme"]')
  if (await select.count()) {
    const visible = await select.first().isVisible().catch(() => false)
    if (visible)
      return
  }
  await toggle.click()
  await select.first().waitFor({ state: 'visible', timeout: 30000 })
}

async function toggleDarkMode(page) {
  await openSettings(page)
  const darkModeRow = page.locator('label', { hasText: 'Dark Mode' }).locator('..')
  const button = darkModeRow.locator('button').first()
  await button.waitFor({ state: 'visible', timeout: 30000 })
  await button.click()
}

async function captureTransition(page) {
  const frames = []
  for (let i = 0; i < 72; i++) {
    await page.waitForTimeout(16)
    frames.push(await snapshot(page))
  }
  return frames
}

async function ensureSelectedTheme(page, value) {
  await openSettings(page)
  const select = page.locator('select[aria-label="Code block theme"]').first()
  await select.selectOption(value)
  await page.waitForTimeout(1200)
}

async function main() {
  const port = process.env.PORT ? Number(process.env.PORT) : await findFreePort()
  const vite = spawn(
    'pnpm',
    ['-C', playgroundDir, 'dev', '--host', host, '--port', String(port), '--strictPort'],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${node23Bin}:${process.env.PATH || ''}`,
      },
    },
  )

  const logs = []
  vite.stdout.on('data', chunk => logs.push(String(chunk)))
  vite.stderr.on('data', chunk => logs.push(String(chunk)))

  const cleanup = () => killProcessTree(vite)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', cleanup)

  try {
    await waitForPort(port)

    const browser = await chromium.launch(resolveChromeLaunchOptions())
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1200 },
      colorScheme: 'light',
    })

    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => {
      pageErrors.push(String(error))
    })
    page.on('console', (message) => {
      if (message.type() === 'error')
        consoleErrors.push(message.text())
    })

    await page.addInitScript(() => {
      localStorage.setItem('vmr-settings-selected-theme', 'vitesse-dark')
      localStorage.setItem('vueuse-color-scheme', 'light')
    })

    await page.goto(`http://${host}:${port}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.monaco-diff-editor', { timeout: 30000 })
    await page.waitForTimeout(1600)

    await ensureSelectedTheme(page, 'vitesse-dark')

    const initial = await snapshot(page)
    await toggleDarkMode(page)
    const toDarkFrames = await captureTransition(page)
    const afterDark = toDarkFrames[toDarkFrames.length - 1] ?? await snapshot(page)
    await toggleDarkMode(page)
    const toLightFrames = await captureTransition(page)
    const afterLight = toLightFrames[toLightFrames.length - 1] ?? await snapshot(page)

    await browser.close()

    const allFrames = [initial, ...toDarkFrames, ...toLightFrames]
    const anyHiddenFlash = allFrames.some(frame =>
      frame.visibleHiddenLinesInBody
      || frame.visibleNativeCompactTexts.length > 0
      || frame.visibleNativeCenterTexts.some(text => /hidden lines/i.test(text)),
    )

    const initialLum = colorLuminance(initial.containerBg)
    const darkLum = colorLuminance(afterDark.containerBg)
    const lightLum = colorLuminance(afterLight.containerBg)

    const result = {
      ok:
        initial.selectedTheme === 'vitesse-dark'
        && initial.rootClasses.includes('stream-monaco-diff-appearance-light')
        && initialLum != null && initialLum > 170
        && afterDark.rootClasses.includes('stream-monaco-diff-appearance-dark')
        && darkLum != null && darkLum < 90
        && afterLight.rootClasses.includes('stream-monaco-diff-appearance-light')
        && lightLum != null && lightLum > 170
        && !anyHiddenFlash
        && pageErrors.length === 0
        && consoleErrors.length === 0,
      initial,
      afterDark,
      afterLight,
      anyHiddenFlash,
      pageErrors,
      consoleErrors,
    }

    console.log(JSON.stringify(result, null, 2))
    if (!result.ok)
      process.exitCode = 1
  }
  catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    console.error(message)
    process.exitCode = 1
  }
  finally {
    cleanup()
  }
}

main()
