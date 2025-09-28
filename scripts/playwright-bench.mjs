#!/usr/bin/env node
// Headless Playwright benchmark that creates a Monaco editor in a page and
// runs a high-frequency update scenario to collect timing and long-task info.

import { chromium } from 'playwright'

async function run({ updates = 2000, freqHz = 200, append = false } = {}) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  // minimal HTML that loads Monaco from CDN and creates a container
  const html = `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <style>html,body,#editor{height:100%;margin:0;padding:0}</style>
  </head>
  <body>
    <div id="editor"></div>
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js"></script>
    <script>
      require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
      window.__benchReady = new Promise((res) => {
        require(['vs/editor/editor.main'], function () {
          window.editor = monaco.editor.create(document.getElementById('editor'), {
            value: '',
            language: 'javascript',
            automaticLayout: true,
          });
          res(true)
        })
      })
    </script>
  </body>
  </html>`

  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => window.__benchReady)

  // run the benchmark inside the page
  const result = await page.evaluate(async ({ updates, freqHz, append, payloadSize, random }) => {
    const editor = window.editor
    const model = editor.getModel()

    // observe long tasks
    let longTasks = 0
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration && entry.duration > 50)
            longTasks++
        }
      })
      obs.observe({ type: 'longtask', buffered: true })
    }
    catch { }

    const interval = 1000 / freqHz
    const start = performance.now()

    for (let i = 0; i < updates; i++) {
      const text = 'a'.repeat(i % 1000)
      if (append) {
        // append via executeEdits
        const lastLine = model.getLineCount()
        const lastCol = model.getLineMaxColumn(lastLine)
        model.applyEdits([{ range: new monaco.Range(lastLine, lastCol, lastLine, lastCol), text }])
      }
      else {
        model.setValue(text)
      }
      // busy wait to emulate frequency
      const t0 = performance.now()
      while (performance.now() - t0 < interval) {}
    }

    // allow observers to flush
    await new Promise(r => setTimeout(r, 200))
    const end = performance.now()
    return { updates, freqHz, elapsedMs: Math.round(end - start), longTasks }
  }, { updates, freqHz, append })

  await browser.close()
  return result
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith('playwright-bench.mjs'))) {
  // Robust CLI parsing: support running directly or via `pnpm run bench:playwright -- ...`
  // process.argv can contain additional npm/pnpm wrapper args, so parse slice(2)
  const raw = process.argv.slice(2)
  // Accept: <updates> <freqHz> [append]
  let updates = 2000
  let freqHz = 200
  let append = false

  if (raw.length >= 1) {
    const n = Number(raw[0])
    if (!Number.isNaN(n) && isFinite(n))
      updates = n
  }
  if (raw.length >= 2) {
    const n = Number(raw[1])
    if (!Number.isNaN(n) && isFinite(n))
      freqHz = n
  }
  // allow append to appear anywhere in args
  if (raw.some(a => a === 'append' || a === '--append'))
    append = true

  // If caller asked for 'compare', run three benches with different throttle values
  const rawArgs = raw
  if (rawArgs.includes('compare') || rawArgs.includes('--compare')) {
    // parse optional payload size and random flag from args
    // payloadSize: any numeric arg after the first two (updates, freqHz)
    let payloadSize = 1000
    const numericArgs = rawArgs.map(a => Number(a)).filter(n => !Number.isNaN(n) && isFinite(n))
    if (numericArgs.length >= 3)
      payloadSize = numericArgs[2]
    const random = rawArgs.includes('random') || rawArgs.includes('--random')

    // throttle values to compare (ms)
    const throttleValues = [0, 50, 100]
    const results = []
    for (const t of throttleValues) {
      try {
        const r = await runWithThrottle({ updates, freqHz, append, throttle: t, payloadSize, random })
        results.push({ throttle: t, payloadSize, random, result: r })
      }
      catch (err) {
        console.error('compare run failed for throttle', t, err)
        results.push({ throttle: t, payloadSize, random, error: String(err) })
      }
    }
    console.log(JSON.stringify({ compare: true, updates, freqHz, append, payloadSize, random, runs: results }, null, 2))
    process.exit(0)
  }

  run({ updates, freqHz, append }).then(r => console.log(JSON.stringify(r, null, 2))).catch((err) => { console.error(err); process.exit(1) })
}

// Helper that loads the page, sets up a throttled update wrapper in-page, and runs the bench
async function runWithThrottle({ updates = 2000, freqHz = 200, append = false, throttle = 50, payloadSize = 1000, random = false } = {}) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  const html = `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <style>html,body,#editor{height:100%;margin:0;padding:0}</style>
  </head>
  <body>
    <div id="editor"></div>
    <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js"></script>
    <script>
      require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
      window.__benchReady = new Promise((res) => {
        require(['vs/editor/editor.main'], function () {
          window.editor = monaco.editor.create(document.getElementById('editor'), {
            value: '',
            language: 'javascript',
            automaticLayout: true,
          });
          // create a throttled updateCode wrapper that batches setValue calls
          (function(){
            let pending = null
            let timer = null
            const throttle = ${throttle}
            const payloadSize = ${payloadSize}
            const random = ${random}

            function makePayload(i) {
              if (random) {
                // simple pseudo-random string of payloadSize
                let s = ''
                for (let k = 0; k < payloadSize; k++) s += String.fromCharCode(97 + (Math.floor(Math.random() * 26)))
                return s
              }
              return 'x'.repeat(payloadSize)
            }
            window.__updateWithThrottle = function(text){
              if (throttle === 0) {
                try { window.editor.getModel().setValue(text) } catch(e) {}
                return
              }
              pending = text
              if (timer != null) return
              timer = setTimeout(() => {
                try { window.editor.getModel().setValue(pending || '') } catch(e) {}
                pending = null
                timer = null
              }, throttle)
            }
          })()
          res(true)
        })
      })
    </script>
  </body>
  </html>`

  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => window.__benchReady)

  const result = await page.evaluate(async ({ updates, freqHz, append, payloadSize, random }) => {
    const editor = window.editor
    const model = editor.getModel()

    // observe long tasks
    let longTasks = 0
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration && entry.duration > 50)
            longTasks++
        }
      })
      obs.observe({ type: 'longtask', buffered: true })
    }
    catch { }

    const interval = 1000 / freqHz
    const start = performance.now()

    for (let i = 0; i < updates; i++) {
      let text
      if (random) {
        // simple deterministic-ish random per iteration
        const arr = new Array(payloadSize)
        for (let k = 0; k < payloadSize; k++) arr[k] = String.fromCharCode(97 + ((i + k) % 26))
        text = arr.join('')
      }
      else {
        text = 'x'.repeat(payloadSize)
      }
      if (append) {
        const lastLine = model.getLineCount()
        const lastCol = model.getLineMaxColumn(lastLine)
        model.applyEdits([{ range: new monaco.Range(lastLine, lastCol, lastLine, lastCol), text }])
      }
      else {
        // use the throttled API if present
        if (typeof window.__updateWithThrottle === 'function') {
          window.__updateWithThrottle(text)
        }
        else {
          model.setValue(text)
        }
      }
      const t0 = performance.now()
      while (performance.now() - t0 < interval) {}
    }

    await new Promise(r => setTimeout(r, 200))
    const end = performance.now()
    return { updates, freqHz, elapsedMs: Math.round(end - start), longTasks }
  }, { updates, freqHz, append, payloadSize, random })

  await browser.close()
  return result
}
