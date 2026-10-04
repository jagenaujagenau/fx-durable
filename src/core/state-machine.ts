import { InvalidTransitionError } from "./errors.js"
import type { AgentState, SubmissionState, TaskState, TurnState } from "./schema.js"

/**
 * Explicit state machines. Every persisted transition is validated against
 * these tables; an invalid transition is a programmer error (a defect), not
 * an expected failure.
 */

type Table<S extends string> = { readonly [K in S]: ReadonlyArray<S> }

export const TaskTransitions = {
  pending: ["running", "cancelled", "interrupted"],
  running: ["completed", "failed", "cancelled", "interrupted", "outcome_unknown"],
  // An interrupted task is either replayed (via a new child task) or
  // re-classified as outcome_unknown. The original row stays interrupted.
  interrupted: ["outcome_unknown"],
  completed: [],
  failed: [],
  cancelled: [],
  outcome_unknown: []
} satisfies Table<TaskState>

export const TurnTransitions = {
  running: ["completed", "failed", "cancelled", "interrupted", "running"],
  interrupted: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
} satisfies Table<TurnState>

export const SubmissionTransitions = {
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled", "needs_input", "running"],
  needs_input: ["running", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: []
} satisfies Table<SubmissionState>

export const AgentTransitions = {
  idle: ["running", "recovering", "idle", "configuration_error"],
  running: ["idle", "failed", "needs_input", "recovering", "running", "configuration_error"],
  recovering: ["running", "needs_input", "idle", "configuration_error", "failed", "recovering"],
  needs_input: ["running", "idle", "recovering", "needs_input"],
  failed: ["running", "idle", "recovering"],
  configuration_error: ["recovering", "idle", "running", "configuration_error"]
} satisfies Table<AgentState>

export const isTerminalTask = (state: TaskState): boolean => TaskTransitions[state].length === 0
export const isTerminalSubmission = (state: SubmissionState): boolean => SubmissionTransitions[state].length === 0

const check =
  <S extends string>(entity: string, table: Table<S>) =>
  (from: S, to: S): void => {
    if (!table[from].includes(to)) {
      throw new InvalidTransitionError({ entity, from, to })
    }
  }

export const assertTaskTransition = check<TaskState>("task", TaskTransitions)
export const assertTurnTransition = check<TurnState>("turn", TurnTransitions)
export const assertSubmissionTransition = check<SubmissionState>("submission", SubmissionTransitions)
export const assertAgentTransition = check<AgentState>("agent", AgentTransitions)
