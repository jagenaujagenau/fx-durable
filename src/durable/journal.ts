import { InterruptedError, NotFoundError } from "../domain/errors.js"
import type { AppendEvent } from "../domain/events.js"
import { SystemClock, type Clock } from "./clock.js"
import { executorGone, lostReason } from "../domain/executors.js"
import type { Json } from "../domain/json.js"
import type {
  AgentCheckpoint,
  AgentState,
  DurableAgentRecord,
  DurableEvent,
  ReplayPolicyName,
  SubmissionContent,
  SubmissionRecord,
  SubmissionResult,
  SubmissionState,
  TaskRecord,
  TaskState,
  TaskType,
  TurnRecord,
  TurnState,
  UnknownOutcomeReason
} from "../domain/schema.js"
import {
  assertAgentTransition,
  assertSubmissionTransition,
  assertTaskTransition,
  assertTurnTransition,
  isTerminalSubmission
} from "../domain/state-machine.js"
import { readerOf, type Storage, type StorageReader, type TaskPatch } from "./storage.js"
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

export { EVENT_TYPES } from "../domain/events.js"
export type { AppendEvent, EventType } from "../domain/events.js"

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
  readonly clock?: Clock
}

/** A submission, and whether this call created it (false for a retried request ID). */
export interface Admission {
  readonly record: SubmissionRecord
  readonly created: boolean
}

/** Where a fork starts. Without `after` or `checkpoint`, it starts from the latest checkpoint. */
export interface ForkSpec {
  /** Start from the conversation as it was when this submission's turn completed. */
  readonly after?: string
  /** Start from this checkpoint sequence of the source agent. */
  readonly checkpoint?: number
  readonly runtime?: string
  readonly model?: string
  /** Working directory for the fork. The files are not copied: give it its own copy if both will edit. */
  readonly cwd?: string | null
}

export interface AgentConfig {
  readonly runtime: string
  readonly model: string
  /** `undefined` keeps the stored cwd. */
  readonly cwd?: string | null
}

export interface ModelCall {
  readonly agentId: string
  readonly submissionId: string
  readonly turnId: string
  readonly attempt: number
  readonly model: string
}

export interface ModelSummary {
  readonly text: string
  readonly toolCalls: ReadonlyArray<string>
  readonly finishReason: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly durationMs: number
}

export interface TurnCompletion {
  readonly turn: TurnRecord
  readonly agent: DurableAgentRecord
  readonly checkpointTaskId: string
  readonly checkpoint: Uint8Array
  readonly result: SubmissionResult
}

const isTerminal = (state: string) => ["completed", "failed", "cancelled", "outcome_unknown"].includes(state)

export class Journal {
  /**
   * Private (an ES private field, not just a TypeScript modifier): every
   * durable write goes through a named journal method. Reads use `reader`.
   */
  readonly #storage: Storage
  /** Read-only queries. A separate object with no write methods. */
  readonly reader: StorageReader
  readonly nextId: (prefix: string) => string
  readonly clock: Clock
  private readonly listeners = new Set<(event: DurableEvent) => void>()

  constructor(options: JournalOptions) {
    this.#storage = options.storage
    this.reader = readerOf(options.storage)
    this.nextId = options.nextId
    this.clock = options.clock ?? SystemClock
  }

  now(): Date {
    return new Date(this.clock.now())
  }

  transaction<A>(fn: () => A): A {
    return this.#storage.transaction(fn)
  }

  /** Close the underlying storage. */
  close(): void {
    this.#storage.close()
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
      submissionId = this.#storage.getTurn(event.turnId)?.submissionId ?? null
    }
    const persisted = this.#storage.appendEvent({
      id: this.nextId("evt"),
      agentId: event.agentId,
      submissionId,
      turnId: event.turnId ?? null,
      taskId: event.taskId ?? null,
      type: event.type,
      payload: event.payload ?? {},
      createdAt: this.now()
    })
    this.#storage.afterCommit(() => {
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
      this.#storage.insertTask(record)
      if (task.event) this.appendEvent({ ...task.event, agentId: task.agentId, turnId: task.turnId, taskId: id })
    })
    return { ...record, output: null, error: null, acknowledged: false, completedAt: null }
  }

  transitionTask(taskId: string, to: TaskState, patch: Omit<TaskPatch, "state"> = {}, event: TransitionEvent = null): TaskRecord {
    return this.transaction(() => {
      const task = this.#storage.getTask(taskId)
      if (!task) throw new NotFoundError({ entity: "task", id: taskId })
      assertTaskTransition(task.state, to)
      const completedAt = isTerminal(to) || to === "interrupted" ? this.now() : undefined
      this.#storage.updateTask(taskId, { ...patch, state: to, completedAt: patch.completedAt ?? completedAt })
      if (event) this.appendEvent({ ...event, agentId: task.agentId, turnId: task.turnId, taskId })
      return this.#storage.getTask(taskId) ?? task
    })
  }

  transitionTurn(
    turnId: string,
    to: TurnState,
    patch: { readonly attempt?: number; readonly executorId?: string | null } = {},
    event: TransitionEvent = null
  ): void {
    this.transaction(() => {
      const turn = this.#storage.getTurn(turnId)
      if (!turn) throw new NotFoundError({ entity: "turn", id: turnId })
      assertTurnTransition(turn.state, to)
      const completedAt = isTerminal(to) ? this.now() : undefined
      this.#storage.updateTurn(turnId, { ...patch, state: to, completedAt })
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
      const submission = this.#storage.getSubmission(submissionId)
      if (!submission) throw new NotFoundError({ entity: "submission", id: submissionId })
      assertSubmissionTransition(submission.state, to)
      this.#storage.updateSubmission(submissionId, { ...patch, state: to }, this.now())
      if (event) this.appendEvent({ ...event, agentId: submission.agentId, submissionId })
    })
  }

  transitionAgent(agentId: string, to: AgentState, reason: string | null = null, event: TransitionEvent = null): void {
    this.transaction(() => {
      const agent = this.#storage.getAgent(agentId)
      if (!agent) throw new NotFoundError({ entity: "agent", id: agentId })
      assertAgentTransition(agent.state, to)
      this.#storage.updateAgent(agentId, { state: to, stateReason: reason }, this.now())
      if (event) this.appendEvent({ ...event, agentId })
    })
  }

  /**
   * Write the next checkpoint. Run it inside the transaction that also
   * completes the turn, so a checkpoint never exists for an unfinished turn.
   */
  writeCheckpoint(fields: WriteCheckpoint): AgentCheckpoint {
    return this.transaction(() => {
      const previousSeq = this.#storage.latestCheckpoint(fields.agentId)?.sequence ?? null
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
      this.#storage.insertCheckpoint(checkpoint)
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
  // Steering and progress
  // -------------------------------------------------------------------------

  /**
   * Journal guidance for the agent's active turn. Returns the turn it belongs
   * to, or null when no turn is active (the caller submits it instead).
   * Journaled guidance survives a crash: the recovered attempt receives it.
   */
  recordSteering(agentId: string, text: string): { readonly turnId: string; readonly submissionId: string } | null {
    return this.transaction(() => {
      const turn = this.#storage.activeTurn(agentId)
      if (!turn) return null
      this.appendEvent({ agentId, submissionId: turn.submissionId, turnId: turn.id, type: "turn.steered", payload: { text } })
      return { turnId: turn.id, submissionId: turn.submissionId }
    })
  }

  /**
   * Store the latest streamed output of a running task (model text or tool
   * output) in its metadata, for viewers that attach mid-task. No event: this
   * is state to read, not history. Ignored once the task has settled.
   */
  recordProgress(taskId: string, progress: string): void {
    this.transaction(() => {
      const task = this.#storage.getTask(taskId)
      if (task?.state !== "running") return
      this.#storage.updateTask(taskId, { metadata: { progress } })
    })
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /** Begin a turn for a queued submission. Returns null if it is no longer runnable. */
  startTurn(submission: SubmissionRecord, executorId: string): TurnRecord | null {
    return this.transaction(() => {
      const current = this.#storage.getSubmission(submission.id)
      if (!current || current.state !== "queued" || current.cancelRequested) return null
      const checkpoint = this.#storage.latestCheckpoint(submission.agentId)
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
      this.#storage.insertTurn(turn)
      this.#storage.insertTask({
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
      for (const task of this.#storage.tasksForTurn(turnId)) {
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
    const root = this.#storage.tasksForTurn(turnId).find((t) => t.type === "turn" && t.parentTaskId === null)
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
      const current = this.#storage.getTurn(turn.id)
      if (!current || current.state !== "running") return
      this.transitionTurn(turn.id, "interrupted", { executorId: null }, {
        type: "turn.interrupted",
        payload: { reason, attempt: current.attempt }
      })
    })
  }

  // -------------------------------------------------------------------------
  // Agents and submissions
  // -------------------------------------------------------------------------

  /** Create the agent, or update its runtime/model/cwd. Stable identity: the id never changes. */
  upsertAgent(id: string, config: AgentConfig): "created" | "updated" | "unchanged" {
    return this.transaction(() => {
      const existing = this.#storage.getAgent(id)
      const at = this.now()
      if (!existing) {
        const cwd = config.cwd ?? null
        this.#storage.insertAgent({
          id,
          runtimeId: config.runtime,
          model: config.model,
          cwd,
          state: "idle",
          stateReason: null,
          createdAt: at,
          updatedAt: at
        })
        this.appendEvent({ agentId: id, type: "agent.created", payload: { runtime: config.runtime, model: config.model, cwd } })
        return "created"
      }
      const cwd = config.cwd === undefined ? existing.cwd : config.cwd
      if (existing.runtimeId === config.runtime && existing.model === config.model && existing.cwd === cwd) return "unchanged"
      this.#storage.updateAgent(id, { runtimeId: config.runtime, model: config.model, cwd }, at)
      this.appendEvent({ agentId: id, type: "agent.updated", payload: { runtime: config.runtime, model: config.model, cwd } })
      return "updated"
    })
  }

  /**
   * Create `newId` as a copy of `sourceId` at a checkpoint: same runtime,
   * model and working directory (unless overridden), and the checkpoint as its
   * first one, so it continues from that conversation. The source is not
   * touched. Returns null when `newId` already exists. Forks start at turn
   * boundaries, because libfx checkpoints only between turns.
   */
  forkAgent(sourceId: string, newId: string, spec: ForkSpec): DurableAgentRecord | null {
    return this.transaction(() => {
      const source = this.#storage.getAgent(sourceId)
      if (!source) throw new NotFoundError({ entity: "agent", id: sourceId })
      if (this.#storage.getAgent(newId)) return null

      let sequence: number | null = spec.checkpoint ?? null
      if (spec.after !== undefined) {
        const turn = this.#storage.turnForSubmission(spec.after)
        if (!turn || turn.agentId !== sourceId || turn.state !== "completed") {
          throw new NotFoundError({ entity: "completed submission", id: spec.after })
        }
        sequence = (turn.baseCheckpointSeq ?? 0) + 1
      }
      const checkpoint = sequence === null ? this.#storage.latestCheckpoint(sourceId) : this.#storage.getCheckpoint(sourceId, sequence)
      if (sequence !== null && !checkpoint) throw new NotFoundError({ entity: "checkpoint", id: `${sourceId}#${sequence}` })

      this.upsertAgent(newId, {
        runtime: spec.runtime ?? source.runtimeId,
        model: spec.model ?? source.model,
        cwd: spec.cwd === undefined ? source.cwd : spec.cwd
      })
      if (checkpoint) {
        this.#storage.insertCheckpoint({ ...checkpoint, id: this.nextId("ckpt"), agentId: newId, sequence: 1, createdAt: this.now() })
      }
      this.appendEvent({
        agentId: newId,
        type: "agent.forked",
        payload: { from: sourceId, checkpoint: checkpoint?.sequence ?? null }
      })
      return this.#storage.getAgent(newId)
    })
  }

  /** Accept a submission, or resolve to the existing one with the same `(agent, requestId)`. */
  submit(
    agentId: string,
    requestId: string | null,
    content: SubmissionContent
  ): Admission {
    return this.transaction(() => this.admit(agentId, requestId, content))
  }

  /**
   * Like `submit`, but only when the agent has nothing running or queued.
   * Returns null when it is busy, in the same transaction as the check. A
   * retried request ID still resolves to its existing submission.
   */
  submitIfIdle(
    agentId: string,
    requestId: string | null,
    content: SubmissionContent
  ): Admission | null {
    return this.transaction(() => {
      // A retried request ID resolves to its submission even while busy.
      const existing = requestId === null ? null : this.#storage.findSubmissionByRequest(agentId, requestId)
      if (existing) return { record: existing, created: false }
      if (this.#storage.activeTurn(agentId) || this.#storage.nextQueuedSubmission(agentId)) return null
      return this.admit(agentId, requestId, content)
    })
  }

  /** Insert a queued submission (or return the existing one for a retried request ID). Callers hold a transaction. */
  private admit(
    agentId: string,
    requestId: string | null,
    content: SubmissionContent
  ): Admission {
    if (requestId !== null) {
      const existing = this.#storage.findSubmissionByRequest(agentId, requestId)
      if (existing) return { record: existing, created: false }
    }
    const at = this.now()
    const record: SubmissionRecord = {
      id: this.nextId("sub"),
      agentId,
      requestId,
      content,
      state: "queued",
      result: null,
      error: null,
      cancelRequested: false,
      createdAt: at,
      updatedAt: at
    }
    this.#storage.insertSubmission(record)
    this.appendEvent({ agentId, submissionId: record.id, type: "submission.created", payload: { requestId, content } })
    return { record, created: true }
  }


  /**
   * Record a cancellation request. "Cancel requested" and "cancelled" are
   * different facts: a queued submission is cancelled outright, but a running
   * one only records the request (`submission.cancel_requested`). It becomes
   * `cancelled` when execution actually stops. In the owning process that is
   * immediate; when another process (e.g. `fxd cancel`) asks, it is at the
   * owner's next model or tool call. An unsafe tool that was in flight is
   * recorded as `outcome_unknown`, because it may still complete.
   *
   * Idempotent: a repeated request changes nothing. Returns whether this call
   * recorded a new request.
   */
  requestCancellation(submission: SubmissionRecord): boolean {
    return this.transaction(() => {
      const current = this.#storage.getSubmission(submission.id)
      if (!current || current.cancelRequested || isTerminalSubmission(current.state)) return false
      this.#storage.updateSubmission(submission.id, { cancelRequested: true }, this.now())
      if (current.state === "queued") {
        this.transitionSubmission(submission.id, "cancelled", { error: "cancelled" }, { type: "submission.cancelled" })
      } else {
        this.appendEvent({
          agentId: current.agentId,
          submissionId: current.id,
          type: "submission.cancel_requested",
          payload: { state: current.state }
        })
      }
      return true
    })
  }

  // -------------------------------------------------------------------------
  // Model calls
  // -------------------------------------------------------------------------

  /** Commit the intent of a model request. Refuses once cancellation was requested. */
  modelStarted(call: ModelCall): string {
    if (this.#storage.getSubmission(call.submissionId)?.cancelRequested) {
      throw new InterruptedError({ message: "model request refused: submission cancellation requested" })
    }
    return this.startTask({
      turnId: call.turnId,
      agentId: call.agentId,
      type: "model",
      name: call.model,
      attempt: call.attempt,
      replayPolicy: "safe",
      event: { type: "model.started", submissionId: call.submissionId, payload: { model: call.model } }
    }).id
  }

  modelCompleted(call: ModelCall, taskId: string, summary: ModelSummary): void {
    this.transitionTask(
      taskId,
      "completed",
      {
        output: { text: summary.text, toolCalls: summary.toolCalls, finishReason: summary.finishReason },
        metadata: { durationMs: summary.durationMs, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens }
      },
      {
        type: "model.completed",
        submissionId: call.submissionId,
        payload: {
          model: call.model,
          durationMs: summary.durationMs,
          text: summary.text,
          toolCalls: summary.toolCalls,
          finishReason: summary.finishReason,
          usage: { inputTokens: summary.inputTokens, outputTokens: summary.outputTokens }
        }
      }
    )
  }

  /** Record a failed model request (no-op if the task already settled). */
  modelFailed(call: ModelCall, taskId: string, error: string): void {
    this.transaction(() => {
      const task = this.#storage.getTask(taskId)
      if (!task || task.state !== "running") return
      this.transitionTask(taskId, "failed", { error }, {
        type: "model.failed",
        submissionId: call.submissionId,
        payload: { model: call.model, error }
      })
    })
  }

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  /** The first repeat of an outcome-unknown call is refused; record that it was. */
  refuseUnknownOutcomeRepeat(task: TaskRecord, submissionId: string, input: Json): void {
    this.transaction(() => {
      this.#storage.updateTask(task.id, { acknowledged: true })
      this.appendEvent({
        agentId: task.agentId,
        submissionId,
        turnId: task.turnId,
        taskId: task.id,
        type: "tool.outcome_unknown_refused",
        payload: { tool: task.name, input }
      })
    })
  }

  // -------------------------------------------------------------------------
  // Turn completion and parking
  // -------------------------------------------------------------------------

  /**
   * Complete a turn: write the checkpoint and mark the checkpoint task, turn,
   * and submission completed in ONE transaction, so a checkpoint never exists
   * for an unfinished turn. `beforeCommit` runs inside the transaction (used
   * for crash injection).
   */
  completeTurn(completion: TurnCompletion, beforeCommit?: () => void): AgentCheckpoint {
    const { turn, agent, result } = completion
    return this.transaction(() => {
      const checkpoint = this.writeCheckpoint({
        agentId: agent.id,
        turnId: turn.id,
        submissionId: turn.submissionId,
        taskId: completion.checkpointTaskId,
        runtimeId: agent.runtimeId,
        model: agent.model,
        data: completion.checkpoint,
        expectedPrevious: turn.baseCheckpointSeq
      })
      beforeCommit?.()
      this.transitionTask(completion.checkpointTaskId, "completed", { output: { sequence: checkpoint.sequence } })
      this.closeTurnTask(turn.id, "completed")
      this.transitionTurn(turn.id, "completed", {}, {
        type: "turn.completed",
        payload: { attempt: turn.attempt, stopReason: result.stopReason, usage: result.usage }
      })
      this.transitionSubmission(turn.submissionId, "completed", { result }, {
        type: "submission.completed",
        turnId: turn.id,
        payload: { text: result.text, stopReason: result.stopReason, usage: result.usage }
      })
      return checkpoint
    })
  }

  /** The agent's runtime is not registered: park the turn without discarding work. */
  parkTurn(turn: TurnRecord, runtimeId: string, message: string): void {
    this.transaction(() => {
      this.interruptTurn(turn, "runtime unavailable")
      this.transitionAgent(turn.agentId, "configuration_error", message, {
        type: "agent.configuration_error",
        payload: { runtimeId, error: message }
      })
    })
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /** Step 1 of recovering a turn: the agent is recovering, the turn interrupted. */
  beginRecovery(turn: TurnRecord, reason: UnknownOutcomeReason): void {
    this.transaction(() => {
      this.transitionAgent(turn.agentId, "recovering", null, {
        type: "recovery.started",
        turnId: turn.id,
        submissionId: turn.submissionId,
        payload: { attempt: turn.attempt, previousExecutor: turn.executorId }
      })
      if (turn.state === "running") {
        this.transitionTurn(turn.id, "interrupted", { executorId: null }, {
          type: "turn.interrupted",
          payload: { reason, attempt: turn.attempt }
        })
      }
    })
  }

  /** Recovery cannot proceed because the agent's runtime is not registered. */
  recoveryParked(turn: TurnRecord, runtimeId: string): void {
    this.transitionAgent(turn.agentId, "configuration_error", `runtime "${runtimeId}" is not registered; turn parked until it is`, {
      type: "recovery.failed",
      turnId: turn.id,
      submissionId: turn.submissionId,
      payload: { reason: "runtime_unavailable", runtimeId }
    })
  }

  /** Stop retrying a turn that keeps crashing: fail it and ask for input. */
  abandonRecovery(turn: TurnRecord, reason: UnknownOutcomeReason): void {
    this.transaction(() => {
      const message = `turn interrupted ${turn.attempt} times; giving up automatic recovery`
      this.classifyTurnTasks(turn.id, reason)
      this.closeTurnTask(turn.id, "failed", message)
      this.transitionTurn(turn.id, "failed", {}, { type: "turn.failed", payload: { error: message } })
      this.transitionSubmission(turn.submissionId, "failed", { error: message }, {
        type: "submission.failed",
        turnId: turn.id,
        payload: { error: message, reason: "max_recovery_attempts" }
      })
      this.transitionAgent(turn.agentId, "needs_input", message, {
        type: "agent.needs_input",
        turnId: turn.id,
        payload: { reason: message }
      })
      this.appendEvent({
        agentId: turn.agentId,
        turnId: turn.id,
        submissionId: turn.submissionId,
        type: "recovery.failed",
        payload: { reason: "max_attempts", attempts: turn.attempt }
      })
    })
  }

  /** Final recovery step: hand the turn to an executor for its next attempt. */
  resumeTurn(turn: TurnRecord, executorId: string, replayed: ReadonlyArray<string>, unknown: ReadonlyArray<string>): void {
    this.transaction(() => {
      this.transitionTurn(
        turn.id,
        "running",
        { attempt: turn.attempt + 1, executorId },
        { type: "turn.recovered", payload: { attempt: turn.attempt + 1, replayed, unknownOutcomes: unknown } }
      )
      this.transitionAgent(turn.agentId, "running", null, {
        type: "recovery.completed",
        turnId: turn.id,
        submissionId: turn.submissionId,
        payload: { attempt: turn.attempt + 1, replayed: replayed.length, unknownOutcomes: unknown.length }
      })
    })
  }

  /** Unfinished tasks outside any active turn (should not exist) are made explicit. */
  settleOrphanedTasks(): ReadonlyArray<string> {
    return this.transaction(() => {
      const unknown: Array<string> = []
      for (const task of this.#storage.unfinishedTasks()) {
        const turn = this.#storage.getTurn(task.turnId)
        if (!turn || turn.state === "running" || turn.state === "interrupted") continue
        if (task.type === "tool" && task.replayPolicy !== "safe") {
          this.markOutcomeUnknown(task, "process_terminated")
          unknown.push(task.id)
        } else {
          this.transitionTask(task.id, "interrupted", { error: "orphaned" })
        }
      }
      return unknown
    })
  }

  /** An agent left `running`/`recovering` with no active turn goes back to idle. */
  idleIfStranded(agentId: string): void {
    this.transaction(() => {
      const agent = this.#storage.getAgent(agentId)
      if (!agent || this.#storage.activeTurn(agentId)) return
      if (agent.state === "running" || agent.state === "recovering") {
        this.transitionAgent(agentId, "idle", null, { type: "agent.idle" })
      }
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
    for (const turn of this.#storage.unfinishedTurns()) {
      const record = turn.executorId ? this.#storage.getExecutor(turn.executorId) : null
      if (turn.executorId !== null && !executorGone(record, at, null)) continue
      const reason = lostReason(record)
      const unknown = this.transaction(() => {
        const agent = this.#storage.getAgent(turn.agentId)
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
