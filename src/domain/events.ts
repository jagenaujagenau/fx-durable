import type { JsonObject } from "./json.js"

/** The durable event taxonomy. Every meaningful state transition appends one of these. */
export const EVENT_TYPES = [
  "agent.created",
  "agent.updated",
  "agent.idle",
  "agent.configuration_error",
  "agent.needs_input",
  "submission.created",
  "submission.started",
  "submission.completed",
  "submission.failed",
  "submission.cancelled",
  "submission.needs_input",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.interrupted",
  "turn.recovered",
  "model.started",
  "model.completed",
  "model.failed",
  "model.interrupted",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.cancelled",
  "tool.interrupted",
  "tool.replayed",
  "tool.reused",
  "tool.outcome_unknown",
  "tool.outcome_unknown_refused",
  "checkpoint.created",
  "recovery.started",
  "recovery.completed",
  "recovery.failed"
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export interface AppendEvent {
  readonly agentId: string
  readonly type: EventType
  readonly submissionId?: string | null
  readonly turnId?: string | null
  readonly taskId?: string | null
  readonly payload?: JsonObject
}
