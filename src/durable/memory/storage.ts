import { StorageError } from "../../domain/errors.js"
import type { DocumentRecord, DurableAgentRecord, SubmissionRecord, ToolCallRecord } from "../../domain/schema.js"
import type { Storage, ToolCallKey } from "../storage.js"

/**
 * Storage that keeps everything in process memory: for tests, examples, and
 * short-lived agents that need no durability. It keeps every rule of the
 * storage contract except that nothing survives the process.
 *
 * Maps keep insertion order, which stands in for SQLite's rowid order.
 */

interface State {
  readonly agents: Map<string, DurableAgentRecord>
  readonly submissions: Map<string, SubmissionRecord>
  readonly toolCalls: Map<string, ToolCallRecord>
  readonly documents: Map<string, DocumentRecord>
}

const emptyState = (): State => ({ agents: new Map(), submissions: new Map(), toolCalls: new Map(), documents: new Map() })

const copy = <A>(value: A): A => structuredClone(value)

const key = (...parts: ReadonlyArray<string | null>) => JSON.stringify(parts)
const callKeyOf = (k: ToolCallKey) => key(k.sessionId, k.executionId, k.callKey)

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const createdMs = (s: SubmissionRecord) => s.createdAt.getTime()

/** Drop the keys of a sparse patch whose value is `undefined`. */
const defined = <P extends object>(patch: P): Partial<P> =>
  // SAFETY: the entries come from `patch` itself; filtering only removes keys, so the result is a Partial<P>.
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<P>

export const openMemoryStorage = (): Storage => {
  let state = emptyState()
  let open = true
  let depth = 0
  let hooks: Array<() => void> = []

  const op = <A>(operation: string, f: () => A): A => {
    if (!open) throw new StorageError({ operation, message: "storage is closed" })
    return f()
  }

  const conflict = (operation: string, message: string) => new StorageError({ operation, message: `UNIQUE constraint failed: ${message}` })

  const transaction = <A>(fn: () => A): A => {
    if (depth > 0) return fn()
    const before = copy(state)
    depth = 1
    hooks = []
    let result: A
    try {
      result = fn()
      if (result instanceof Promise) throw new TypeError("transaction bodies must be synchronous; got a Promise")
    } catch (error) {
      state = before
      throw error
    } finally {
      depth = 0
    }
    const committed = hooks
    hooks = []
    for (const hook of committed) hook()
    return result
  }

  const afterCommit = (fn: () => void): void => {
    if (depth > 0) hooks.push(fn)
    else fn()
  }

  const get = <A>(map: Map<string, A>, id: string): A | null => {
    const value = map.get(id)
    return value === undefined ? null : copy(value)
  }

  const patch = <A extends object>(map: Map<string, A>, id: string, changes: Partial<A>) => {
    const current = map.get(id)
    if (current) map.set(id, { ...current, ...copy(changes) })
  }

  const storage: Storage = {
    transaction,
    afterCommit,

    getAgent: (id) => op("getAgent", () => get(state.agents, id)),
    listAgents: () => op("listAgents", () => [...state.agents.values()].sort((a, b) => byString(a.id, b.id)).map(copy)),
    insertAgent: (agent) =>
      op("insertAgent", () => {
        if (state.agents.has(agent.id)) throw conflict("insertAgent", "agents.id")
        state.agents.set(agent.id, copy(agent))
      }),
    updateAgent: (id, changes) => op("updateAgent", () => patch(state.agents, id, defined(changes))),

    getSubmission: (agentId, id) => op("getSubmission", () => get(state.submissions, key(agentId, id))),
    insertSubmission: (submission) =>
      op("insertSubmission", () => {
        const k = key(submission.agentId, submission.id)
        if (state.submissions.has(k)) throw conflict("insertSubmission", "submissions.agent_id, submissions.id")
        state.submissions.set(k, copy(submission))
      }),
    updateSubmission: (agentId, id, changes) => op("updateSubmission", () => patch(state.submissions, key(agentId, id), defined(changes))),
    listSubmissions: (agentId, limit) =>
      op("listSubmissions", () =>
        [...state.submissions.values()]
          .filter((s) => s.agentId === agentId)
          .reverse()
          .sort((a, b) => createdMs(b) - createdMs(a))
          .slice(0, limit)
          .map(copy)
      ),
    runningSubmissions: () =>
      op("runningSubmissions", () =>
        [...state.submissions.values()].filter((s) => s.state === "running").sort((a, b) => createdMs(a) - createdMs(b)).map(copy)
      ),
    finishedSubmissions: (agentId) =>
      op("finishedSubmissions", () =>
        [...state.submissions.values()]
          .filter((s) => s.result !== null && (agentId === null || s.agentId === agentId))
          .sort((a, b) => createdMs(a) - createdMs(b))
          .map(copy)
      ),

    getToolCall: (k) => op("getToolCall", () => get(state.toolCalls, callKeyOf(k))),
    insertToolCall: (call) =>
      op("insertToolCall", () => {
        const k = callKeyOf(call)
        if (state.toolCalls.has(k)) throw conflict("insertToolCall", "tool_calls.session_id, execution_id, call_key")
        state.toolCalls.set(k, copy(call))
      }),
    updateToolCall: (k, changes) => op("updateToolCall", () => patch(state.toolCalls, callKeyOf(k), defined(changes))),
    runningToolCalls: () =>
      op("runningToolCalls", () =>
        [...state.toolCalls.values()].filter((c) => c.state === "running").sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).map(copy)
      ),
    toolCallsOf: (sessionId, executionId) =>
      op("toolCallsOf", () => [...state.toolCalls.values()].filter((c) => c.sessionId === sessionId && c.executionId === executionId).map(copy)),

    getDocument: (agentId, kind) => op("getDocument", () => get(state.documents, key(agentId, kind))),
    putDocument: (document) =>
      op("putDocument", () => {
        state.documents.set(key(document.agentId, document.kind), copy(document))
      }),
    agentDocuments: (agentId) =>
      op("agentDocuments", () =>
        [...state.documents.values()]
          .filter((d) => d.agentId === agentId)
          .sort((a, b) => byString(a.kind, b.kind))
          .map(copy)
      ),

    close: () => {
      open = false
      state = emptyState()
    }
  }
  return storage
}
