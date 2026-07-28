import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv"

export interface SchemaValidationResult {
  valid: boolean
  errors: string[]
}

export interface JsonInputLimits {
  maxBytes: number
  maxDepth: number
  maxNodes: number
}

const DEFAULT_LIMITS: JsonInputLimits = {
  maxBytes: 1_000_000,
  maxDepth: 64,
  maxNodes: 100_000,
}

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  validateFormats: false,
  messages: true,
})

export type CompiledJsonSchema = ValidateFunction

/** Compile once at registration time. Invalid or unsupported schemas fail closed. */
export function compileJsonSchema(schema: unknown): CompiledJsonSchema {
  try {
    return ajv.compile(schema as AnySchema)
  } catch (error) {
    throw new Error(`Invalid JSON Schema: ${safeErrorMessage(error)}`)
  }
}

export function validateCompiledJsonSchema(
  validator: CompiledJsonSchema,
  value: unknown,
  limits: Partial<JsonInputLimits> = {},
): SchemaValidationResult {
  const resolved = { ...DEFAULT_LIMITS, ...limits }
  const limitError = checkInputLimits(value, resolved)
  if (limitError) return { valid: false, errors: [limitError] }

  const valid = validator(value) === true
  return {
    valid,
    errors: valid ? [] : formatValidationErrors(validator.errors),
  }
}

/** Compatibility helper. Registries should use compileJsonSchema instead. */
export function validateJsonSchema(schema: unknown, value: unknown): SchemaValidationResult {
  return validateCompiledJsonSchema(compileJsonSchema(schema), value)
}

function checkInputLimits(value: unknown, limits: JsonInputLimits): string | undefined {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    return "input must be JSON-serializable"
  }
  if (Buffer.byteLength(encoded ?? "null", "utf8") > limits.maxBytes) {
    return `input exceeds the ${limits.maxBytes}-byte limit`
  }

  let nodes = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    nodes += 1
    if (nodes > limits.maxNodes) return `input exceeds the ${limits.maxNodes}-node limit`
    if (current.depth > limits.maxDepth) return `input exceeds the depth limit of ${limits.maxDepth}`
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 })
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 })
    }
  }
  return undefined
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 20).map((error) => {
    const location = error.instancePath || "$"
    // Ajv's params can contain property names, but never include input values.
    if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
      return `${location}.${error.params.missingProperty} is required`
    }
    if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
      return `${location} has unsupported property ${safeSegment(error.params.additionalProperty)}`
    }
    return `${location} ${error.message ?? `failed ${error.keyword} validation`}`
  })
}

function safeSegment(value: string): string {
  return JSON.stringify(value.slice(0, 128))
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
