/**
 * A dependency-free validator with Standard Schema v1 support.
 *
 * Why hand-rolled instead of a library: this package is the only thing both the
 * Node host bundle and the browser client bundle share, and it must stay free of
 * runtime dependencies (ADR-0006). The surface is deliberately small — the shapes
 * we need are objects, arrays, unions, records, primitives and literals — and it
 * doubles as the source of the JSON Schema published to MCP clients and to the
 * operation catalog, so a validation rule and a documented schema cannot drift.
 *
 * Implemented as a fluent hierarchy of schema classes rather than a builder
 * closure so that `toJsonSchema()` and `validate()` read the same declaration.
 *
 * @module @zorker/muti-agent-contracts/validate
 */

/** JSON Schema subset this module emits. */
export type JsonSchema =
  | { type: 'string'; enum?: readonly string[]; description?: string; minLength?: number }
  | { type: 'number'; description?: string; minimum?: number; maximum?: number }
  | { type: 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'null' }
  | { type: 'array'; items: JsonSchema; description?: string; minItems?: number; maxItems?: number }
  | {
      type: 'object'
      properties: Record<string, JsonSchema>
      required: readonly string[]
      additionalProperties: boolean
      description?: string
    }
  | { anyOf: readonly JsonSchema[]; description?: string }
  | { type: 'object'; additionalProperties: JsonSchema; description?: string }
  | { description?: string }

/** One validation failure, located by path. */
export interface ValidationIssue {
  /** Path from the root: object keys and array indices. */
  path: readonly (string | number)[]
  /** What is wrong, phrased for a developer reading a 400 response. */
  message: string
}

/** Successful validation. */
export interface ValidationSuccess<T> {
  ok: true
  value: T
}

/** Failed validation. */
export interface ValidationFailure {
  ok: false
  issues: readonly ValidationIssue[]
}

/** Result of validating a value. */
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

/** Standard Schema v1 result payload. */
interface StandardResult<T> {
  value?: T
  issues?: readonly { path?: readonly (PropertyKey | { key: PropertyKey })[]; message: string }[]
}

/**
 * Base class for every declared schema. Subclasses implement {@link check}
 * (validation) and {@link json}; the public surface and the Standard Schema
 * bridge are implemented once here.
 *
 * @typeParam T - The validated TypeScript type.
 */
export abstract class Schema<T> {
  /** Developer-facing description, propagated into JSON Schema. */
  protected descriptionText: string | undefined

  /** The TypeScript type this schema produces, for inference only. */
  declare readonly __t: T

  /**
   * Validate a value without throwing.
   *
   * @param value - Unknown input, typically from a wire boundary.
   * @returns Success with the validated value, or the collected issues.
   */
  safeParse(value: unknown): ValidationResult<T> {
    const issues: ValidationIssue[] = []
    const out = this.check(value, [], issues)
    if (issues.length > 0) return { ok: false, issues }
    return { ok: true, value: out as T }
  }

  /**
   * Validate a value, throwing on failure.
   *
   * @param value - Unknown input.
   * @returns The validated value.
   * @throws {SchemaValidationError} when the value does not satisfy this schema.
   */
  parse(value: unknown): T {
    const result = this.safeParse(value)
    if (!result.ok) throw new SchemaValidationError(this.describe(), result.issues)
    return result.value
  }

  /** JSON Schema for documentation and MCP `tools/list`. */
  abstract toJsonSchema(): JsonSchema

  /** A short human label for error messages, e.g. `agentId`, `array<session>`. */
  abstract describe(): string

  /** Attach a description that flows into the emitted JSON Schema. */
  describeAs(text: string): this {
    this.descriptionText = text
    return this
  }

  /** The `~standard` property Cordis and other Standard Schema consumers read. */
  get '~standard'(): {
    version: 1
    vendor: string
    validate: (value: unknown) => StandardResult<T>
  } {
    return {
      version: 1,
      vendor: 'muti-agent',
      validate: (value: unknown): StandardResult<T> => {
        const result = this.safeParse(value)
        if (result.ok) return { value: result.value }
        return {
          issues: result.issues.map(issue => ({
            path: issue.path.map(segment => (typeof segment === 'number' ? segment : { key: segment })),
            message: issue.message,
          })),
        }
      },
    }
  }

  /**
   * Validate one value against this schema, appending to a caller-owned issue
   * list. Container schemas use this so a nested failure reports its path inside
   * the parent's value rather than replacing it with a nested error object.
   *
   * @param value - Candidate value.
   * @param path - Path of this value from the validation root, for messages.
   * @param issues - Collector; appended to, never read.
   * @returns The validated value, or the input unchanged when it failed.
   */
  collect(value: unknown, path: readonly (string | number)[], issues: ValidationIssue[]): unknown {
    return this.check(value, path, issues)
  }

  /**
   * Validate one value at one path, appending issues rather than throwing.
   *
   * @param value - Candidate value.
   * @param path - Path of this value from the validation root, for messages.
   * @param issues - Collector; implementations append and return the input value
   *   unchanged on failure so a caller can keep reporting sibling fields.
   * @returns The validated value, or the input when it failed.
   */
  protected abstract check(value: unknown, path: readonly (string | number)[], issues: ValidationIssue[]): unknown

  /** Apply the description to an emitted JSON Schema object. */
  protected withDescription<S extends JsonSchema>(schema: S): JsonSchema {
    if (this.descriptionText !== undefined) return { ...schema, description: this.descriptionText }
    return schema
  }
}

/** Raised by {@link Schema.parse} on invalid input. */
export class SchemaValidationError extends Error {
  /** Every issue found, not just the first. */
  readonly issues: readonly ValidationIssue[]

  /**
   * @param label - Description of the schema that rejected the value.
   * @param issues - Collected issues.
   */
  constructor(label: string, issues: readonly ValidationIssue[]) {
    super(`${label}: ${issues.map(i => `${formatPath(i.path)} ${i.message}`).join('; ')}`)
    this.name = 'SchemaValidationError'
    this.issues = issues
  }
}

/** Render a path for a human: `params.todos[2].status`. */
export function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '<root>'
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`
    else out += out === '' ? segment : `.${segment}`
  }
  return out
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** A string, optionally constrained to a literal set. */
export class StringSchema extends Schema<string> {
  private enumValues: readonly string[] | undefined
  private minimumLength: number | undefined

  /** Restrict to one of these exact values. */
  enumOf(values: readonly string[]): this {
    this.enumValues = values
    return this
  }

  /** Require at least this many characters. */
  min(length: number): this {
    this.minimumLength = length
    return this
  }

  override describe(): string {
    return this.enumValues === undefined ? 'string' : `one of ${this.enumValues.join('|')}`
  }

  override toJsonSchema(): JsonSchema {
    let out: Extract<JsonSchema, { type: 'string' }> = { type: 'string' }
    if (this.enumValues !== undefined) out = { ...out, enum: this.enumValues }
    if (this.minimumLength !== undefined) out = { ...out, minLength: this.minimumLength }
    return this.withDescription(out)
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    if (typeof value !== 'string') {
      issues.push({ path, message: `must be a string (received ${typeName(value)})` })
      return value
    }
    if (this.enumValues !== undefined && !this.enumValues.includes(value)) {
      issues.push({ path, message: `must be one of ${this.enumValues.join(', ')}` })
      return value
    }
    if (this.minimumLength !== undefined && value.length < this.minimumLength) {
      issues.push({ path, message: `must be at least ${String(this.minimumLength)} characters` })
    }
    return value
  }
}

/** A number, optionally integral and bounded. */
export class NumberSchema extends Schema<number> {
  private integral = false
  private minimum: number | undefined
  private maximum: number | undefined

  /** Require an integer. */
  int(): this {
    this.integral = true
    return this
  }

  /** Inclusive lower bound. */
  min(value: number): this {
    this.minimum = value
    return this
  }

  /** Inclusive upper bound. */
  max(value: number): this {
    this.maximum = value
    return this
  }

  override describe(): string {
    return this.integral ? 'integer' : 'number'
  }

  override toJsonSchema(): JsonSchema {
    if (this.integral) {
      let out: Extract<JsonSchema, { type: 'integer' }> = { type: 'integer' }
      if (this.minimum !== undefined) out = { ...out, minimum: this.minimum }
      if (this.maximum !== undefined) out = { ...out, maximum: this.maximum }
      return this.withDescription(out)
    }
    let out: Extract<JsonSchema, { type: 'number' }> = { type: 'number' }
    if (this.minimum !== undefined) out = { ...out, minimum: this.minimum }
    if (this.maximum !== undefined) out = { ...out, maximum: this.maximum }
    return this.withDescription(out)
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      issues.push({ path, message: `must be a number (received ${typeName(value)})` })
      return value
    }
    if (this.integral && !Number.isInteger(value)) {
      issues.push({ path, message: 'must be an integer' })
      return value
    }
    if (this.minimum !== undefined && value < this.minimum) {
      issues.push({ path, message: `must be >= ${String(this.minimum)}` })
    }
    if (this.maximum !== undefined && value > this.maximum) {
      issues.push({ path, message: `must be <= ${String(this.maximum)}` })
    }
    return value
  }
}

/** A boolean. */
export class BooleanSchema extends Schema<boolean> {
  override describe(): string {
    return 'boolean'
  }

  override toJsonSchema(): JsonSchema {
    return this.withDescription({ type: 'boolean' })
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    if (typeof value !== 'boolean') {
      issues.push({ path, message: `must be a boolean (received ${typeName(value)})` })
    }
    return value
  }
}

/** An array of one item schema. */
export class ArraySchema<I> extends Schema<I[]> {
  private minimumItems: number | undefined
  private maximumItems: number | undefined

  /**
   * @param item - Schema every element must satisfy.
   */
  constructor(private readonly item: Schema<I>) {
    super()
  }

  /** Require at least this many items. */
  min(length: number): this {
    this.minimumItems = length
    return this
  }

  /** Require at most this many items. */
  max(length: number): this {
    this.maximumItems = length
    return this
  }

  override describe(): string {
    return `array<${this.item.describe()}>`
  }

  override toJsonSchema(): JsonSchema {
    let out: Extract<JsonSchema, { type: 'array' }> = { type: 'array', items: this.item.toJsonSchema() }
    if (this.minimumItems !== undefined) out = { ...out, minItems: this.minimumItems }
    if (this.maximumItems !== undefined) out = { ...out, maxItems: this.maximumItems }
    return this.withDescription(out)
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    if (!Array.isArray(value)) {
      issues.push({ path, message: `must be an array (received ${typeName(value)})` })
      return value
    }
    if (this.minimumItems !== undefined && value.length < this.minimumItems) {
      issues.push({ path, message: `must have at least ${String(this.minimumItems)} items` })
    }
    if (this.maximumItems !== undefined && value.length > this.maximumItems) {
      issues.push({ path, message: `must have at most ${String(this.maximumItems)} items` })
    }
    const out: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      out.push(this.item.collect(value[index], [...path, index], issues))
    }
    return out
  }
}

/** The value type a schema produces, for object field inference. */
type InferValue<S> = S extends Schema<infer U> ? U : never

/**
 * An object with declared fields. Unknown keys are rejected unless allowed.
 *
 * Required and optional fields are separate type parameters so the inferred value type
 * carries `?:` for the optional ones. Getting this right matters beyond ergonomics: it
 * is what lets an operation's parameters be checked against the canonical type they are
 * mapped onto, instead of being `unknown` and needing a cast at every use.
 *
 * @typeParam RequiredFields - Declared fields that must be present.
 * @typeParam OptionalFields - Declared fields that may be absent.
 */
export class ObjectSchema<
  RequiredFields extends Record<string, Schema<unknown>> = Record<string, Schema<unknown>>,
  OptionalFields extends Record<string, Schema<unknown>> = Record<never, never>,
> extends Schema<
  { [K in keyof RequiredFields]: InferValue<RequiredFields[K]> } & {
    [K in keyof OptionalFields]?: InferValue<OptionalFields[K]>
  }
> {
  private allowExtra = false

  /**
   * @param fields - Required declared fields.
   * @param optionalFields - Declared fields that may be absent or `null`.
   */
  constructor(
    private readonly fields: RequiredFields,
    private readonly optionalFields: OptionalFields = {} as OptionalFields,
  ) {
    super()
  }

  /** Permit and pass through undeclared keys instead of rejecting them. */
  passthrough(): this {
    this.allowExtra = true
    return this
  }

  override describe(): string {
    const names = [...Object.keys(this.fields), ...Object.keys(this.optionalFields).map(n => `${n}?`)]
    return `object{${names.join(', ')}}`
  }

  override toJsonSchema(): JsonSchema {
    const properties: Record<string, JsonSchema> = {}
    for (const [name, schema] of Object.entries(this.fields)) properties[name] = schema.toJsonSchema()
    for (const [name, schema] of Object.entries(this.optionalFields)) properties[name] = schema.toJsonSchema()
    return this.withDescription({
      type: 'object',
      properties,
      required: Object.keys(this.fields),
      additionalProperties: this.allowExtra,
    })
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path, message: `must be an object (received ${typeName(value)})` })
      return value
    }
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [name, schema] of Object.entries(this.fields)) {
      out[name] = schema.collect(record[name], [...path, name], issues)
    }
    for (const [name, schema] of Object.entries(this.optionalFields)) {
      const present = record[name]
      if (present === undefined || present === null) continue
      out[name] = schema.collect(present, [...path, name], issues)
    }
    if (this.allowExtra) {
      for (const [name, extra] of Object.entries(record)) {
        if (name in out) continue
        out[name] = extra
      }
    } else {
      for (const name of Object.keys(record)) {
        if (name in this.fields || name in this.optionalFields) continue
        issues.push({ path: [...path, name], message: 'is not a declared field' })
      }
    }
    return out
  }
}

/** A record with arbitrary keys and one value schema. */
export class RecordSchema<V> extends Schema<Record<string, V>> {
  /**
   * @param value - Schema every value must satisfy.
   */
  constructor(private readonly value: Schema<V>) {
    super()
  }

  override describe(): string {
    return `record<${this.value.describe()}>`
  }

  override toJsonSchema(): JsonSchema {
    return this.withDescription({ type: 'object', additionalProperties: this.value.toJsonSchema() })
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path, message: `must be an object (received ${typeName(value)})` })
      return value
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = this.value.collect(item, [...path, key], issues)
    }
    return out
  }
}

/** Any of several schemas; the first that validates wins. */
export class UnionSchema<U> extends Schema<U> {
  /**
   * @param options - Candidate schemas, tried in order.
   */
  constructor(private readonly options: readonly Schema<unknown>[]) {
    super()
  }

  override describe(): string {
    return `one of (${this.options.map(o => o.describe()).join(' | ')})`
  }

  override toJsonSchema(): JsonSchema {
    return this.withDescription({ anyOf: this.options.map(o => o.toJsonSchema()) })
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    const failures: ValidationIssue[] = []
    for (const option of this.options) {
      const attempt: ValidationIssue[] = []
      const out = option.collect(value, path, attempt)
      if (attempt.length === 0) return out
      failures.push(...attempt)
    }
    issues.push({
      path,
      message: `must be ${this.describe()} (received ${typeName(value)}; ${failures.length} candidate checks failed)`,
    })
    return value
  }
}

/** A literal value: `null`, a boolean, or an exact string. */
export class LiteralSchema<L extends string | number | boolean | null> extends Schema<L> {
  /**
   * @param literal - The only accepted value.
   */
  constructor(private readonly literal: L) {
    super()
  }

  override describe(): string {
    return JSON.stringify(this.literal)
  }

  override toJsonSchema(): JsonSchema {
    if (this.literal === null) return this.withDescription({ type: 'null' })
    if (typeof this.literal === 'string') {
      return this.withDescription({ type: 'string', enum: [this.literal] })
    }
    if (typeof this.literal === 'boolean') return this.withDescription({ type: 'boolean' })
    return this.withDescription(
      Number.isInteger(this.literal)
        ? { type: 'integer', minimum: this.literal, maximum: this.literal }
        : { type: 'number', minimum: this.literal, maximum: this.literal },
    )
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    if (value !== this.literal) {
      issues.push({ path, message: `must equal ${JSON.stringify(this.literal)}` })
    }
    return value
  }
}

/** Accepts anything, including `undefined`. Used for opaque native payloads. */
export class AnySchema extends Schema<unknown> {
  override describe(): string {
    return 'any'
  }

  override toJsonSchema(): JsonSchema {
    return this.withDescription({})
  }

  protected override check(
    value: unknown,
    _path: readonly (string | number)[],
    _issues: ValidationIssue[],
  ): unknown {
    return value
  }
}

/** Accepts any JSON-serializable value; rejects functions and symbols. */
export class JsonValueSchema extends Schema<unknown> {
  override describe(): string {
    return 'json-value'
  }

  override toJsonSchema(): JsonSchema {
    return this.withDescription({})
  }

  protected override check(
    value: unknown,
    path: readonly (string | number)[],
    issues: ValidationIssue[],
  ): unknown {
    if (!isJsonValue(value)) {
      issues.push({ path, message: `must be a JSON value (received ${typeName(value)})` })
    }
    return value
  }
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object':
      if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1))
      return Object.values(value as Record<string, unknown>).every(item => isJsonValue(item, depth + 1))
    default:
      return false
  }
}

/** Schema constructors. All declarations in this package go through these. */
export const s = {
  /** A string. */
  string: (): StringSchema => new StringSchema(),
  /** A number. */
  number: (): NumberSchema => new NumberSchema(),
  /** A boolean. */
  boolean: (): BooleanSchema => new BooleanSchema(),
  /** An array of the given item schema. */
  array: <I>(item: Schema<I>): ArraySchema<I> => new ArraySchema(item),
  /** An object with the given required fields. */
  object: <Shape extends Record<string, Schema<unknown>>>(fields: Shape): ObjectSchema<Shape> =>
    new ObjectSchema(fields),
  /**
   * An object with required and optional fields.
   *
   * @param fields - Required fields.
   * @param optional - Fields that may be absent.
   */
  objectOpt: <
    Shape extends Record<string, Schema<unknown>>,
    Optional extends Record<string, Schema<unknown>>,
  >(
    fields: Shape,
    optional: Optional,
  ): ObjectSchema<Shape, Optional> => new ObjectSchema(fields, optional),
  /** A record with arbitrary keys. */
  record: <V>(value: Schema<V>): RecordSchema<V> => new RecordSchema(value),
  /** A union tried in order. */
  union: <U>(...options: Schema<unknown>[]): UnionSchema<U> => new UnionSchema<U>(options),
  /** Exactly one literal value. */
  literal: <L extends string | number | boolean | null>(value: L): LiteralSchema<L> =>
    new LiteralSchema(value),
  /** Any value. */
  any: (): AnySchema => new AnySchema(),
  /** Any JSON-serializable value. */
  json: (): JsonValueSchema => new JsonValueSchema(),
} as const
