import { NotFoundError } from "./errors.js"
import { executorGone, lostReason } from "./executors.js"
import type { Json, JsonObject } from "./json.js"
import type {
  AgentCheckpoint,
  AgentState,
  DurableEvent,
  ReplayPolicyName,
  SubmissionRecord,
  SubmissionResult,
  SubmissionState,
  TaskRecord,
  TaskState,
  TaskType,
  TurnRecord,
  TurnState,
  UnknownOutcomeReason
} from "./schema.js"
import {
  assertAgentTransition,
  assertSubmissionTransition,
  assertTaskTransition,
  assertTurnTransition
} from "./state-machine.js"
import type { Storage, TaskPatch } from "./storage.js"
import { recoveryActionFor } from "../tools/replay-policy.js"

/**
 * The durable journal: every state transition fx-durable makes, as plain
 * synchronous code on top of `Storage`. No Effect runtime is involved.
 *
 * Each mutating method validates the transition against the state machine
 * (an invalid transition throws `InvalidTransitionError`, a programmer error),
 * persists it, and appends the event that describes it in the same
 * transaction. Calls compose: wrap several in `journal.transaction(() => …)`
 * and they commit together.
 *
 * Committed events are delivered to `onCommitted` listeners after commit.
 */

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

/** An event attached to a transition; the journal fills in the owning ids. */
export type TransitionEvent = Omit<AppendEvent, "agentId"> | null

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

export interface WriteCheckpoint {
  readonly agentId: string
  readonly turnId: string
  readonly submissionId: string
  readonly taskId: string
  readonly runtimeId: string
  readonly model: string
  readonly data: Uint8Array
  /** The checkpoint the turn started from; anything else is a programmer error. */
  readonly expectedPrevious: number | null
}

export interface JournalOptions {
  readonly storage: Storage
  readonly nextId: (prefix: string) => string
  readonly now?: () => Date
}

const isTerminal = (state: string) => ["completed", "failed", "cancelled", "outcome_unknown"].includes(state)

export class Journal {
  readonly storage: Storage
  readonly nextId: (prefix: string) => string
  readonly now: () => Date
  private readonly listeners = new Set<(event: DurableEvent) => void>()

  constructor(options: JournalOptions) {
    this.storage = options.storage
    this.nextId = options.nextId
    this.now = options.now ?? (() => new Date())
  }

  transaction<A>(fn: () => A): A {
    return this.storage.transaction(fn)
  }

  /** Listen for events after their transaction commits. Returns an unsubscribe function. */
  onCommitted(listener: (event: DurableEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Append an event. Run it inside the transaction of the change it describes. */
  appendEvent(event: AppendEvent): DurableEvent {
    let submissionId = event.submissionId ?? null
    if (submissionId === null && event.turnId) {
      submissionId = this.storage.getTurn(event.turnId)?.submissionId ?? null
    }
    const persisted = this.storage.appendEvent({
      id: this.nextId("evt"),
      agentId: event.agentId,
      submissionId,
      turnId: event.turnId ?? null,
      taskId: event.taskId ?? null,
      type: event.type,
      payload: event.payload ?? {},
      createdAt: this.now()
    })
    this.storage.afterCommit(() => {
      for (const listener of this.listeners) listener(persisted)
    })
    return persisted
  }

  // -------------------------------------------------------------------------
  // Validated transitions
  // -------------------------------------------------------------------------

  startTask(task: StartTask): TaskRecord {
    const id = task.id ?? this.nextId("task")
    const startedAt = this.now()
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
    this.transaction(() => {
      this.storage.insertTask(record)
      if (task.event) this.appendEvent({ ...task.event, agentId: task.agentId, turnId: task.turnId, taskId: id })
    })
    return { ...record, output: null, error: null, acknowledged: false, completedAt: null }
  }

  transitionTask(taskId: string, to: TaskState, patch: Omit<TaskPatch, "state"> = {}, event: TransitionEvent = null): TaskRecord {
    return this.transaction(() => {
      const task = this.storage.getTask(taskId)
      if (!task) throw new NotFoundError({ entity: "task", id: taskId })
      assertTaskTransition(task.state, to)
      const completedAt = isTerminal(to) || to === "interrupted" ? this.now() : undefined
      this.storage.updateTask(taskId, { ...patch, state: to, completedAt: patch.completedAt ?? completedAt })
      if (event) this.appendEvent({ ...event, agentId: task.agentId, turnId: task.turnId, taskId })
      return this.storage.getTask(taskId) ?? task
    })
  }

  transitionTurn(
    turnId: string,
    to: TurnState,
    patch: { readonly attempt?: number; readonly executorId?: string | null } = {},
    event: TransitionEvent = null
  ): void {
    this.transaction(() => {
      const turn = this.storage.getTurn(turnId)
      if (!turn) throw new NotFoundError({ entity: "turn", id: turnId })
      assertTurnTransition(turn.state, to)
      const completedAt = isTerminal(to) ? this.now() : undefined
      this.storage.updateTurn(turnId, { ...patch, state: to, completedAt })
      if (event) this.appendEvent({ submissionId: turn.submissionId, ...event, agentId: turn.agentId, turnId })
    })
  }

  transitionSubmission(
    submissionId: string,
    to: SubmissionState,
    patch: { readonly result?: SubmissionResult; readonly error?: string | null } = {},
    event: TransitionEvent = null
  ): void {
    this.transaction(() => {
      const submission = this.storage.getSubmission(submissionId)
      if (!submission) throw new NotFoundError({ entity: "submission", id: submissionId })
      assertSubmissionTransition(submission.state, to)
      this.storage.updateSubmission(submissionId, { ...patch, state: to }, this.now())
      if (event) this.appendEvent({ ...event, agentId: submission.agentId, submissionId })
    })
  }

  transitionAgent(agentId: string, to: AgentState, reason: string | null = null, event: TransitionEvent = null): void {
    this.transaction(() => {
      const agent = this.storage.getAgent(agentId)
      if (!agent) throw new NotFoundError({ entity: "agent", id: agentId })
      assertAgentTransition(agent.state, to)
      this.storage.updateAgent(agentId, { state: to, stateReason: reason }, this.now())
      if (event) this.appendEvent({ ...event, agentId })
    })
  }

  /**
   * Write the next checkpoint. Run it inside the transaction that also
   * completes the turn, so a checkpoint never exists for an unfinished turn.
   */
  writeCheckpoint(fields: WriteCheckpoint): AgentCheckpoint {
    return this.transaction(() => {
      const previousSeq = this.storage.latestCheckpoint(fields.agentId)?.sequence ?? null
      if (previousSeq !== fields.expectedPrevious) {
        throw new Error(
          `checkpoint sequence conflict for ${fields.agentId}: expected ${fields.expectedPrevious}, found ${previousSeq}`
        )
      }
      const checkpoint: AgentCheckpoint = {
        id: this.nextId("ckpt"),
        agentId: fields.agentId,
        sequence: (previousSeq ?? 0) + 1,
        fxCheckpoint: fields.data,
        runtimeId: fields.runtimeId,
        model: fields.model,
        createdAt: this.now()
      }
      this.storage.insertCheckpoint(checkpoint)
      this.appendEvent({
        agentId: fields.agentId,
        submissionId: fields.submissionId,
        turnId: fields.turnId,
        taskId: fields.taskId,
        type: "checkpoint.created",
        payload: { sequence: checkpoint.sequence, bytes: fields.data.byteLength }
      })
      return checkpoint
    })
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /** Begin a turn for a queued submission. Returns null if it is no longer runnable. */
  startTurn(submission: SubmissionRecord, executorId: string): TurnRecord | null {
    return this.transaction(() => {
      const current = this.storage.getSubmission(submission.id)
      if (!current || current.state !== "queued" || current.cancelRequested) return null
      const checkpoint = this.storage.latestCheckpoint(submission.agentId)
      const startedAt = this.now()
      const turn: TurnRecord = {
        id: this.nextId("turn"),
        agentId: submission.agentId,
        submissionId: submission.id,
        state: "running",
        attempt: 1,
        executorId,
        baseCheckpointSeq: checkpoint?.sequence ?? null,
        startedAt,
        completedAt: null
      }
      this.storage.insertTurn(turn)
      this.storage.insertTask({
        id: this.nextId("task"),
        turnId: turn.id,
        agentId: turn.agentId,
        parentTaskId: null,
        type: "turn",
        state: "running",
        name: null,
        input: null,
        inputHash: null,
        replayPolicy: null,
        idempotencyKey: null,
        attempt: 1,
        metadata: null,
        startedAt
      })
      this.transitionSubmission(submission.id, "running", {}, { type: "submission.started", turnId: turn.id })
      this.transitionAgent(submission.agentId, "running")
      this.appendEvent({
        agentId: turn.agentId,
        submissionId: submission.id,
        turnId: turn.id,
        type: "turn.started",
        payload: { attempt: 1, baseCheckpoint: turn.baseCheckpointSeq }
      })
      return turn
    })
  }

  markOutcomeUnknown(task: TaskRecord, reason: UnknownOutcomeReason): void {
    this.transitionTask(task.id, "outcome_unknown", { error: `outcome unknown: ${reason}` }, {
      type: "tool.outcome_unknown",
      payload: {
        taskId: task.id,
        tool: task.name,
        input: task.input,
        startedAt: task.startedAt?.toISOString() ?? null,
        reason
      }
    })
  }

  /**
   * Classify the unfinished tasks of a turn by their persisted policy: model
   * and checkpoint tasks are interrupted (replay-safe), safe and idempotent
   * tools are interrupted for replay, unsafe tools become outcome_unknown.
   * Returns the ids of tasks marked outcome_unknown.
   */
  classifyTurnTasks(turnId: string, reason: UnknownOutcomeReason): ReadonlyArray<string> {
    return this.transaction(() => {
      const unknown: Array<string> = []
      for (const task of this.storage.tasksForTurn(turnId)) {
        if (task.state !== "running" && task.state !== "pending") continue
        switch (task.type) {
          case "turn":
            break
          case "model":
            this.transitionTask(task.id, "interrupted", { error: reason }, {
              type: "model.interrupted",
              payload: { model: task.name, reason }
            })
            break
          case "checkpoint":
            this.transitionTask(task.id, "interrupted", { error: reason })
            break
          case "tool": {
            const action = recoveryActionFor(task.replayPolicy ?? "unsafe")
            if (action === "mark_outcome_unknown") {
              this.markOutcomeUnknown(task, reason)
              unknown.push(task.id)
            } else {
              this.transitionTask(task.id, "interrupted", { error: reason }, {
                type: "tool.interrupted",
                payload: { tool: task.name, input: task.input, replay: task.replayPolicy, action, reason }
              })
            }
            break
          }
        }
      }
      return unknown
    })
  }

  /** Close the turn's root task, if it is still open. */
  closeTurnTask(turnId: string, to: "completed" | "failed" | "cancelled", error?: string): void {
    const root = this.storage.tasksForTurn(turnId).find((t) => t.type === "turn" && t.parentTaskId === null)
    if (root && root.state === "running") this.transitionTask(root.id, to, error ? { error } : {})
  }

  failTurn(turn: TurnRecord, message: string): void {
    this.transaction(() => {
      this.closeTurnTask(turn.id, "failed", message)
      this.transitionTurn(turn.id, "failed", {}, { type: "turn.failed", payload: { error: message } })
      this.transitionSubmission(turn.submissionId, "failed", { error: message }, {
        type: "submission.failed",
        turnId: turn.id,
        payload: { error: message }
      })
      this.transitionAgent(turn.agentId, "failed", message)
    })
  }

  cancelTurn(turn: TurnRecord): void {
    this.transaction(() => {
      this.closeTurnTask(turn.id, "cancelled", "cancelled")
      this.transitionTurn(turn.id, "cancelled", {}, { type: "turn.cancelled" })
      this.transitionSubmission(turn.submissionId, "cancelled", { error: "cancelled" }, {
        type: "submission.cancelled",
        turnId: turn.id
      })
      this.transitionAgent(turn.agentId, "idle")
    })
  }

  /** The turn's owner went away cleanly (shutdown): leave it for recovery. */
  interruptTurn(turn: TurnRecord, reason: string): void {
    this.transaction(() => {
      const current = this.storage.getTurn(turn.id)
      if (!current || current.state !== "running") return
      this.transitionTurn(turn.id, "interrupted", { executorId: null }, {
        type: "turn.interrupted",
        payload: { reason, attempt: current.attempt }
      })
    })
  }

  /**
   * Journal-only recovery for observers such as `fxd recover`: classify the
   * interrupted work of dead executors without executing anything. The
   * application continues those turns on its next `resume()`.
   */
  recoverJournal(): ReadonlyArray<{ readonly turnId: string; readonly agentId: string; readonly unknown: ReadonlyArray<string> }> {
    const at = this.now()
    const classified: Array<{ turnId: string; agentId: string; unknown: ReadonlyArray<string> }> = []
    for (const turn of this.storage.unfinishedTurns()) {
      const record = turn.executorId ? this.storage.getExecutor(turn.executorId) : null
      if (turn.executorId !== null && !executorGone(record, at, null)) continue
      const reason = lostReason(record)
      const unknown = this.transaction(() => {
        const agent = this.storage.getAgent(turn.agentId)
        if (agent && agent.state !== "recovering") {
          this.transitionAgent(agent.id, "recovering", "interrupted turn awaiting application resume", {
            type: "recovery.started",
            turnId: turn.id,
            submissionId: turn.submissionId,
            payload: { attempt: turn.attempt, previousExecutor: turn.executorId, mode: "journal" }
          })
        }
        if (turn.state === "running") {
          this.transitionTurn(turn.id, "interrupted", { executorId: null }, {
            type: "turn.interrupted",
            payload: { reason, attempt: turn.attempt }
          })
        }
        return this.classifyTurnTasks(turn.id, reason)
      })
      if (turn.state === "running" || unknown.length > 0) classified.push({ turnId: turn.id, agentId: turn.agentId, unknown })
    }
    return classified
  }
}
