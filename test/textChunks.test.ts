import { describe, expect, it } from 'vitest'
import {
  countLineBreaks,
  splitTextByLineBreakCount,
} from '../src/utils/textChunks'

describe('text chunk helpers', () => {
  it('counts LF line breaks', () => {
    expect(countLineBreaks('a\nb\nc')).toBe(2)
    expect(countLineBreaks('a\r\nb\r\nc')).toBe(2)
    expect(countLineBreaks('single line')).toBe(0)
  })

  it('preserves text without trailing newline', () => {
    const text = Array.from({ length: 5 }, (_, i) => `line-${i}`).join('\n')
    const chunks = splitTextByLineBreakCount(text, 2)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
    expect(chunks[chunks.length - 1]?.endsWith('\n')).toBe(false)
  })

  it('preserves CRLF input exactly', () => {
    const text = Array.from({ length: 5 }, (_, i) => `line-${i}`).join('\r\n')
    const chunks = splitTextByLineBreakCount(text, 2)

    expect(chunks.join('')).toBe(text)
    expect(chunks.some(chunk => chunk.includes('\r\n'))).toBe(true)
  })

  it('does not emit empty trailing chunks', () => {
    const text = 'a\nb\n'
    const chunks = splitTextByLineBreakCount(text, 1)

    expect(chunks).toEqual(['a\n', 'b\n'])
    expect(chunks.join('')).toBe(text)
  })

  it('returns a single chunk for long single-line text', () => {
    const text = 'x'.repeat(10_000)
    expect(splitTextByLineBreakCount(text, 200)).toEqual([text])
  })
})
