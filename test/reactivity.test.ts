import { describe, expect, it, vi } from 'vitest'
import { computed, ref, watch } from '../src/reactivity'

describe('reactivity', () => {
  it('ref should work', () => {
    const r = ref(1)
    expect(r.value).toBe(1)
    r.value = 2
    expect(r.value).toBe(2)
  })

  it('computed should work', () => {
    const r = ref(1)
    const c = computed(() => r.value * 2)
    expect(c.value).toBe(2)
    r.value = 3
    expect(c.value).toBe(6)
  })

  it('watch should provide correct oldVal and newVal in sync mode', () => {
    const r = ref(1)
    const values: Array<{ newVal: number, oldVal: number | undefined }> = []
    
    watch(
      () => r.value,
      (newVal, oldVal) => {
        values.push({ newVal, oldVal })
      },
      { flush: 'sync' },
    )

    r.value = 2
    r.value = 3

    expect(values).toEqual([
      { newVal: 2, oldVal: 1 },
      { newVal: 3, oldVal: 2 },
    ])
  })

  it('watch should provide correct oldVal and newVal in post mode', async () => {
    const r = ref(1)
    const values: Array<{ newVal: number, oldVal: number | undefined }> = []
    
    watch(
      () => r.value,
      (newVal, oldVal) => {
        values.push({ newVal, oldVal })
      },
      { flush: 'post' },
    )

    r.value = 2
    await Promise.resolve() // Wait for microtask
    r.value = 3
    await Promise.resolve() // Wait for microtask

    expect(values).toEqual([
      { newVal: 2, oldVal: 1 },
      { newVal: 3, oldVal: 2 },
    ])
  })

  it('watch with immediate should call callback on setup', () => {
    const r = ref(1)
    const values: Array<{ newVal: number, oldVal: number | undefined }> = []
    
    watch(
      () => r.value,
      (newVal, oldVal) => {
        values.push({ newVal, oldVal })
      },
      { immediate: true, flush: 'sync' },
    )

    expect(values).toEqual([
      { newVal: 1, oldVal: undefined },
    ])

    r.value = 2
    expect(values).toEqual([
      { newVal: 1, oldVal: undefined },
      { newVal: 2, oldVal: 1 },
    ])
  })
})
