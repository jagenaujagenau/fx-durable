import { Schema } from "effect"
import type { Json, JsonObject } from "../domain/json.js"
import type { DocumentUpdate, DurableDocument } from "../domain/documents.js"
import { formatIssues, type StandardSchemaV1 } from "./standard-schema.js"
import type { ReplayPolicy } from "./replay-policy.js"

export interface DurableToolContext {
  readonly agentId: string
  /** The libfx session the call belongs to. */
  readonly sessionId: string
  /** libfx's id for the model's call. It stays the same when the call runs again after a crash. */
  readonly executionId: string
  /** The request whose turn made the call, when known. */
  readonly submissionId: string | null
  /** The agent's working directory (`agent(id, { cwd })`), or null when it has none. */
  readonly cwd: string | null
  /** Present for idempotent tools: pass it to the downstream system. Stable across runs of the call. */
  readonly idempotencyKey: string | null
  /**
   * Aborted when the call stops early: the turn was cancelled, or the nested
   * call's caller returned. Aborting does not prove an external effect was
   * cancelled.
   */
  readonly signal: AbortSignal
  /** True when this run repeats a call that started before a crash. */
  readonly replay: boolean
  /**
   * Report output while the tool runs (for example a command's stdout). The
   * accumulated text is kept in the running task's `metadata.progress`, updated
   * at most every 100 ms and capped to its last 64 KiB, so a viewer attaching
   * mid-call can see it. It is not the result: return that as usual.
   */
  readonly progress: (chunk: string) => void
  /**
   * Call another of the agent's tools, as code-mode scripts and MCP bridges
   * do. The nested call is a durable task of its own, owned by this one: it
   * is validated, runs the runtime's hooks (which see `call.caller`), and
   * keeps its own replay policy. It resolves with the tool's result and
   * rejects as a model call would fail (`ToolExecutionError`,
   * `UnknownOutcomeError`, `ToolBlockedError`).
   *
   * Each nested call has a key: its position among this call's nested calls,
   * unless you pass one. When this tool runs again after a crash, calls with
   * the same key, tool, and input get their journaled outcome back instead of
   * running again. Nested calls still running when this tool returns are
   * aborted.
   */
  readonly executeTool: (name: string, input: Json, options?: NestedCallOptions) => Promise<Json>
  /** Read and change typed documents (`defineDocument`): the agent's own, and global ones. */
  readonly documents: DocumentAccess
}

/**
 * A tool's view of documents. Its changes commit in the same transaction as
 * its result: none of them if the call fails or is cut off, and once if it is
 * replayed.
 */
export interface DocumentAccess {
  /** The committed value, with this call's changes applied. */
  readonly get: <T extends JsonObject>(document: DurableDocument<T>) => Promise<T>
  /**
   * Change a document; resolves with the value this call now sees. The
   * update runs again at commit, on the value current then (another call may
   * have changed it meanwhile), so keep it a pure function of the draft.
   */
  readonly update: <T extends JsonObject>(document: DurableDocument<T>, update: DocumentUpdate<T>) => Promise<T>
}

export interface NestedCallOptions {
  /** Identifies the call among this tool's nested calls, across reruns. Default: its position. */
  readonly key?: string
}

/** Who may call a tool: the model, other tools (`context.executeTool`), or both. */
export type ToolCallers = "model" | "tools" | "both"

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
   * Calls must not overlap others: libfx starts it after every earlier call
   * of the same model response has finished. For tools that write shared
   * state, such as files.
   */
  readonly writes?: boolean
  /**
   * Who may call this tool (default `"both"`). `"tools"` keeps it out of the
   * model's tool list, for tools that only scripts and other tools use.
   */
  readonly callers?: ToolCallers
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
  readonly writes: boolean
  readonly callers: ToolCallers
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
  const base = {
    _tag: "DurableTool" as const,
    name: definition.name,
    description: definition.description ?? definition.name,
    replay: definition.replay,
    writes: definition.writes ?? false,
    callers: definition.callers ?? "both"
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
