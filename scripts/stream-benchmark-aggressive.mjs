import { performance } from 'node:perf_hooks'

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

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
        value += e.text
      }
    },
    getOption() { return false },
  }
}

function createWrapper(opts = {}) {
  const appendBuffer = []
  let appendBufferScheduled = false
  let pendingUpdate = null
  let lastKnownCode = ''
  const throttleMs = opts.updateThrottleMs ?? 0
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

    // Build prevCode including buffered (mirror recent EditorManager fix)
    const buffered = appendBuffer.length > 0 ? appendBuffer.join('') : ''
    const prevCode = (appendBuffer.length > 0) ? (editorView.getValue() + buffered) : (lastKnownCode || editorView.getValue())

    if (prevCode === code)
      return
    if (code.startsWith(prevCode) && prevCode.length < code.length) {
      const suffix = code.slice(prevCode.length)
      if (suffix)
        appendCode(suffix)
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
    const parts = appendBuffer.splice(0)
    const text = parts.join('')
    appendBuffer.length = 0
    editorView.executeEdits('append', [{ range: null, text }])
    // sync lastKnownCode
    try { lastKnownCode = editorView.getModel().getValue() } catch {}
  }

  function scheduleAppendFlush() {
    if (appendBufferScheduled)
      return
    appendBufferScheduled = true
    // emulate raf frame
    setTimeout(() => {
      appendBufferScheduled = false
      flushAppendBuffer()
    }, 0)
  }

  function appendCode(appendText) {
    if (!appendText) return
    appendBuffer.push(appendText)
    scheduleAppendFlush()
  }

  function updateCode(code) {
    pendingUpdate = { code }
    // emulate RAF-like immediate schedule
    setImmediate(() => {
      if (!throttleMs) { flushPendingUpdate(); return }
      const now = Date.now()
      const since = now - lastFlushTime
      if (since >= throttleMs) { flushPendingUpdate(); return }
      if (throttleTimer != null) return
      const wait = throttleMs - since
      throttleTimer = setTimeout(() => { throttleTimer = null; setImmediate(flushPendingUpdate) }, wait)
    })
  }

  return { updateCode, appendCode, flushAppendBuffer, editorView }
}

async function run({ iterations = 200, blockSize = 50, intervalMs = 1, throttleMs = 0 }) {
  const wrapper = createWrapper({ updateThrottleMs: throttleMs })
  let expected = ''
  const block = 'x'.repeat(blockSize)
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    expected += block
    wrapper.updateCode(expected)
    await sleep(intervalMs)
  }
  // wait for pending timers and flushes
  await sleep(500 + throttleMs)
  const end = performance.now()
  const finalValue = wrapper.editorView.getModel().getValue()
  const ok = finalValue === expected
  console.log(JSON.stringify({ iterations, blockSize, intervalMs, throttleMs, ok, expectedLength: expected.length, finalLength: finalValue.length, elapsedMs: Math.round(end - start) }, null, 2))
  if (!ok) {
    // print small diff info
    let i = 0
    while (i < Math.min(finalValue.length, expected.length) && finalValue[i] === expected[i]) i++
    console.log('first mismatch at index', i)
    console.log('expected slice', expected.slice(Math.max(0, i - 40), i + 40))
    console.log('actual   slice', finalValue.slice(Math.max(0, i - 40), i + 40))
  }
}

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/stream-benchmark-aggressive.mjs [iterations] [blockSize] [intervalMs] [throttleMs]')
  process.exit(0)
}

const iterations = Number(process.argv[2] || 200)
const blockSize = Number(process.argv[3] || 50)
const intervalMs = Number(process.argv[4] || 1)
const throttleMs = Number(process.argv[5] || 0)

run({ iterations, blockSize, intervalMs, throttleMs }).catch(err => { console.error(err); process.exit(1) })
