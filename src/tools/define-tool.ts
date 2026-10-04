import { Schema } from "effect"
import type { Json, JsonObject } from "../domain/json.js"
import type { ReplayPolicy } from "./replay-policy.js"
import { formatIssues, type StandardSchemaV1 } from "./standard-schema.js"

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
  /**
   * When a recovered turn repeats a call that already completed before the
   * crash, return the journaled result instead of executing again (default
   * `true`). Set `false` on replay-safe tools that observe changing state
   * (reading files, listing, checking status): a stale observation from
   * before the crash can mislead the model. Only allowed with `replay: "safe"`.
   */
  readonly reuse?: boolean
}

/** A tool whose input is decoded and validated with an Effect Schema. */
export interface SchemaToolDefinition<S extends ToolSchema> extends ToolBase {
  readonly inputSchema: S
  readonly execute: (input: S["Type"], context: DurableToolContext) => ToolResult | Promise<ToolResult>
}

/**
 * A tool validated by any Standard Schema library (Zod, Valibot, ArkType, …).
 * The model needs a JSON Schema: it is taken from the validator when it
 * implements Standard JSON Schema (Zod 4 does), otherwise pass `jsonSchema`.
 */
export interface StandardToolDefinition<S extends StandardSchemaV1> extends ToolBase {
  readonly inputSchema: S
  readonly jsonSchema?: JsonObject
  readonly execute: (input: StandardSchemaV1.InferOutput<S>, context: DurableToolContext) => ToolResult | Promise<ToolResult>
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
  /** Whether a completed call is answered from the journal when a recovered turn repeats it. */
  readonly reuse: boolean
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

type AnyDefinition = SchemaToolDefinition<ToolSchema> | StandardToolDefinition<StandardSchemaV1> | JsonToolDefinition

const isSchemaDefinition = (definition: AnyDefinition): definition is SchemaToolDefinition<ToolSchema> =>
  definition.inputSchema !== undefined && Schema.isSchema(definition.inputSchema)

type InputSchema = NonNullable<AnyDefinition["inputSchema"]>

const isStandardSchema = (schema: InputSchema): schema is StandardSchemaV1 => "~standard" in schema

const isStandardDefinition = (definition: AnyDefinition): definition is StandardToolDefinition<StandardSchemaV1> =>
  definition.inputSchema !== undefined && isStandardSchema(definition.inputSchema)

const standardJsonSchema = (definition: StandardToolDefinition<StandardSchemaV1>): JsonObject => {
  if (definition.jsonSchema) return definition.jsonSchema
  const converter = definition.inputSchema["~standard"].jsonSchema
  if (!converter) {
    throw new TypeError(
      `tool ${definition.name}: its validator does not implement Standard JSON Schema; pass \`jsonSchema\` for the model`
    )
  }
  return decodeJsonObject(converter.input({ target: "draft-2020-12" }))
}

const validateStandard = async (definition: StandardToolDefinition<StandardSchemaV1>, input: Json) => {
  const result = await definition.inputSchema["~standard"].validate(input)
  if (result.issues) throw new TypeError(`invalid input for ${definition.name}: ${formatIssues(result.issues)}`)
  return result.value
}

const validateName = (name: string) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new TypeError(`invalid tool name: ${name}`)
}

const settle = async (result: ToolResult | Promise<ToolResult>): Promise<Json> => (await result) ?? null

/** Declare a tool together with its replay semantics. */
export function defineDurableTool<S extends ToolSchema>(definition: SchemaToolDefinition<S>): DurableTool
export function defineDurableTool<S extends StandardSchemaV1>(definition: StandardToolDefinition<S>): DurableTool
export function defineDurableTool(definition: JsonToolDefinition): DurableTool
export function defineDurableTool(definition: AnyDefinition): DurableTool {
  validateName(definition.name)
  const reuse = definition.reuse ?? true
  if (!reuse && definition.replay !== "safe") {
    throw new TypeError(`tool ${definition.name}: reuse: false requires replay: "safe" (running it again must be harmless)`)
  }
  const base = {
    _tag: "DurableTool" as const,
    name: definition.name,
    description: definition.description ?? definition.name,
    replay: definition.replay,
    reuse
  }
  if (isSchemaDefinition(definition)) {
    const decode = Schema.decodeUnknownSync(definition.inputSchema)
    return {
      ...base,
      jsonSchema: toJsonSchema(definition.inputSchema),
      run: async (input, context) => settle(definition.execute(decode(input), context))
    }
  }
  if (isStandardDefinition(definition)) {
    return {
      ...base,
      jsonSchema: standardJsonSchema(definition),
      run: async (input, context) => settle(definition.execute(await validateStandard(definition, input), context))
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
