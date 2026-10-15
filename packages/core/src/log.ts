/**
 * Logging and secret redaction. Redaction is a hard requirement on every path that
 * can carry a credential (ADR-0010), so it is implemented once here and applied by
 * the gateway, the tool catalog and the run records alike.
 *
 * @module @zorker/muti-agent-core/log
 */

import type { Logger } from './adapter/types.ts'

/** A redaction rule: a literal secret, or a pattern for values we can recognize. */
export interface RedactionRule {
  /** Exact value to replace wherever it appears. */
  literal?: string
  /** Pattern whose match is replaced. */
  pattern?: RegExp
  /** Replacement text. */
  replacement: string
}

const DEFAULT_RULES: readonly RedactionRule[] = [
  // Anthropic/OpenAI-style keys, xAI/Groq-style keys, and generic long tokens.
  { pattern: /\b(sk|sk-ant|sk-proj|xai|gsk|pk|ghp|gho|ghs|glpat)[-_][A-Za-z0-9_-]{12,}\b/g, replacement: '<redacted:key>' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replacement: 'Bearer <redacted:token>' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: '<redacted:jwt>' },
  { pattern: /("(?:api_?key|access_?token|refresh_?token|password|secret|authorization)"\s*:\s*")[^"]{6,}(")/gi, replacement: '$1<redacted>$2' },
]

/**
 * Replace every credential-shaped value in a string.
 *
 * A redactor is seeded with the concrete secrets this process has seen (an API key
 * typed into the settings page, for instance), because a pattern cannot know about
 * an arbitrary provider's key format.
 */
export class Redactor {
  private readonly rules: RedactionRule[]

  /**
   * @param literals - Concrete secret values to remove verbatim.
   */
  constructor(literals: readonly string[] = []) {
    const seeded: RedactionRule[] = []
    for (const literal of literals) {
      if (literal.trim().length >= 6) seeded.push({ literal, replacement: '<redacted:provided>' })
    }
    this.rules = [...seeded, ...DEFAULT_RULES]
  }

  /**
   * Redact one string.
   *
   * @param text - Input that may contain a credential.
   * @returns The same text with credential-shaped substrings replaced.
   */
  apply(text: string): string {
    let out = text
    for (const rule of this.rules) {
      if (rule.literal !== undefined) out = out.split(rule.literal).join(rule.replacement)
      else if (rule.pattern !== undefined) out = out.replace(rule.pattern, rule.replacement)
    }
    return out
  }

  /**
   * Deep-redact every string inside a JSON-ish value.
   *
   * @param value - Value to walk; arrays and plain objects are traversed.
   * @returns A structurally identical value with strings redacted.
   */
  applyDeep<T>(value: T): T {
    return walk(value, text => this.apply(text)) as T
  }

  /**
   * Whether a string still carries anything that this redactor would replace;
   * used by tests to assert that an emitted envelope is clean.
   *
   * @param text - Text to test.
   */
  detects(text: string): boolean {
    return this.apply(text) !== text
  }
}

function walk(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map(item => walk(item, transform))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = transform(key) === key ? walk(item, transform) : transform(key)
    }
    return out
  }
  return value
}

/** Log verbosity levels, ordered. */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

/** A log record as delivered to a sink. */
export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>
  scope: string
  message: string
  at: string
  fields?: Readonly<Record<string, unknown>>
}

/** Where log records go. The plugin supplies one that also feeds the harness log. */
export type LogSink = (record: LogRecord) => void

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

/** A scoped, redacting logger. */
export class ScopedLogger implements Logger {
  /**
   * @param scope - Short subsystem name included in every record.
   * @param sink - Destination for records.
   * @param level - Maximum level to emit.
   * @param redactor - Applied to messages and field values before emission.
   */
  constructor(
    private readonly scope: string,
    private readonly sink: LogSink,
    private readonly level: LogLevel = 'info',
    private readonly redactor: Redactor = new Redactor(),
  ) {}

  /** Whether a level would be emitted; avoids building expensive fields. */
  enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.level]
  }

  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('debug', message, fields)
  }

  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('warn', message, fields)
  }

  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('info', message, fields)
  }

  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('error', message, fields)
  }

  /** A logger for a nested scope that shares this logger's sink and level. */
  child(scope: string): ScopedLogger {
    return new ScopedLogger(`${this.scope}/${scope}`, this.sink, this.level, this.redactor)
  }

  private emit(
    level: Exclude<LogLevel, 'silent'>,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    if (!this.enabled(level)) return
    const record: LogRecord = {
      level,
      scope: this.scope,
      message: this.redactor.apply(message),
      at: new Date().toISOString(),
    }
    if (fields !== undefined) {
      const redacted: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(fields)) {
        redacted[key] = typeof value === 'string' ? this.redactor.apply(value) : value
      }
      record.fields = redacted
    }
    this.sink(record)
  }
}

/** A sink that writes one line per record to a stream, redaction already applied. */
export function lineSink(
  write: (line: string) => void,
  format: (record: LogRecord) => string = defaultFormat,
): LogSink {
  return record => { write(format(record)) }
}

function defaultFormat(record: LogRecord): string {
  const fields = record.fields === undefined ? '' : ` ${JSON.stringify(record.fields)}`
  return `${record.at} ${record.level.toUpperCase()} [muti-agent:${record.scope}] ${record.message}${fields}\n`
}

/** The sink used until the plugin installs a real one, so early diagnostics are not lost. */
export const stderrSink: LogSink = lineSink(line => { process.stderr.write(line) })
