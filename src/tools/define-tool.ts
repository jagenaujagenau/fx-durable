import { Schema } from "effect"
import type { Json, JsonObject } from "../core/json.js"
import type { ReplayPolicy } from "./replay-policy.js"

export interface DurableToolContext {
  readonly agentId: string
  readonly turnId: string
  readonly taskId: string
  /** Present for idempotent tools: pass it to the downstream system. */
  readonly idempotencyKey: string | null
  /** Aborted on cancellation. Aborting does not prove an external effect was cancelled. */
  readonly signal: AbortSignal
  /** True when this execution is an automatic replay after a crash. */
  readonly replay: boolean
}

/**
 * Tool results are persisted in the task journal, so they must be JSON.
 * Returning nothing records `null`.
 */
export type ToolResult = Json | undefined

type ToolSchema = Schema.Top & { readonly DecodingServices: never }

interface ToolBase {
  readonly name: string
  readonly description?: string
  readonly replay: ReplayPolicy
}

/** A tool whose input is decoded and validated with an Effect Schema. */
export interface SchemaToolDefinition<S extends ToolSchema> extends ToolBase {
  readonly inputSchema: S
  readonly execute: (input: S["Type"], context: DurableToolContext) => ToolResult | Promise<ToolResult>
}

/** A tool described by a plain JSON Schema; it receives the model's JSON input as-is. */
export interface JsonToolDefinition extends ToolBase {
  readonly inputSchema?: JsonObject
  readonly execute: (input: Json, context: DurableToolContext) => ToolResult | Promise<ToolResult>
}

export interface DurableTool {
  readonly _tag: "DurableTool"
  readonly name: string
  readonly description: string
  readonly replay: ReplayPolicy
  readonly jsonSchema: JsonObject
  /** Validate the input and execute. Rejects on invalid input or tool failure. */
  readonly run: (input: Json, context: DurableToolContext) => Promise<Json>
}

const anyObject = { type: "object", properties: {}, additionalProperties: true } satisfies JsonObject

const decodeJsonObject = Schema.decodeUnknownSync(Schema.JsonObject)

/** JSON Schema for the model, derived from the Effect Schema (parsed back into JSON). */
const toJsonSchema = (schema: ToolSchema): JsonObject => {
  const document = Schema.toJsonSchemaDocument(schema)
  const root = decodeJsonObject(document.schema)
  const definitions = decodeJsonObject(document.definitions)
  return Object.keys(definitions).length > 0 ? { ...root, $defs: definitions } : root
}

const isSchemaDefinition = (
  definition: SchemaToolDefinition<ToolSchema> | JsonToolDefinition
): definition is SchemaToolDefinition<ToolSchema> =>
  definition.inputSchema !== undefined && Schema.isSchema(definition.inputSchema)

const validateName = (name: string) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new TypeError(`invalid tool name: ${name}`)
}

const settle = async (result: ToolResult | Promise<ToolResult>): Promise<Json> => (await result) ?? null

/** Declare a tool together with its replay semantics. */
export function defineDurableTool<S extends ToolSchema>(definition: SchemaToolDefinition<S>): DurableTool
export function defineDurableTool(definition: JsonToolDefinition): DurableTool
export function defineDurableTool(definition: SchemaToolDefinition<ToolSchema> | JsonToolDefinition): DurableTool {
  validateName(definition.name)
  const base = {
    _tag: "DurableTool" as const,
    name: definition.name,
    description: definition.description ?? definition.name,
    replay: definition.replay
  }
  if (isSchemaDefinition(definition)) {
    const decode = Schema.decodeUnknownSync(definition.inputSchema)
    return {
      ...base,
      jsonSchema: toJsonSchema(definition.inputSchema),
      run: async (input, context) => settle(definition.execute(decode(input), context))
    }
  }
  return {
    ...base,
    jsonSchema: definition.inputSchema ?? anyObject,
    run: async (input, context) => settle(definition.execute(input, context))
  }
}

/**
 * Throw from a tool body when execution began but its outcome cannot be
 * established (e.g. the connection dropped after the request was sent).
 * The task is recorded as `outcome_unknown` instead of `failed`.
 */
export class OutcomeUnknown extends Error {
  readonly _tag = "OutcomeUnknown"
  constructor(
    message: string,
    readonly reason: "connection_lost" | "executor_lost" = "connection_lost"
  ) {
    super(message)
    this.name = "OutcomeUnknown"
  }
}
