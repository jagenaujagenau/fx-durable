import { Effect, Schema } from "effect"
import { DecodeError } from "./errors.js"
import type { Json } from "./json.js"

/**
 * Domain schemas for every structure fx-durable owns and persists.
 *
 * storage → decode → validate/migrate → domain object
 *
 * Persisted JSON blobs are wrapped in a versioned envelope `{ v, data }` so
 * future versions can migrate old payloads instead of trusting them.
 */

export const PAYLOAD_VERSION = 1

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const AgentState = Schema.Literals([
  "idle",
  "running",
  "failed",
  "needs_input",
  "recovering",
  "configuration_error"
])
export type AgentState = typeof AgentState.Type

export const SubmissionState = Schema.Literals([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "needs_input"
])
export type SubmissionState = typeof SubmissionState.Type

export const TurnState = Schema.Literals(["running", "completed", "failed", "cancelled", "interrupted"])
export type TurnState = typeof TurnState.Type

export const TaskType = Schema.Literals(["turn", "model", "tool", "checkpoint"])
export type TaskType = typeof TaskType.Type

export const TaskState = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "outcome_unknown"
])
export type TaskState = typeof TaskState.Type

export const ReplayPolicyName = Schema.Literals(["safe", "unsafe", "idempotent"])
export type ReplayPolicyName = typeof ReplayPolicyName.Type

export const UnknownOutcomeReason = Schema.Literals([
  "process_terminated",
  "connection_lost",
  "executor_lost",
  "cancelled"
])
export type UnknownOutcomeReason = typeof UnknownOutcomeReason.Type

// ---------------------------------------------------------------------------
// Owned JSON payloads used by records
// ---------------------------------------------------------------------------

export const TurnUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.optional(Schema.Number)
})
// Type aliases (not interfaces) so these stay assignable to `Json` when persisted.
export type TurnUsage = typeof TurnUsage.Type

export const SubmissionResult = Schema.Struct({
  text: Schema.String,
  stopReason: Schema.String,
  usage: Schema.NullOr(TurnUsage)
})
export type SubmissionResult = typeof SubmissionResult.Type

/** Content accepted by `agent.submit()`: a string or libfx text blocks. */
export const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
export const SubmissionContent = Schema.Union([Schema.String, Schema.Array(TextBlock)])
export type SubmissionContent = typeof SubmissionContent.Type

// ---------------------------------------------------------------------------
// Records (decoded rows)
// ---------------------------------------------------------------------------

export const DurableAgentRecord = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  model: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  state: AgentState,
  stateReason: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  updatedAt: Schema.Date
})
export interface DurableAgentRecord extends Schema.Schema.Type<typeof DurableAgentRecord> {}

export const SubmissionRecord = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  requestId: Schema.NullOr(Schema.String),
  content: SubmissionContent,
  state: SubmissionState,
  result: Schema.NullOr(SubmissionResult),
  error: Schema.NullOr(Schema.String),
  cancelRequested: Schema.Boolean,
  createdAt: Schema.Date,
  updatedAt: Schema.Date
})
export interface SubmissionRecord extends Schema.Schema.Type<typeof SubmissionRecord> {}

export const TurnRecord = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  submissionId: Schema.String,
  state: TurnState,
  attempt: Schema.Number,
  executorId: Schema.NullOr(Schema.String),
  baseCheckpointSeq: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(Schema.Date),
  completedAt: Schema.NullOr(Schema.Date)
})
export interface TurnRecord extends Schema.Schema.Type<typeof TurnRecord> {}

export const TaskRecord = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  agentId: Schema.String,
  parentTaskId: Schema.NullOr(Schema.String),
  type: TaskType,
  state: TaskState,
  name: Schema.NullOr(Schema.String),
  input: Schema.NullOr(Schema.Json),
  inputHash: Schema.NullOr(Schema.String),
  output: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String),
  replayPolicy: Schema.NullOr(ReplayPolicyName),
  idempotencyKey: Schema.NullOr(Schema.String),
  attempt: Schema.Number,
  acknowledged: Schema.Boolean,
  metadata: Schema.NullOr(Schema.Json),
  startedAt: Schema.NullOr(Schema.Date),
  completedAt: Schema.NullOr(Schema.Date)
})
export interface TaskRecord extends Schema.Schema.Type<typeof TaskRecord> {}

export const AgentCheckpoint = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  sequence: Schema.Number,
  fxCheckpoint: Schema.Uint8Array,
  runtimeId: Schema.String,
  model: Schema.String,
  createdAt: Schema.Date
})
export interface AgentCheckpoint extends Schema.Schema.Type<typeof AgentCheckpoint> {}

export const DurableEvent = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  submissionId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  sequence: Schema.Number,
  type: Schema.String,
  payload: Schema.JsonObject,
  createdAt: Schema.Date
})
export interface DurableEvent extends Schema.Schema.Type<typeof DurableEvent> {}

// ---------------------------------------------------------------------------
// Owned payloads
// ---------------------------------------------------------------------------

export const UnknownOutcome = Schema.Struct({
  taskId: Schema.String,
  tool: Schema.String,
  input: Schema.Json,
  startedAt: Schema.Date,
  reason: UnknownOutcomeReason
})
export interface UnknownOutcome extends Schema.Schema.Type<typeof UnknownOutcome> {}

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
