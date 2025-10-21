// Simulate EditorManager append/flush logic to reproduce duplication bug
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
    const prevCode = lastKnownCode ?? model.value
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
    // emulate raf -> we won't auto flush here; test harness controls flush timing
  }

  return { updateCode, flushPendingUpdate, flushAppendBuffer, getState: () => ({ lastKnownCode, appendBuffer: appendBuffer.slice() }) }
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

function run(simulateFrameEvery) {
  const sim = createSim()
  const model = { value: '' }
  let contents = ''
  let i = 0
  const len = markdown.length
  let frames = 0
  while (i <= len) {
    i++
    contents = markdown.slice(0, i)
    sim.updateCode(contents)
    if (i % simulateFrameEvery === 0 || i === len) {
      // flush pending and apply appendBuffer
      sim.flushPendingUpdate(model)
      sim.flushAppendBuffer(model)
      frames++
    }
  }
  return { final: model.value, frames }
}

console.log('simulate flush every 1 (per char):', run(1))
console.log('simulate flush every 5:', run(5))
console.log('simulate flush every 10:', run(10))
console.log('simulate flush every 50:', run(50))
console.log('simulate flush every 200:', run(200))
console.log('simulate flush every 1000:', run(1000))
