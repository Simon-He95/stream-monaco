// Lightweight benchmark for updateCode throttling and batching logic.
// This script mocks a minimal subset of Monaco editor API used by useMonaco
// and exercises updateCode at high frequency to compare CPU/time behavior.

import { performance } from 'node:perf_hooks'

// Load the compiled source if available, otherwise load TS source via ts-node is out of scope.
// We'll directly import the source file (ESM) assuming Node can load it; however the module
// depends on 'monaco-shim' and browser APIs. Instead, we'll directly benchmark the
// core flush/update logic by copying minimal parts into this script as a function.

// For simplicity, we simulate a minimal "editor wrapper" with similar logic to useMonaco
// focusing on updateCode/flushPendingUpdate/append buffering behavior.

function createMockEditor() {
  let value = ''
  return {
    getModel() {
      return {
        getValue() { return value },
        setValue(v) { value = v },
        getLineCount() { return value.split('\n').length },
        getLanguageId() { return 'javascript' },
        getLineMaxColumn(line) { return (value.split('\n')[line - 1] || '').length + 1 },
      }
    },
    getValue() { return value },
    executeEdits(_, edits) {
      for (const e of edits) {
        // append-only benchmark: assume appends only
        value += e.text
      }
    },
    getOption() { return false },
  }
}

// Minimal wrapper implementing only the paths used by the benchmark
function createWrapper(opts = {}) {
  const appendBuffer = []
  const appendBufferScheduled = false
  let pendingUpdate = null
  let lastKnownCode = ''
  const throttleMs = opts.updateThrottleMs ?? 50
  let lastFlushTime = 0
  let throttleTimer = null
  const editorView = createMockEditor()

  function flushPendingUpdate() {
    lastFlushTime = Date.now()
    if (!pendingUpdate)
      return
    const model = editorView.getModel()
    const { code } = pendingUpdate
    pendingUpdate = null
    const prev = lastKnownCode || model.getValue()
    if (prev === code)
      return
    if (code.startsWith(prev)) {
      const suffix = code.slice(prev.length)
      if (suffix) {
        appendBuffer.push(suffix)
      }
      lastKnownCode = code
      return
    }
    // fallback full replace
    model.setValue(code)
    lastKnownCode = code
  }

  function flushAppendBuffer() {
    if (appendBuffer.length === 0)
      return
    const text = appendBuffer.join('')
    appendBuffer.length = 0
    editorView.executeEdits('append', [{ range: null, text }])
  }

  function updateCode(code) {
    pendingUpdate = { code }
    // schedule via RAF-like (here immediate) then apply throttle
    // emulate raf by setImmediate
    setImmediate(() => {
      if (!throttleMs) {
        flushPendingUpdate(); return
      }
      const now = Date.now()
      const since = now - lastFlushTime
      if (since >= throttleMs) { flushPendingUpdate(); return }
      if (throttleTimer != null)
        return
      const wait = throttleMs - since
      throttleTimer = setTimeout(() => { throttleTimer = null; setImmediate(flushPendingUpdate) }, wait)
    })
  }

  return { updateCode, flushAppendBuffer, editorView }
}

// Run benchmark: send N updates at freq Hz
async function run({ updates = 2000, freqHz = 200, throttleMs = 50 }) {
  const wrapper = createWrapper({ updateThrottleMs: throttleMs })
  const intervalMs = 1000 / freqHz
  const sent = 0
  const start = performance.now()

  for (let i = 0; i < updates; i++) {
    wrapper.updateCode(''.padEnd(i + 1, 'a'))
    // busy wait to respect frequency
    const t0 = performance.now()
    while (performance.now() - t0 < intervalMs) { /* noop */ }
  }

  // allow pending timers to flush
  await new Promise(r => setTimeout(r, throttleMs + 100))
  const end = performance.now()
  const finalValue = wrapper.editorView.getModel().getValue()
  const elapsed = end - start
  const avgMsPerUpdate = elapsed / updates

  const out = {
    updates,
    freqHz,
    throttleMs,
    elapsedMs: Math.round(elapsed),
    avgMsPerUpdate: avgMsPerUpdate.toFixed(3),
    finalLength: finalValue.length,
  }

  console.log(JSON.stringify(out, null, 2))
}

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/stream-benchmark.mjs [updates] [freqHz] [throttleMs]')
  process.exit(0)
}

const updates = Number(process.argv[2] || 2000)
const freqHz = Number(process.argv[3] || 200)
const throttleMs = Number(process.argv[4] || 50)
run({ updates, freqHz, throttleMs }).catch((err) => { console.error(err); process.exit(1) })
