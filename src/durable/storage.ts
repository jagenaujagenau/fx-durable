import type { Json } from "../domain/json.js"
import type {
  DocumentRecord,
  DurableAgentRecord,
  SubmissionRecord,
  SubmissionResult,
  SubmissionState,
  ToolCallRecord,
  ToolCallState
} from "../domain/schema.js"

/**
 * The narrow persistence boundary: plain synchronous code, no Effect runtime.
 * Storage is deliberately dumb: the Journal defines meaning, Storage provides
 * atomic persistence. SQLite and memory are built in.
 *
 * libfx stores the conversations themselves (in its own session store); this
 * holds fx-durable's records around them.
 *
 * Every method is synchronous and throws `StorageError` on failure.
 *
 * ## Durability contract
 *
 * fx-durable's guarantees hold only if an implementation keeps all of these
 * (`storageContract` in `fx-durable/testing` checks them):
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
 * 9. Constraints hold: one agent per id, one submission per `(agentId, id)`,
 *    one tool call per `(sessionId, executionId, callKey)`, and one document
 *    per `(agentId, kind)`.
 */

export interface AgentPatch {
  readonly sessionId?: string | null
  readonly sessionStore?: string | null
  readonly summary?: string | null
  readonly startCheckpoint?: Uint8Array | null
  readonly model?: string
  readonly runtimeId?: string
  readonly cwd?: string | null
  readonly updatedAt: Date
}

export interface SubmissionPatch {
  readonly state?: SubmissionState
  readonly sessionId?: string
  readonly result?: SubmissionResult | null
  readonly error?: string | null
  readonly updatedAt: Date
}

export interface ToolCallKey {
  readonly sessionId: string
  readonly executionId: string
  readonly callKey: string
}

export interface ToolCallPatch {
  readonly state?: ToolCallState
  readonly output?: Json
  readonly error?: string | null
  readonly attempts?: number
  readonly progress?: string | null
  readonly completedAt?: Date | null
}

export interface Storage {
  readonly transaction: <A>(fn: () => A) => A
  /** Run `fn` after the current transaction commits (immediately when outside one). */
  readonly afterCommit: (fn: () => void) => void

  // agents
  readonly getAgent: (id: string) => DurableAgentRecord | null
  readonly listAgents: () => ReadonlyArray<DurableAgentRecord>
  readonly insertAgent: (agent: DurableAgentRecord) => void
  readonly updateAgent: (id: string, patch: AgentPatch) => void

  // submissions
  readonly getSubmission: (agentId: string, id: string) => SubmissionRecord | null
  readonly insertSubmission: (submission: SubmissionRecord) => void
  readonly updateSubmission: (agentId: string, id: string, patch: SubmissionPatch) => void
  /** An agent's latest submissions, newest first. */
  readonly listSubmissions: (agentId: string, limit: number) => ReadonlyArray<SubmissionRecord>
  /** Every submission still running, oldest first, across agents. */
  readonly runningSubmissions: () => ReadonlyArray<SubmissionRecord>
  /** Every finished submission with a result, across agents (for usage totals). */
  readonly finishedSubmissions: (agentId: string | null) => ReadonlyArray<SubmissionRecord>

  // tool calls
  readonly getToolCall: (key: ToolCallKey) => ToolCallRecord | null
  readonly insertToolCall: (call: ToolCallRecord) => void
  readonly updateToolCall: (key: ToolCallKey, patch: ToolCallPatch) => void
  /** Tool calls still running, oldest first, across agents. */
  readonly runningToolCalls: () => ReadonlyArray<ToolCallRecord>
  /** The nested calls under one model call, in the order they started. */
  readonly toolCallsOf: (sessionId: string, executionId: string) => ReadonlyArray<ToolCallRecord>

  // documents
  /** The current value of a document (`agentId` null: a global one). */
  readonly getDocument: (agentId: string | null, kind: string) => DocumentRecord | null
  /** Insert or replace the document at `(agentId, kind)`. */
  readonly putDocument: (document: DocumentRecord) => void
  /** An agent's documents, by kind. */
  readonly agentDocuments: (agentId: string) => ReadonlyArray<DocumentRecord>

  readonly close: () => void
}

/** The read-only view of storage handed to runtime code through `Database.read`. */
export type StorageReader = Pick<
  Storage,
  | "getAgent"
  | "listAgents"
  | "getSubmission"
  | "listSubmissions"
  | "runningSubmissions"
  | "finishedSubmissions"
  | "getToolCall"
  | "runningToolCalls"
  | "toolCallsOf"
  | "getDocument"
  | "agentDocuments"
>

/**
 * A read-only view of `storage`: a separate object that has only the read
 * methods, so it cannot be cast back into something that writes.
 */
export const readerOf = (storage: Storage): StorageReader => ({
  getAgent: (id) => storage.getAgent(id),
  listAgents: () => storage.listAgents(),
  getSubmission: (agentId, id) => storage.getSubmission(agentId, id),
  listSubmissions: (agentId, limit) => storage.listSubmissions(agentId, limit),
  runningSubmissions: () => storage.runningSubmissions(),
  finishedSubmissions: (agentId) => storage.finishedSubmissions(agentId),
  getToolCall: (key) => storage.getToolCall(key),
  runningToolCalls: () => storage.runningToolCalls(),
  toolCallsOf: (sessionId, executionId) => storage.toolCallsOf(sessionId, executionId),
  getDocument: (agentId, kind) => storage.getDocument(agentId, kind),
  agentDocuments: (agentId) => storage.agentDocuments(agentId)
})
