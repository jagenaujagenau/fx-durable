import { Schema } from "effect"

/**
 * Typed failures. The failure type is part of the correctness model:
 * `ToolExecutionError` means "we know the operation failed", while
 * `UnknownOutcomeError` means "execution began, but we cannot establish its
 * outcome". They must never be collapsed into one another.
 */

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * fx-durable closed itself after a storage error (`cause`); this call came
 * after, or was waiting when it happened. Open it again to recover from what
 * was committed.
 */
export class DurableFxFailedError extends Schema.TaggedError<DurableFxFailedError>()("DurableFxFailedError", {
  message: Schema.String,
  cause: StorageError
}) {}

/** libfx could not run a request: no credentials, a rejected prompt, a failed session. */
export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  agentId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/** A `beforeTool` hook refused the call; it never started. */
export class ToolBlockedError extends Schema.TaggedError<ToolBlockedError>()("ToolBlockedError", {
  tool: Schema.String,
  message: Schema.String
}) {}

export class ToolExecutionError extends Schema.TaggedError<ToolExecutionError>()("ToolExecutionError", {
  /** The call's id: its session, libfx execution id, and nested key. */
  callId: Schema.String,
  tool: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

export class UnknownOutcomeError extends Schema.TaggedError<UnknownOutcomeError>()("UnknownOutcomeError", {
  callId: Schema.String,
  tool: Schema.String,
  message: Schema.String
}) {}

export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "RuntimeConfigurationError",
  {
    runtimeId: Schema.String,
    message: Schema.String
  }
) {}

/** A request ended without a result: it failed or was cancelled. */
export class SubmissionError extends Schema.TaggedError<SubmissionError>()("SubmissionError", {
  submissionId: Schema.String,
  state: Schema.String,
  message: Schema.String
}) {}

/** `fork()` was given an agent id that is already taken. */
export class AgentExistsError extends Schema.TaggedError<AgentExistsError>()("AgentExistsError", {
  agentId: Schema.String,
  message: Schema.String
}) {}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  entity: Schema.String,
  id: Schema.String
}) {}

export class InvalidTransitionError extends Schema.TaggedError<InvalidTransitionError>()(
  "InvalidTransitionError",
  {
    entity: Schema.String,
    from: Schema.String,
    to: Schema.String
  }
) {}

export class DecodeError extends Schema.TaggedError<DecodeError>()("DecodeError", {
  what: Schema.String,
  message: Schema.String
}) {}

export type DurableError =
  | StorageError
  | ModelError
  | ToolExecutionError
  | ToolBlockedError
  | RuntimeConfigurationError
  | UnknownOutcomeError
  | SubmissionError
  | NotFoundError
  | DecodeError
