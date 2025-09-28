import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockWrapper } from './mockWrapper'

describe('updateCode throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // initialize fake system time to a real timestamp so Date.now() calculations are meaningful
    vi.setSystemTime(Date.now())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('respects updateThrottleMs and batches updates', async () => {
    const w = createMockWrapper({ updateThrottleMs: 50 })
    // send multiple updates quickly; first flush should take the latest pending value
    w.updateCode('a')
    w.updateCode('ab')
    w.updateCode('abc')

    // run scheduled timers (setImmediate) -> this will flush once immediately
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('abc')

    // now send another update immediately; it should be throttled
    w.updateCode('abcd')
    // advance less than throttle -> should still not flush
    vi.advanceTimersByTime(20)
    expect(w.model.getValue()).toBe('abc')

    // advance past throttle window and process timers -> now it flushes
    vi.advanceTimersByTime(60)
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('abcd')
  })

  it('allows changing throttle at runtime', async () => {
    const w = createMockWrapper({ updateThrottleMs: 100 })
    expect(w.getThrottleMs()).toBe(100)
    w.setThrottleMs(0)
    expect(w.getThrottleMs()).toBe(0)
    w.updateCode('x')
    // immediate flush when throttle==0
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('x')
  })
})
