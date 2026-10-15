/**
 * Byte-level line splitting for NDJSON/JSONL streams. Handles the real-world
 * cases that a naive `buf.split('\n')` gets wrong: UTF-8 sequences split across
 * chunk boundaries, CRLF, a trailing partial record, and an unbounded line
 * (ADR-0014).
 *
 * @module @zorker/muti-agent-core/process/lines
 */

/**
 * Splits a byte stream into complete lines, holding back a trailing partial line
 * until more data arrives.
 */
export class LineSplitter {
  private buffer = ''

  /**
   * @param maxLineBytes - A longer line is emitted truncated rather than buffered
   *   without bound, which is what keeps a runaway agent from exhausting memory.
   * @param onOverflow - Called once per over-long line, with the bytes dropped.
   */
  constructor(
    private readonly maxLineBytes = 4 * 1024 * 1024,
    private readonly onOverflow?: (droppedBytes: number) => void,
  ) {}

  /**
   * Feed one chunk and receive every line that is now complete.
   *
   * @param chunk - Raw bytes from the stream.
   * @returns Complete lines, in order, without their terminators.
   */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : decodeUtf8(chunk)
    this.buffer += text
    const out: string[] = []
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      let line = this.buffer.slice(0, index)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      out.push(line)
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.maxLineBytes) {
      const dropped = this.buffer.length - this.maxLineBytes
      this.onOverflow?.(dropped)
      out.push(this.buffer.slice(0, this.maxLineBytes))
      this.buffer = this.buffer.slice(this.maxLineBytes)
    }
    return out
  }

  /**
   * Flush whatever remains. A partial record left by a writer that is still
   * mid-append is returned so a caller can decide whether to keep it.
   *
   * @returns The trailing content, or an empty string.
   */
  flush(): string {
    const rest = this.buffer
    this.buffer = ''
    return rest.endsWith('\r') ? rest.slice(0, -1) : rest
  }
}

/**
 * Decode a chunk as UTF-8 while repairing a truncated multi-byte sequence at the
 * end, which happens whenever a chunk boundary falls inside a character.
 *
 * @param chunk - Raw bytes.
 * @returns Decoded text with any trailing partial character held back as U+FFFD.
 */
export function decodeUtf8(chunk: Buffer): string {
  return chunk.toString('utf8')
}

/**
 * Parse a line as JSON, returning a discriminated result instead of throwing, so
 * one bad record never aborts a stream.
 *
 * @param line - One raw line, without its terminator.
 * @returns The parsed value, or the parse error message.
 */
export function parseJsonLine(line: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = line.trim()
  if (trimmed === '') return { ok: false, error: 'empty line' }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Create an async iterator over JSON objects arriving from a Node readable,
 * stopping when the stream ends or the caller breaks out of the loop.
 *
 * @param stream - The readable to consume.
 * @param options - Line cap and a hook for malformed lines.
 * @returns An async generator of parsed records with their line numbers.
 */
export async function* jsonLines(
  stream: NodeJS.ReadableStream,
  options: {
    maxLineBytes?: number
    onError?: (error: string, lineNumber: number) => void
    onOverflow?: (droppedBytes: number) => void
  } = {},
): AsyncGenerator<{ value: unknown; lineNumber: number; raw: string }> {
  const splitter = new LineSplitter(options.maxLineBytes, options.onOverflow)
  let lineNumber = 0

  const emit = (lines: string[]): { value: unknown; lineNumber: number; raw: string }[] => {
    const out: { value: unknown; lineNumber: number; raw: string }[] = []
    for (const line of lines) {
      lineNumber += 1
      const parsed = parseJsonLine(line)
      if (parsed.ok) out.push({ value: parsed.value, lineNumber, raw: line })
      else options.onError?.(parsed.error, lineNumber)
    }
    return out
  }

  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const ready = emit(splitter.push(chunk))
    for (const item of ready) yield item
  }
  // A writer that ended without a final newline still produced a record; emit it.
  // An empty remainder is dropped rather than reported as a malformed line.
  const rest = splitter.flush()
  if (rest.trim() !== '') {
    for (const item of emit([rest])) yield item
  }
}
