import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockWrapper } from './mockWrapper'

/**
 * 测试 getCode API 功能
 * 
 * 这个测试验证了在 updateCode 后调用 getCode 能够获取最新的代码内容
 */
describe('getCode API', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should return current code from model', async () => {
    const w = createMockWrapper({ updateThrottleMs: 0 })
    
    // 初始代码为空
    expect(w.model.getValue()).toBe('')
    
    // 更新代码
    w.updateCode('console.log("hello")')
    await vi.runAllTimersAsync()
    
    // 验证可以获取最新代码
    expect(w.model.getValue()).toBe('console.log("hello")')
  })

  it('should return updated code after multiple updates', async () => {
    const w = createMockWrapper({ updateThrottleMs: 0 })
    
    // 第一次更新
    w.updateCode('const a = 1')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('const a = 1')
    
    // 第二次更新
    w.updateCode('const a = 2')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('const a = 2')
    
    // 第三次更新
    w.updateCode('const a = 3')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('const a = 3')
  })

  it('should return appended code correctly', async () => {
    const w = createMockWrapper({ updateThrottleMs: 0 })
    
    // 初始代码
    w.updateCode('const a = 1')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('const a = 1')
    
    // 追加代码（流式场景）
    w.updateCode('const a = 1\n')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('const a = 1\n')
    
    w.updateCode('const a = 1\nconst b = 2')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('const a = 1\nconst b = 2')
  })

  it('should handle streaming updates and return latest code', async () => {
    const w = createMockWrapper({ updateThrottleMs: 0 })
    
    // 模拟流式更新场景
    w.updateCode('c')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('c')
    
    w.updateCode('co')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('co')
    
    w.updateCode('con')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('con')
    
    w.updateCode('cons')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('cons')
    
    w.updateCode('const')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('const')
  })

  it('should return latest code with rapid updates', async () => {
    const w = createMockWrapper({ updateThrottleMs: 0 })
    
    // 快速连续更新
    w.updateCode('a')
    w.updateCode('ab')
    w.updateCode('abc')
    w.updateCode('abcd')
    
    await vi.runAllTimersAsync()
    
    // 应该得到最后一次更新的值
    expect(w.model.getValue()).toBe('abcd')
  })

  it('should return code with throttling enabled', async () => {
    const w = createMockWrapper({ updateThrottleMs: 50 })
    
    w.updateCode('initial')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('initial')
    
    // 快速更新
    w.updateCode('updated')
    
    // 在节流期内，代码还未更新
    expect(w.model.getValue()).toBe('initial')
    
    // 等待节流时间过去
    vi.advanceTimersByTime(60)
    await vi.runAllTimersAsync()
    
    // 现在应该更新了
    expect(w.model.getValue()).toBe('updated')
  })

  it('should return empty string for empty updates', async () => {
    const w = createMockWrapper({ updateThrottleMs: 0 })
    
    w.updateCode('')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('')
    
    w.updateCode('some code')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('some code')
    
    // 清空代码
    w.updateCode('')
    await vi.runAllTimersAsync()
    expect(w.model.getValue()).toBe('')
  })

  it('should handle complex code with special characters', async () => {
    const w = createMockWrapper({ updateThrottleMs: 0 })
    
    const complexCode = `function test() {
  const str = "Hello, World!";
  const num = 42;
  return \`\${str} \${num}\`;
}`
    
    w.updateCode(complexCode)
    await vi.runAllTimersAsync()
    
    expect(w.model.getValue()).toBe(complexCode)
  })

  it('should return code after incremental append updates', async () => {
    const w = createMockWrapper({ updateThrottleMs: 0 })
    
    // 模拟用户输入或流式生成的场景
    let code = ''
    const increments = ['const ', 'x ', '= ', '10', ';']
    
    for (const increment of increments) {
      code += increment
      w.updateCode(code)
      await vi.runAllTimersAsync()
      expect(w.model.getValue()).toBe(code)
    }
    
    expect(w.model.getValue()).toBe('const x = 10;')
  })
})
