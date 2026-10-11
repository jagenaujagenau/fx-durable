import { Effect, Schema } from "effect"
import { DecodeError } from "./errors.js"
import type { Json } from "./json.js"

/**
 * Domain schemas for everything fx-durable persists. libfx keeps each
 * conversation (its turns, steps, and tool results) in its own session
 * store; fx-durable keeps what libfx does not know about: which session an
 * agent is in, the requests made to it, a journal of tool calls keyed by
 * libfx's `executionId`, and documents.
 *
 * storage → decode → validate/migrate → domain object
 *
 * Persisted JSON blobs are wrapped in a versioned envelope `{ v, data }` so
 * future versions can migrate old payloads instead of trusting them.
 */

export const PAYLOAD_VERSION = 1

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Token counts libfx reported for a turn. */
export const TurnUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number)
})
// Type aliases (not interfaces) so these stay assignable to `Json` when persisted.
export type TurnUsage = typeof TurnUsage.Type

export const SubmissionResult = Schema.Struct({
  /** The model's final answer: the text after its last tool call. */
  text: Schema.String,
  stopReason: Schema.String,
  usage: Schema.NullOr(TurnUsage)
})
export type SubmissionResult = typeof SubmissionResult.Type

/** Content accepted by `agent.submit()`: a string or text blocks. */
export const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
export const SubmissionContent = Schema.Union([Schema.String, Schema.Array(TextBlock)])
export type SubmissionContent = typeof SubmissionContent.Type

export const SubmissionState = Schema.Literals(["running", "completed", "failed", "cancelled"])
export type SubmissionState = typeof SubmissionState.Type

export const ReplayPolicyName = Schema.Literals(["safe", "unsafe", "idempotent"])
export type ReplayPolicyName = typeof ReplayPolicyName.Type

/**
 * A tool call in fx-durable's journal. `running` means its intent was
 * recorded and it started; after a crash that state is what tells fx-durable
 * the call may have had effects.
 */
export const ToolCallState = Schema.Literals(["running", "completed", "failed", "outcome_unknown"])
export type ToolCallState = typeof ToolCallState.Type

export const DocumentForkPolicy = Schema.Literals(["copy", "initial"])
export type DocumentForkPolicy = typeof DocumentForkPolicy.Type

// ---------------------------------------------------------------------------
// Records (decoded rows)
// ---------------------------------------------------------------------------

export const DurableAgentRecord = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  model: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  /** The libfx session the agent's requests go to; null until its first request, and after a reset. */
  sessionId: Schema.NullOr(Schema.String),
  /** The session store that holds it (one per tool set; see `Sessions`). */
  sessionStore: Schema.NullOr(Schema.String),
  /** A handoff summary the model sees in its instructions, until the next reset. */
  summary: Schema.NullOr(Schema.String),
  /** For a fork: the libfx checkpoint its first session starts from. Cleared once that session exists. */
  startCheckpoint: Schema.NullOr(Schema.Uint8Array),
  createdAt: Schema.Date,
  updatedAt: Schema.Date
})
export interface DurableAgentRecord extends Schema.Schema.Type<typeof DurableAgentRecord> {}

/** A request made to an agent: one libfx turn, identified by its `messageId`. */
export const SubmissionRecord = Schema.Struct({
  /** The libfx `messageId`: the caller's `requestId`, or one fx-durable chose. */
  id: Schema.String,
  agentId: Schema.String,
  requestId: Schema.NullOr(Schema.String),
  /** "" until libfx accepts a fork's first request and names the session it starts. */
  sessionId: Schema.String,
  /** The session store that holds the session. */
  sessionStore: Schema.String,
  model: Schema.String,
  content: SubmissionContent,
  state: SubmissionState,
  result: Schema.NullOr(SubmissionResult),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  updatedAt: Schema.Date
})
export interface SubmissionRecord extends Schema.Schema.Type<typeof SubmissionRecord> {}

export const ToolCallRecord = Schema.Struct({
  sessionId: Schema.String,
  /** libfx's id for the model's call; nested calls share their top-level call's. */
  executionId: Schema.String,
  /** "" for the model's call; for a nested call, the path of keys from it (`"0"`, `"0/deploy"`). */
  callKey: Schema.String,
  agentId: Schema.String,
  /** The request whose turn made the call, when known. */
  submissionId: Schema.NullOr(Schema.String),
  name: Schema.String,
  input: Schema.Json,
  replayPolicy: ReplayPolicyName,
  idempotencyKey: Schema.NullOr(Schema.String),
  state: ToolCallState,
  output: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String),
  /** How many times it started: more than 1 after a crash made libfx run it again. */
  attempts: Schema.Number,
  /** Output reported while it runs (`context.progress`), capped. */
  progress: Schema.NullOr(Schema.String),
  startedAt: Schema.Date,
  completedAt: Schema.NullOr(Schema.Date)
})
export interface ToolCallRecord extends Schema.Schema.Type<typeof ToolCallRecord> {}

/** One stored value of a typed document (`defineDocument`). */
export const DocumentRecord = Schema.Struct({
  /** The agent it belongs to; null for a global document. */
  agentId: Schema.NullOr(Schema.String),
  kind: Schema.String,
  /** The definition version the value was written with. */
  version: Schema.Number,
  /** Counts the document's writes, from 1. */
  revision: Schema.Number,
  value: Schema.JsonObject,
  fork: DocumentForkPolicy,
  updatedAt: Schema.Date
})
export interface DocumentRecord extends Schema.Schema.Type<typeof DocumentRecord> {}

// ---------------------------------------------------------------------------
// Versioned envelope for JSON blobs
// ---------------------------------------------------------------------------

const Envelope = Schema.fromJsonString(Schema.Struct({ v: Schema.Number, data: Schema.Json }))
const decodeEnvelope = Schema.decodeUnknownExit(Envelope)

export const encodePayload = (data: Json): string => JSON.stringify({ v: PAYLOAD_VERSION, data })

/**
 * Decode a persisted envelope. Unknown future versions are rejected rather
 * than trusted; older versions would be migrated here.
 */
export const decodePayloadSync = (raw: string | null, what: string): Json => {
  if (raw === null) return null
  const envelope = decodeEnvelope(raw)
  if (envelope._tag === "Failure") {
    throw new DecodeError({ what, message: `invalid payload envelope: ${String(envelope.cause)}` })
  }
  const { v, data } = envelope.value
  if (v > PAYLOAD_VERSION) {
    throw new DecodeError({ what, message: `payload version ${v} is newer than supported ${PAYLOAD_VERSION}` })
  }
  return data
}

type DecodableSchema = Schema.Top & { readonly DecodingServices: never }

/** Field values a storage row can carry before it is decoded into a domain record. */
export type RowValue = Json | Date | Uint8Array | bigint | undefined
export interface RowFields {
  readonly [field: string]: RowValue
}

export const decodeWith = <S extends DecodableSchema>(schema: S, what: string) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (input: Json): Effect.Effect<S["Type"], DecodeError> =>
    decode(input).pipe(Effect.mapError((error) => new DecodeError({ what, message: error.message })))
}

export const decodeSync = <S extends DecodableSchema>(schema: S, what: string) => {
  const decode = Schema.decodeUnknownExit(schema)
  return (input: RowFields): S["Type"] => {
    const exit = decode(input)
    if (exit._tag === "Failure") {
      throw new DecodeError({ what, message: String(exit.cause) })
    }
    return exit.value
  }
}
