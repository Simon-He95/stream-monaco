import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHeightManager } from '../src/utils/height'

// polyfill requestAnimationFrame for test environment
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0)
  ;(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id)
}

describe('createHeightManager', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('applies computed height and suppresses during application', async () => {
    // create a fake container
    const container = { style: { height: '' } } as unknown as HTMLElement
    let computeCalls = 0
    const cm = () => {
      computeCalls++
      return 100 + computeCalls
    }
    const m = createHeightManager(container, cm)
    // first update should set height
    m.update()
    // wait a tick for RAF via requestAnimationFrame
    await new Promise(res => setTimeout(res, 0))
    expect(container.style.height).toMatch(/px$/)
    // second update with same computed value should not change
    m.update()
    await new Promise(res => setTimeout(res, 0))
    expect(container.style.height).not.toBe('')
    m.dispose()
  })

  it('does not add a height transition by default', () => {
    const container = { style: { height: '', transition: '' } } as unknown as HTMLElement
    const m = createHeightManager(container, () => 100)

    expect(container.style.transition).toBe('')

    m.dispose()
  })

  it('adds a height transition when smooth height is enabled', () => {
    const container = { style: { height: '', transition: '' } } as unknown as HTMLElement
    const m = createHeightManager(container, () => 100, {
      smooth: true,
      transitionMs: 120,
      transitionEasing: 'linear',
    })

    expect(container.style.transition).toBe('height 120ms linear')

    m.dispose()
  })

  it('appends height transition and restores the previous transition on dispose', () => {
    const container = {
      style: { height: '', transition: 'opacity 100ms linear' },
    } as unknown as HTMLElement
    const m = createHeightManager(container, () => 100, {
      smooth: true,
      transitionMs: 120,
      transitionEasing: 'linear',
    })

    expect(container.style.transition).toBe('opacity 100ms linear, height 120ms linear')

    m.dispose()
    expect(container.style.transition).toBe('opacity 100ms linear')
  })

  it('does not overwrite transition changes made after creation', () => {
    const container = {
      style: { height: '', transition: 'opacity 100ms linear' },
    } as unknown as HTMLElement
    const m = createHeightManager(container, () => 100, {
      smooth: true,
      transitionMs: 120,
      transitionEasing: 'linear',
    })

    container.style.transition = 'opacity 100ms linear, height 120ms linear, color 80ms linear'
    m.dispose()

    expect(container.style.transition).toBe('opacity 100ms linear, color 80ms linear')
  })

  it('does not enable transition when prefers-reduced-motion is reduce', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: true })),
    })
    const container = { style: { height: '', transition: '' } } as unknown as HTMLElement
    const m = createHeightManager(container, () => 100, {
      smooth: true,
      transitionMs: 120,
      transitionEasing: 'linear',
    })

    expect(container.style.transition).toBe('')

    m.dispose()
  })

  it('debounces update but updateNow flushes immediately', () => {
    vi.useFakeTimers()
    const container = { style: { height: '', transition: '' } } as unknown as HTMLElement
    let next = 100
    let computeCalls = 0
    const m = createHeightManager(container, () => {
      computeCalls += 1
      return next
    }, {
      debounceMs: 25,
      hysteresisPx: 0,
    })

    m.update()
    vi.advanceTimersByTime(24)
    expect(container.style.height).toBe('')
    expect(computeCalls).toBe(0)

    next = 120
    expect(m.updateNow()).toBe(120)
    expect(container.style.height).toBe('120px')
    expect(computeCalls).toBe(1)

    vi.advanceTimersByTime(25)
    expect(computeCalls).toBe(1)

    m.dispose()
  })
})
