import { Context, type Effect, type Stream } from "effect"
import type { StorageError } from "./errors.js"
import type { Json, JsonObject } from "./json.js"
import type {
  AgentCheckpoint,
  AgentState,
  DurableAgentRecord,
  DurableEvent,
  ReplayPolicyName,
  SubmissionRecord,
  SubmissionResult,
  SubmissionState,
  TaskRecord,
  TaskState,
  TaskType,
  TurnRecord,
  TurnState
} from "./schema.js"

/**
 * The narrow persistence boundary. SQLite is the only v1 implementation, but
 * nothing here depends on SQLite- or Effect-SQL-specific types.
 *
 * Rules:
 * - every operation is serialized with every other operation;
 * - inside `transaction`, operations join the open transaction;
 * - transactions are uninterruptible and must never contain external I/O.
 */

export interface ExecutorRecord {
  readonly id: string
  readonly pid: number
  readonly hostname: string
  readonly startedAt: Date
  readonly heartbeatAt: Date
  readonly stoppedAt: Date | null
}

export interface NewTask {
  readonly id: string
  readonly turnId: string
  readonly agentId: string
  readonly parentTaskId: string | null
  readonly type: TaskType
  readonly state: TaskState
  readonly name: string | null
  readonly input: Json
  readonly inputHash: string | null
  readonly replayPolicy: ReplayPolicyName | null
  readonly idempotencyKey: string | null
  readonly attempt: number
  readonly metadata: Json
  readonly startedAt: Date | null
}

export interface TaskPatch {
  readonly state?: TaskState
  readonly output?: Json
  readonly error?: string | null
  readonly acknowledged?: boolean
  readonly metadata?: Json
  readonly completedAt?: Date | null
}

export interface NewEvent {
  readonly id: string
  readonly agentId: string
  readonly submissionId: string | null
  readonly turnId: string | null
  readonly taskId: string | null
  readonly type: string
  readonly payload: JsonObject
  readonly createdAt: Date
}

export interface StorageInterface {
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | StorageError, R>
  /** Run `effect` after the current transaction commits (immediately when outside one). */
  readonly afterCommit: (effect: Effect.Effect<void>) => Effect.Effect<void>

  // agents
  readonly getAgent: (id: string) => Effect.Effect<DurableAgentRecord | null, StorageError>
  readonly listAgents: () => Effect.Effect<ReadonlyArray<DurableAgentRecord>, StorageError>
  readonly insertAgent: (agent: DurableAgentRecord) => Effect.Effect<void, StorageError>
  readonly updateAgent: (
    id: string,
    patch: {
      readonly state?: AgentState
      readonly stateReason?: string | null
      readonly runtimeId?: string
      readonly model?: string
      readonly cwd?: string | null
    },
    now: Date
  ) => Effect.Effect<void, StorageError>

  // submissions
  readonly getSubmission: (id: string) => Effect.Effect<SubmissionRecord | null, StorageError>
  readonly findSubmissionByRequest: (
    agentId: string,
    requestId: string
  ) => Effect.Effect<SubmissionRecord | null, StorageError>
  readonly nextQueuedSubmission: (agentId: string) => Effect.Effect<SubmissionRecord | null, StorageError>
  readonly listSubmissions: (agentId: string, limit: number) => Effect.Effect<ReadonlyArray<SubmissionRecord>, StorageError>
  readonly insertSubmission: (submission: SubmissionRecord) => Effect.Effect<void, StorageError>
  readonly updateSubmission: (
    id: string,
    patch: {
      readonly state?: SubmissionState
      readonly result?: SubmissionResult
      readonly error?: string | null
      readonly cancelRequested?: boolean
    },
    now: Date
  ) => Effect.Effect<void, StorageError>

  // turns
  readonly getTurn: (id: string) => Effect.Effect<TurnRecord | null, StorageError>
  readonly activeTurn: (agentId: string) => Effect.Effect<TurnRecord | null, StorageError>
  readonly unfinishedTurns: () => Effect.Effect<ReadonlyArray<TurnRecord>, StorageError>
  readonly listTurns: (agentId: string, limit: number) => Effect.Effect<ReadonlyArray<TurnRecord>, StorageError>
  readonly turnForSubmission: (submissionId: string) => Effect.Effect<TurnRecord | null, StorageError>
  readonly insertTurn: (turn: TurnRecord) => Effect.Effect<void, StorageError>
  readonly updateTurn: (
    id: string,
    patch: {
      readonly state?: TurnState
      readonly attempt?: number
      readonly executorId?: string | null
      readonly completedAt?: Date | null
    }
  ) => Effect.Effect<void, StorageError>

  // tasks
  readonly getTask: (id: string) => Effect.Effect<TaskRecord | null, StorageError>
  readonly tasksForTurn: (turnId: string) => Effect.Effect<ReadonlyArray<TaskRecord>, StorageError>
  readonly unfinishedTasks: () => Stream.Stream<TaskRecord, StorageError>
  readonly insertTask: (task: NewTask) => Effect.Effect<void, StorageError>
  readonly updateTask: (id: string, patch: TaskPatch) => Effect.Effect<void, StorageError>

  // checkpoints
  readonly latestCheckpoint: (agentId: string) => Effect.Effect<AgentCheckpoint | null, StorageError>
  readonly insertCheckpoint: (checkpoint: AgentCheckpoint) => Effect.Effect<void, StorageError>

  // events
  readonly appendEvent: (event: NewEvent) => Effect.Effect<DurableEvent, StorageError>
  readonly eventsAfter: (
    agentId: string,
    after: number,
    limit: number
  ) => Effect.Effect<ReadonlyArray<DurableEvent>, StorageError>

  // executors
  readonly registerExecutor: (executor: ExecutorRecord) => Effect.Effect<void, StorageError>
  readonly heartbeatExecutor: (id: string, now: Date) => Effect.Effect<void, StorageError>
  readonly stopExecutor: (id: string, now: Date) => Effect.Effect<void, StorageError>
  readonly getExecutor: (id: string) => Effect.Effect<ExecutorRecord | null, StorageError>

  readonly close: () => Effect.Effect<void>
}

export class Storage extends Context.Service<Storage, StorageInterface>()("fx-durable/Storage") {}
