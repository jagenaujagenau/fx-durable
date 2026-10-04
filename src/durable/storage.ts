import type { Json, JsonObject } from "../domain/json.js"
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
} from "../domain/schema.js"

/**
 * The narrow persistence boundary: plain synchronous code, no Effect runtime.
 * Storage is deliberately dumb: the Journal defines meaning, Storage provides
 * atomic persistence. SQLite is the only built-in implementation.
 *
 * Every method is synchronous and throws `StorageError` on failure.
 *
 * ## Durability contract
 *
 * fx-durable's correctness guarantees hold only if an implementation keeps
 * all of these (`storageContract` in `fx-durable/testing` checks them):
 *
 * 1. `transaction(fn)` is atomic: all of its writes commit, or none do.
 * 2. A transaction opened inside another joins the outer one.
 * 3. An exception thrown inside a transaction rolls back the whole transaction,
 *    including writes made by nested transactions.
 * 4. A transaction body that returns a Promise is rejected (nothing commits).
 * 5. Transaction bodies never perform external I/O. This is the caller's side
 *    of the contract: model calls, tool execution and network requests always
 *    happen outside transactions.
 * 6. Reads inside a transaction observe that transaction's own writes.
 * 7. `afterCommit` callbacks run only after the outermost commit, never after a
 *    rollback; outside a transaction they run immediately.
 * 8. Committed writes are durable: they survive a process crash.
 * 9. Constraints hold: one submission per `(agentId, requestId)`, one active
 *    (running or interrupted) turn per agent, one checkpoint per
 *    `(agentId, sequence)`, and event sequences per agent start at 1 and have
 *    no gaps.
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

export interface Storage {
  readonly transaction: <A>(fn: () => A) => A
  /** Run `fn` after the current transaction commits (immediately when outside one). */
  readonly afterCommit: (fn: () => void) => void

  // agents
  readonly getAgent: (id: string) => DurableAgentRecord | null
  readonly listAgents: () => ReadonlyArray<DurableAgentRecord>
  readonly insertAgent: (agent: DurableAgentRecord) => void
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
  ) => void

  // submissions
  readonly getSubmission: (id: string) => SubmissionRecord | null
  readonly findSubmissionByRequest: (
    agentId: string,
    requestId: string
  ) => SubmissionRecord | null
  readonly nextQueuedSubmission: (agentId: string) => SubmissionRecord | null
  readonly listSubmissions: (agentId: string, limit: number) => ReadonlyArray<SubmissionRecord>
  readonly insertSubmission: (submission: SubmissionRecord) => void
  readonly updateSubmission: (
    id: string,
    patch: {
      readonly state?: SubmissionState
      readonly result?: SubmissionResult
      readonly error?: string | null
      readonly cancelRequested?: boolean
    },
    now: Date
  ) => void

  // turns
  readonly getTurn: (id: string) => TurnRecord | null
  readonly activeTurn: (agentId: string) => TurnRecord | null
  readonly unfinishedTurns: () => ReadonlyArray<TurnRecord>
  readonly listTurns: (agentId: string, limit: number) => ReadonlyArray<TurnRecord>
  readonly turnForSubmission: (submissionId: string) => TurnRecord | null
  readonly insertTurn: (turn: TurnRecord) => void
  readonly updateTurn: (
    id: string,
    patch: {
      readonly state?: TurnState
      readonly attempt?: number
      readonly executorId?: string | null
      readonly completedAt?: Date | null
    }
  ) => void

  // tasks
  readonly getTask: (id: string) => TaskRecord | null
  readonly tasksForTurn: (turnId: string) => ReadonlyArray<TaskRecord>
  readonly unfinishedTasks: () => ReadonlyArray<TaskRecord>
  readonly insertTask: (task: NewTask) => void
  readonly updateTask: (id: string, patch: TaskPatch) => void

  // checkpoints
  readonly latestCheckpoint: (agentId: string) => AgentCheckpoint | null
  readonly insertCheckpoint: (checkpoint: AgentCheckpoint) => void

  // events
  readonly appendEvent: (event: NewEvent) => DurableEvent
  readonly eventsAfter: (
    agentId: string,
    after: number,
    limit: number
  ) => ReadonlyArray<DurableEvent>

  // executors
  readonly registerExecutor: (executor: ExecutorRecord) => void
  readonly heartbeatExecutor: (id: string, now: Date) => void
  readonly stopExecutor: (id: string, now: Date) => void
  readonly getExecutor: (id: string) => ExecutorRecord | null

  readonly close: () => void
}


/** The read-only view of storage handed to runtime code through `Database.read`. */
export type StorageReader = Pick<
  Storage,
  | "getAgent"
  | "listAgents"
  | "getSubmission"
  | "findSubmissionByRequest"
  | "nextQueuedSubmission"
  | "listSubmissions"
  | "getTurn"
  | "activeTurn"
  | "unfinishedTurns"
  | "listTurns"
  | "turnForSubmission"
  | "getTask"
  | "tasksForTurn"
  | "unfinishedTasks"
  | "latestCheckpoint"
  | "eventsAfter"
  | "getExecutor"
>
