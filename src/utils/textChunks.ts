export function countLineBreaks(text: string) {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10)
      count += 1
  }
  return count
}

/**
 * Split text at existing LF boundaries while preserving the exact original
 * bytes/code-units. This intentionally does not normalize CRLF and does not add
 * a synthetic trailing newline; joining the chunks must always equal `text`.
 */
export function splitTextByLineBreakCount(
  text: string,
  maxLineBreaksPerChunk: number,
) {
  if (!text)
    return []

  const normalizedLimit = Math.floor(maxLineBreaksPerChunk)
  const limit = Number.isNaN(normalizedLimit)
    ? 1
    : Math.max(1, normalizedLimit)
  const chunks: string[] = []
  let start = 0
  let lineBreaks = 0

  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10)
      continue
    lineBreaks += 1
    if (lineBreaks >= limit) {
      const end = i + 1
      chunks.push(text.slice(start, end))
      start = end
      lineBreaks = 0
    }
  }

  if (start < text.length)
    chunks.push(text.slice(start))
  return chunks
}
