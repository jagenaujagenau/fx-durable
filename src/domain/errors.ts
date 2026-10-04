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

export class CheckpointError extends Schema.TaggedError<CheckpointError>()("CheckpointError", {
  agentId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  agentId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

export class ToolExecutionError extends Schema.TaggedError<ToolExecutionError>()("ToolExecutionError", {
  taskId: Schema.String,
  tool: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "RuntimeConfigurationError",
  {
    runtimeId: Schema.String,
    message: Schema.String
  }
) {}

export class InterruptedError extends Schema.TaggedError<InterruptedError>()("InterruptedError", {
  message: Schema.String
}) {}

export class UnknownOutcomeError extends Schema.TaggedError<UnknownOutcomeError>()("UnknownOutcomeError", {
  taskId: Schema.String,
  tool: Schema.String,
  message: Schema.String
}) {}

export class SubmissionError extends Schema.TaggedError<SubmissionError>()("SubmissionError", {
  submissionId: Schema.String,
  state: Schema.String,
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
  | CheckpointError
  | ModelError
  | ToolExecutionError
  | RuntimeConfigurationError
  | InterruptedError
  | UnknownOutcomeError
  | SubmissionError
  | NotFoundError
  | DecodeError
