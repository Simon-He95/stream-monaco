export function createMockWrapper(opts: { updateThrottleMs?: number } = {}) {
  const appendBuffer: string[] = []
  let appendBufferScheduled = false
  let pendingUpdate: { code: string } | null = null
  let lastKnownCode = ''
  let throttleMs = opts.updateThrottleMs ?? 50
  let lastFlushTime = 0
  let throttleTimer: ReturnType<typeof setTimeout> | null = null

  const model = {
    value: '',
    getValue() { return this.value },
    setValue(v: string) { this.value = v },
    getLineCount() { return this.value.split('\n').length },
    getLanguageId() { return 'javascript' },
  }

  function flushPendingUpdate() {
    lastFlushTime = Date.now()
    if (!pendingUpdate)
      return
    const { code } = pendingUpdate
    pendingUpdate = null
    const prev = lastKnownCode || model.getValue()
    if (prev === code)
      return
    if (code.startsWith(prev)) {
      const suffix = code.slice(prev.length)
      if (suffix) {
        appendBuffer.push(suffix)
        // schedule append flush on next tick
        if (!appendBufferScheduled) {
          appendBufferScheduled = true
          setImmediate(() => {
            const text = appendBuffer.join('')
            appendBuffer.length = 0
            appendBufferScheduled = false
            model.value += text
          })
        }
      }
      lastKnownCode = code
      return
    }
    model.setValue(code)
    lastKnownCode = code
  }

  function updateCode(code: string) {
    pendingUpdate = { code }
    // emulate raf via setImmediate
    setImmediate(() => {
      if (!throttleMs) { flushPendingUpdate(); return }
      const now = Date.now()
      const since = now - lastFlushTime
      if (since >= throttleMs) { flushPendingUpdate(); return }
      if (throttleTimer != null)
        return
      const wait = throttleMs - since
      throttleTimer = setTimeout(() => { throttleTimer = null; setImmediate(flushPendingUpdate) }, wait)
    })
  }

  function setThrottleMs(ms: number) {
    throttleMs = ms
  }

  function getThrottleMs() {
    return throttleMs
  }

  return { updateCode, model, setThrottleMs, getThrottleMs }
}

export type MockWrapper = ReturnType<typeof createMockWrapper>
