// Fuzz runner to repeatedly simulate streaming updates and detect duplicated tails
// The simulation mirrors the logic used in EditorManager/index: use optimistic
// lastKnownCode but appendBuffer flush happens only on frame boundaries.

function createSim() {
  let lastKnownCode = ''
  let pendingUpdate = null
  const appendBuffer = []
  let appendBufferScheduled = false

  function appendCode(s) {
    appendBuffer.push(s)
    if (!appendBufferScheduled) appendBufferScheduled = true
  }

  function flushAppendBuffer(model) {
    if (!appendBufferScheduled) return
    appendBufferScheduled = false
    const text = appendBuffer.join('')
    appendBuffer.length = 0
    model.value += text
  }

  function flushPendingUpdate(model) {
    if (!pendingUpdate) return
    const newCode = pendingUpdate
    pendingUpdate = null
    // Use authoritative model value when appendBuffer pending
    const prevCode = (appendBuffer.length > 0) ? model.value : (lastKnownCode ?? model.value)
    if (prevCode === newCode) return
    if (newCode.startsWith(prevCode) && prevCode.length < newCode.length) {
      const suffix = newCode.slice(prevCode.length)
      if (suffix) appendCode(suffix)
      lastKnownCode = newCode
      return
    }
    model.value = newCode
    lastKnownCode = newCode
  }

  function updateCode(code) {
    pendingUpdate = code
  }

  return { updateCode, flushPendingUpdate, flushAppendBuffer }
}

const markdown = `
# Create Vue project
npm create vue@latest electron-vue-chat

# Navigate to project
cd electron-vue-chat

# Install dependencies
npm install
npm install electron electron-builder vue-router

# Install dev dependencies
npm install -D electron-dev-server concurrently wait-on
`

function oneRun(opts) {
  // opts: { flushEvery, randomizeFlush, jitter }
  const sim = createSim()
  const model = { value: '' }
  let i = 0
  const len = markdown.length
  let step = 0
  for (i = 1; i <= len; i++) {
    const contents = markdown.slice(0, i)
    sim.updateCode(contents)
    // decide whether to flush this frame
    let doFlush = false
    if (opts.randomizeFlush) {
      // random flush with probability p
      doFlush = Math.random() < opts.flushProbability
    }
    else {
      doFlush = (i % opts.flushEvery) === 0
    }
    if (doFlush) {
      // apply pending update then flush buffer
      sim.flushPendingUpdate(model)
      // optionally apply jitter: maybe flush append buffer now or delayed
      if (opts.jitter) {
        if (Math.random() < 0.5) sim.flushAppendBuffer(model)
        // else we delay and allow next flush to consume
      }
      else {
        sim.flushAppendBuffer(model)
      }
    }
  }
  // final flush at the end
  sim.flushPendingUpdate(model)
  sim.flushAppendBuffer(model)
  return model.value
}

function detectDup(s) {
  // heuristics: look for repeated substrings of length >= 3 at the end
  // e.g., 'wait-on' -> 'wait-t-onon' contains 'onon'
  // we'll search for any repeat of last 2..6 char sequences
  for (let k = 2; k <= 8; k++) {
    if (s.length < k * 2) continue
    const a = s.slice(-k)
    const b = s.slice(-k * 2, -k)
    if (a === b) return { dup: true, fragment: a }
  }
  return { dup: false }
}

function runFuzz(runs = 1000) {
  let failures = []
  for (let r = 0; r < runs; r++) {
    const opts = {}
    // randomly choose a flush strategy
    if (Math.random() < 0.5) {
      opts.randomizeFlush = false
      // flushEvery between 1 and 200
      opts.flushEvery = Math.floor(Math.random() * 200) + 1
    }
    else {
      opts.randomizeFlush = true
      opts.flushProbability = Math.random() * 0.5 + 0.01
    }
    opts.jitter = Math.random() < 0.4
    const out = oneRun(opts)
    const res = detectDup(out)
    if (res.dup) {
      failures.push({ run: r, opts, dup: res.fragment, out })
    }
  }
  return failures
}

const runs = Number(process.argv[2] || 1000)
console.log('starting fuzz runs:', runs)
const fails = runFuzz(runs)
console.log('failures:', fails.length)
if (fails.length > 0) console.log(fails.slice(0, 10))
else console.log('no duplicates detected')
