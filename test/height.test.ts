import { describe, expect, it } from 'vitest'
import { createHeightManager } from '../src/utils/height'

// polyfill requestAnimationFrame for test environment
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0)
  ;(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id)
}

describe('createHeightManager', () => {
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
})
