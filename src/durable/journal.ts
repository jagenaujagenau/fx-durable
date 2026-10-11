import { InvalidTransitionError, NotFoundError, StorageError } from "../domain/errors.js"
import { SystemClock, type Clock } from "./clock.js"
import type { Json, JsonObject } from "../domain/json.js"
import { applyUpdate, DocumentUpdateFailed, documentValue, type DocumentUpdate, type DurableDocument } from "../domain/documents.js"
import type {
  DocumentRecord,
  DurableAgentRecord,
  SubmissionContent,
  SubmissionRecord,
  SubmissionResult,
  ToolCallRecord,
  ToolCallState
} from "../domain/schema.js"
import { readerOf, type Storage, type StorageReader, type ToolCallKey } from "./storage.js"

/**
 * The durable journal: every state transition fx-durable makes, as plain
 * synchronous code on top of `Storage`. No Effect runtime is involved.
 *
 * Each mutating method is a named transition: it checks the change is
 * allowed (an invalid one throws `InvalidTransitionError`, a programmer
 * error) and persists it. Calls compose: wrap several in
 * `journal.transaction(() => …)` and they commit together.
 */

export interface JournalOptions {
  readonly storage: Storage
  readonly clock?: Clock
}

export interface AgentConfig {
  readonly runtime: string
  readonly model: string
  readonly cwd?: string | null
}

export interface ForkSpec {
  readonly runtime?: string
  readonly model?: string
  readonly cwd?: string | null
}

export interface NewSubmission {
  readonly agentId: string
  readonly id: string
  readonly requestId: string | null
  readonly sessionId: string
  readonly sessionStore: string
  readonly model: string
  readonly content: SubmissionContent
}

export interface Admission {
  readonly record: SubmissionRecord
  /** False when an earlier submission had the same id. */
  readonly created: boolean
}

export interface NewToolCall extends ToolCallKey {
  readonly agentId: string
  readonly submissionId: string | null
  readonly name: string
  readonly input: Json
  readonly replayPolicy: ToolCallRecord["replayPolicy"]
  readonly idempotencyKey: string | null
}

/** A document change staged by a tool call, applied with its result. */
export interface StagedDocumentWrite {
  readonly document: DurableDocument<JsonObject>
  readonly agentId: string | null
  readonly updates: ReadonlyArray<DocumentUpdate<JsonObject>>
}

/** What the journal tells listeners after a commit. */
export type CommittedChange =
  | { readonly type: "document.updated"; readonly agentId: string | null; readonly kind: string; readonly revision: number }
  | { readonly type: "submission.finished"; readonly agentId: string; readonly id: string }

const TOOL_CALL_TRANSITIONS = {
  // A call that runs again after a crash stays running (its attempts grow).
  running: ["running", "completed", "failed", "outcome_unknown"],
  completed: [],
  failed: [],
  outcome_unknown: []
} satisfies { readonly [S in ToolCallState]: ReadonlyArray<ToolCallState> }

const isUniqueConflict = (error: StorageError) => /UNIQUE|already exists/i.test(error.message)

export class Journal {
  /**
   * Private (an ES private field, not just a TypeScript modifier): every
   * durable write goes through a named journal method. Reads use `reader`.
   */
  readonly #storage: Storage
  /** Read-only queries. A separate object with no write methods. */
  readonly reader: StorageReader
  readonly clock: Clock
  private readonly listeners = new Set<(change: CommittedChange) => void>()

  constructor(options: JournalOptions) {
    this.#storage = options.storage
    this.reader = readerOf(options.storage)
    this.clock = options.clock ?? SystemClock
  }

  now(): Date {
    return new Date(this.clock.now())
  }

  transaction<A>(fn: () => A): A {
    return this.#storage.transaction(fn)
  }

  close(): void {
    this.#storage.close()
  }

  /** Listen for changes after their transaction commits. Returns an unsubscribe function. */
  onCommitted(listener: (change: CommittedChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(change: CommittedChange): void {
    this.#storage.afterCommit(() => {
      for (const listener of this.listeners) listener(change)
    })
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  /** Create the agent, or update the configuration of an existing one. */
  upsertAgent(id: string, config: AgentConfig): DurableAgentRecord {
    return this.transaction(() => {
      const now = this.now()
      const existing = this.#storage.getAgent(id)
      if (!existing) {
        this.#storage.insertAgent({
          id,
          runtimeId: config.runtime,
          model: config.model,
          cwd: config.cwd ?? null,
          sessionId: null,
          sessionStore: null,
          summary: null,
          startCheckpoint: null,
          createdAt: now,
          updatedAt: now
        })
      } else {
        this.#storage.updateAgent(id, {
          runtimeId: config.runtime,
          model: config.model,
          cwd: config.cwd === undefined ? existing.cwd : config.cwd,
          updatedAt: now
        })
      }
      return this.requireAgent(id)
    })
  }

  /** The agent's requests go to this libfx session (in this store) from now on. A start checkpoint is used up. */
  setSession(agentId: string, sessionId: string, store: string): void {
    this.transaction(() => {
      this.requireAgent(agentId)
      this.#storage.updateAgent(agentId, { sessionId, sessionStore: store, startCheckpoint: null, updatedAt: this.now() })
    })
  }

  /**
   * The agent's tools changed, so its session moves to another store: its
   * next request starts a session there from `checkpoint`, the conversation
   * so far.
   */
  moveSession(agentId: string, checkpoint: Uint8Array): void {
    this.transaction(() => {
      this.requireAgent(agentId)
      this.#storage.updateAgent(agentId, { sessionId: null, sessionStore: null, startCheckpoint: checkpoint, updatedAt: this.now() })
    })
  }

  /**
   * Start a new context: the next request opens a new libfx session. With a
   * summary (a handoff), the model sees it in its instructions until the
   * next reset.
   */
  resetContext(agentId: string, summary: string | null): void {
    this.transaction(() => {
      this.requireAgent(agentId)
      this.#storage.updateAgent(agentId, { sessionId: null, sessionStore: null, summary, startCheckpoint: null, updatedAt: this.now() })
    })
  }

  /**
   * A new agent that starts from `checkpoint` (the source's conversation)
   * with the source's configuration unless overridden, and its documents as
   * their fork policies say. Null when `newId` is taken.
   */
  forkAgent(sourceId: string, newId: string, checkpoint: Uint8Array | null, spec: ForkSpec): DurableAgentRecord | null {
    return this.transaction(() => {
      const source = this.requireAgent(sourceId)
      if (this.#storage.getAgent(newId)) return null
      const now = this.now()
      this.#storage.insertAgent({
        id: newId,
        runtimeId: spec.runtime ?? source.runtimeId,
        model: spec.model ?? source.model,
        cwd: spec.cwd === undefined ? source.cwd : spec.cwd,
        sessionId: null,
        sessionStore: null,
        summary: source.summary,
        startCheckpoint: checkpoint,
        createdAt: now,
        updatedAt: now
      })
      for (const document of this.#storage.agentDocuments(sourceId)) {
        if (document.fork === "copy") this.#storage.putDocument({ ...document, agentId: newId, revision: 1, updatedAt: now })
      }
      return this.requireAgent(newId)
    })
  }

  private requireAgent(id: string): DurableAgentRecord {
    const agent = this.#storage.getAgent(id)
    if (!agent) throw new NotFoundError({ entity: "agent", id })
    return agent
  }

  // -------------------------------------------------------------------------
  // Submissions
  // -------------------------------------------------------------------------

  /**
   * Record a request, or resolve to the one with the same id. Recorded
   * before libfx accepts it, so a crash in between leaves a running
   * submission that `resume()` sends again under the same id.
   */
  admitSubmission(submission: NewSubmission): Admission {
    const existing = this.#storage.getSubmission(submission.agentId, submission.id)
    if (existing) return { record: existing, created: false }
    try {
      return this.transaction(() => {
        this.requireAgent(submission.agentId)
        const now = this.now()
        const record: SubmissionRecord = {
          ...submission,
          state: "running",
          result: null,
          error: null,
          createdAt: now,
          updatedAt: now
        }
        this.#storage.insertSubmission(record)
        return { record, created: true }
      })
    } catch (cause: unknown) {
      // Another process recorded the same id first.
      const raced = cause instanceof StorageError && isUniqueConflict(cause) ? this.#storage.getSubmission(submission.agentId, submission.id) : null
      if (raced) return { record: raced, created: false }
      throw cause
    }
  }

  /**
   * The first request of a session started from a checkpoint: libfx chose
   * the session when it accepted the prompt. The agent and the request are
   * in that session from now on.
   */
  assignSession(agentId: string, submissionId: string, sessionId: string, store: string): void {
    this.transaction(() => {
      this.setSession(agentId, sessionId, store)
      this.#storage.updateSubmission(agentId, submissionId, { sessionId, updatedAt: this.now() })
    })
  }

  /**
   * The turn ended. Only a running submission changes; a repeat report is
   * ignored. Tool calls of the turn still marked running are recorded as
   * outcome_unknown.
   */
  finishSubmission(
    agentId: string,
    id: string,
    outcome: { readonly state: "completed" | "failed" | "cancelled"; readonly result: SubmissionResult | null; readonly error: string | null }
  ): SubmissionRecord {
    return this.transaction(() => {
      const current = this.#storage.getSubmission(agentId, id)
      if (!current) throw new NotFoundError({ entity: "submission", id })
      if (current.state !== "running") return current
      // Calls the turn left running (cut off by a crash, and not run again) may have had effects.
      for (const call of this.#storage.runningToolCalls()) {
        if (call.agentId !== agentId || call.submissionId !== id) continue
        this.#storage.updateToolCall(call, { state: "outcome_unknown", error: "outcome unknown: the turn ended without it", completedAt: this.now() })
      }
      this.#storage.updateSubmission(agentId, id, { ...outcome, updatedAt: this.now() })
      this.notify({ type: "submission.finished", agentId, id })
      return this.#storage.getSubmission(agentId, id) ?? current
    })
  }

  // -------------------------------------------------------------------------
  // Tool calls
  // -------------------------------------------------------------------------

  /** Intent precedes effect: the call is recorded as running before it starts. */
  startToolCall(call: NewToolCall): ToolCallRecord {
    return this.transaction(() => {
      const record: ToolCallRecord = {
        ...call,
        state: "running",
        output: null,
        error: null,
        attempts: 1,
        progress: null,
        startedAt: this.now(),
        completedAt: null
      }
      this.#storage.insertToolCall(record)
      return record
    })
  }

  /** A call libfx runs again after a crash (same `executionId`). */
  restartToolCall(key: ToolCallKey): ToolCallRecord {
    return this.transaction(() => {
      const current = this.transitionToolCall(key, "running")
      this.#storage.updateToolCall(key, { attempts: current.attempts + 1, progress: null })
      return { ...current, attempts: current.attempts + 1, progress: null }
    })
  }

  /**
   * The call returned. Its result and its staged document writes commit in
   * one transaction, so they happen together or not at all. An update that
   * throws aborts it with `DocumentUpdateFailed`.
   */
  completeToolCall(key: ToolCallKey, output: Json, writes: ReadonlyArray<StagedDocumentWrite> = []): void {
    this.transaction(() => {
      for (const write of writes) this.updateDocument(write.document, write.agentId, write.updates)
      this.transitionToolCall(key, "completed")
      this.#storage.updateToolCall(key, { state: "completed", output, completedAt: this.now() })
    })
  }

  failToolCall(key: ToolCallKey, error: string): void {
    this.transaction(() => {
      this.transitionToolCall(key, "failed")
      this.#storage.updateToolCall(key, { state: "failed", error, completedAt: this.now() })
    })
  }

  /** The call may have run; nothing can tell. It is never run again automatically. */
  markToolCallUnknown(key: ToolCallKey, reason: string): void {
    this.transaction(() => {
      this.transitionToolCall(key, "outcome_unknown")
      this.#storage.updateToolCall(key, { state: "outcome_unknown", error: `outcome unknown: ${reason}`, completedAt: this.now() })
    })
  }

  /** Output a running call reported so far. Ignored once it settled. */
  recordProgress(key: ToolCallKey, progress: string): void {
    this.transaction(() => {
      if (this.#storage.getToolCall(key)?.state === "running") this.#storage.updateToolCall(key, { progress })
    })
  }

  private transitionToolCall(key: ToolCallKey, to: ToolCallState): ToolCallRecord {
    const current = this.#storage.getToolCall(key)
    if (!current) throw new NotFoundError({ entity: "tool call", id: `${key.sessionId}/${key.executionId}/${key.callKey}` })
    const allowed: ReadonlyArray<ToolCallState> = TOOL_CALL_TRANSITIONS[current.state]
    if (!allowed.includes(to)) {
      throw new InvalidTransitionError({ entity: "tool call", from: current.state, to })
    }
    return current
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /**
   * Apply updates to a document's committed value and store the result. An
   * update that throws aborts the enclosing transaction with
   * `DocumentUpdateFailed`.
   */
  updateDocument<T extends JsonObject>(document: DurableDocument<T>, agentId: string | null, updates: ReadonlyArray<DocumentUpdate<T>>): DocumentRecord {
    return this.transaction(() => {
      if (agentId !== null) this.requireAgent(agentId)
      const current = this.#storage.getDocument(agentId, document.kind)
      let value: T
      try {
        value = documentValue(document, current)
        for (const update of updates) value = applyUpdate(document, value, update)
      } catch (cause) {
        throw new DocumentUpdateFailed(document.kind, cause)
      }
      const record: DocumentRecord = {
        agentId,
        kind: document.kind,
        version: document.version,
        revision: (current?.revision ?? 0) + 1,
        value,
        fork: document.fork,
        updatedAt: this.now()
      }
      this.#storage.putDocument(record)
      this.notify({ type: "document.updated", agentId, kind: document.kind, revision: record.revision })
      return record
    })
  }
}
