import { Context, Effect, Layer } from "effect"
import { NotFoundError, type StorageError } from "./errors.js"
import { EventLog, type AppendEvent } from "./events.js"
import { IdGenerator, now } from "./ids.js"
import type { Json } from "./json.js"
import type {
  AgentState,
  ReplayPolicyName,
  SubmissionResult,
  SubmissionState,
  TaskRecord,
  TaskState,
  TaskType,
  TurnState
} from "./schema.js"
import {
  assertAgentTransition,
  assertSubmissionTransition,
  assertTaskTransition,
  assertTurnTransition
} from "./state-machine.js"
import { Storage, type TaskPatch } from "./storage.js"

/**
 * TaskEngine owns every durable state transition. Each method validates the
 * transition against the state machine (invalid transitions are defects),
 * persists it, and appends the describing event in the same transaction.
 *
 * Callers compose these inside `storage.transaction` when several facts must
 * commit atomically.
 */

export interface StartTask {
  readonly turnId: string
  readonly agentId: string
  readonly type: TaskType
  readonly name?: string | null
  readonly input?: Json
  readonly inputHash?: string | null
  readonly parentTaskId?: string | null
  readonly replayPolicy?: ReplayPolicyName | null
  readonly idempotencyKey?: string | null
  readonly attempt?: number
  readonly metadata?: Json
  readonly id?: string
  readonly event?: Omit<AppendEvent, "agentId" | "taskId" | "turnId"> | null
}

type Event = Omit<AppendEvent, "agentId"> | null

export interface TaskEngineInterface {
  readonly startTask: (task: StartTask) => Effect.Effect<TaskRecord, StorageError>
  readonly transitionTask: (
    taskId: string,
    to: TaskState,
    patch?: Omit<TaskPatch, "state">,
    event?: Event
  ) => Effect.Effect<TaskRecord, StorageError | NotFoundError>
  readonly transitionTurn: (
    turnId: string,
    to: TurnState,
    patch?: { readonly attempt?: number; readonly executorId?: string | null },
    event?: Event
  ) => Effect.Effect<void, StorageError | NotFoundError>
  readonly transitionSubmission: (
    submissionId: string,
    to: SubmissionState,
    patch?: { readonly result?: SubmissionResult; readonly error?: string | null },
    event?: Event
  ) => Effect.Effect<void, StorageError | NotFoundError>
  readonly transitionAgent: (
    agentId: string,
    to: AgentState,
    reason?: string | null,
    event?: Event
  ) => Effect.Effect<void, StorageError | NotFoundError>
  readonly emit: (event: AppendEvent) => Effect.Effect<void, StorageError>
}

export class TaskEngine extends Context.Service<TaskEngine, TaskEngineInterface>()("fx-durable/TaskEngine") {}

const isTerminal = (state: string) => ["completed", "failed", "cancelled", "outcome_unknown"].includes(state)

export const layer = Layer.effect(
  TaskEngine,
  Effect.gen(function* () {
    const storage = yield* Storage
    const events = yield* EventLog
    const ids = yield* IdGenerator

    const startTask = Effect.fn("TaskEngine.startTask")(function* (task: StartTask) {
      const id = task.id ?? (yield* ids.next("task"))
      const startedAt = yield* now
      const record = {
        id,
        turnId: task.turnId,
        agentId: task.agentId,
        parentTaskId: task.parentTaskId ?? null,
        type: task.type,
        state: "running" as const,
        name: task.name ?? null,
        input: task.input ?? null,
        inputHash: task.inputHash ?? null,
        replayPolicy: task.replayPolicy ?? null,
        idempotencyKey: task.idempotencyKey ?? null,
        attempt: task.attempt ?? 1,
        metadata: task.metadata ?? null,
        startedAt
      }
      yield* storage.transaction(
        Effect.gen(function* () {
          yield* storage.insertTask(record)
          if (task.event) {
            const turn = yield* storage.getTurn(task.turnId)
            yield* events.append({
              submissionId: turn?.submissionId ?? null,
              ...task.event,
              agentId: task.agentId,
              turnId: task.turnId,
              taskId: id
            })
          }
        })
      )
      const inserted: TaskRecord = {
        ...record,
        output: null,
        error: null,
        acknowledged: false,
        completedAt: null
      }
      return inserted
    })

    const transitionTask = Effect.fn("TaskEngine.transitionTask")(function* (
      taskId: string,
      to: TaskState,
      patch?: Omit<TaskPatch, "state">,
      event?: Event
    ) {
      return yield* storage.transaction(
        Effect.gen(function* () {
          const task = yield* storage.getTask(taskId)
          if (!task) return yield* new NotFoundError({ entity: "task", id: taskId })
          assertTaskTransition(task.state, to)
          const completedAt = isTerminal(to) || to === "interrupted" ? yield* now : undefined
          yield* storage.updateTask(taskId, { ...patch, state: to, completedAt: patch?.completedAt ?? completedAt })
          if (event) {
            const turn = yield* storage.getTurn(task.turnId)
            yield* events.append({
              submissionId: turn?.submissionId ?? null,
              ...event,
              agentId: task.agentId,
              turnId: task.turnId,
              taskId
            })
          }
          const updated = yield* storage.getTask(taskId)
          return updated ?? task
        })
      )
    })

    const transitionTurn = Effect.fn("TaskEngine.transitionTurn")(function* (
      turnId: string,
      to: TurnState,
      patch?: { readonly attempt?: number; readonly executorId?: string | null },
      event?: Event
    ) {
      yield* storage.transaction(
        Effect.gen(function* () {
          const turn = yield* storage.getTurn(turnId)
          if (!turn) return yield* new NotFoundError({ entity: "turn", id: turnId })
          assertTurnTransition(turn.state, to)
          const completedAt = isTerminal(to) ? yield* now : undefined
          yield* storage.updateTurn(turnId, { ...patch, state: to, completedAt })
          if (event) {
            yield* events.append({ submissionId: turn.submissionId, ...event, agentId: turn.agentId, turnId })
          }
        })
      )
    })

    const transitionSubmission = Effect.fn("TaskEngine.transitionSubmission")(function* (
      submissionId: string,
      to: SubmissionState,
      patch?: { readonly result?: SubmissionResult; readonly error?: string | null },
      event?: Event
    ) {
      yield* storage.transaction(
        Effect.gen(function* () {
          const submission = yield* storage.getSubmission(submissionId)
          if (!submission) return yield* new NotFoundError({ entity: "submission", id: submissionId })
          assertSubmissionTransition(submission.state, to)
          yield* storage.updateSubmission(submissionId, { ...patch, state: to }, yield* now)
          if (event) {
            yield* events.append({ ...event, agentId: submission.agentId, submissionId })
          }
        })
      )
    })

    const transitionAgent = Effect.fn("TaskEngine.transitionAgent")(function* (
      agentId: string,
      to: AgentState,
      reason?: string | null,
      event?: Event
    ) {
      yield* storage.transaction(
        Effect.gen(function* () {
          const agent = yield* storage.getAgent(agentId)
          if (!agent) return yield* new NotFoundError({ entity: "agent", id: agentId })
          assertAgentTransition(agent.state, to)
          yield* storage.updateAgent(agentId, { state: to, stateReason: reason ?? null }, yield* now)
          if (event) yield* events.append({ ...event, agentId })
        })
      )
    })

    const emit = (event: AppendEvent) =>
      Effect.gen(function* () {
        let submissionId = event.submissionId ?? null
        if (submissionId === null && event.turnId) {
          submissionId = (yield* storage.getTurn(event.turnId))?.submissionId ?? null
        }
        yield* events.append({ ...event, submissionId })
      })

    return TaskEngine.of({ startTask, transitionTask, transitionTurn, transitionSubmission, transitionAgent, emit })
  })
)
