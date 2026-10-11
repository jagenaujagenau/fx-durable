import { StorageError } from "../../domain/errors.js"
import type {
  AgentCheckpoint,
  DurableAgentRecord,
  DurableEvent,
  SubmissionRecord,
  TaskRecord,
  TurnRecord
} from "../../domain/schema.js"
import type { ExecutorRecord, Storage } from "../storage.js"

/**
 * Storage that keeps everything in process memory: nothing survives the
 * process, so it gives none of the crash guarantees (contract item 8). For
 * tests, short-lived agents, and as a reference for custom backends; it passes
 * every other check of `storageContract`.
 *
 * Maps keep insertion order, which stands in for SQLite's rowid. Records are
 * copied in and out, so callers never share an object with the store.
 */

interface State {
  readonly agents: Map<string, DurableAgentRecord>
  readonly submissions: Map<string, SubmissionRecord>
  readonly turns: Map<string, TurnRecord>
  readonly tasks: Map<string, TaskRecord>
  readonly checkpoints: Map<string, AgentCheckpoint>
  readonly events: Map<string, Array<DurableEvent>>
  readonly executors: Map<string, ExecutorRecord>
}

const emptyState = (): State => ({
  agents: new Map(),
  submissions: new Map(),
  turns: new Map(),
  tasks: new Map(),
  checkpoints: new Map(),
  events: new Map(),
  executors: new Map()
})

const copy = <A>(value: A): A => structuredClone(value)

const ACTIVE_TURN = new Set<TurnRecord["state"]>(["running", "interrupted"])
const UNFINISHED_TASK = new Set<TaskRecord["state"]>(["pending", "running"])
const SETTLED_TURN = new Set<TurnRecord["state"]>(["completed", "failed", "cancelled"])

const byCreated = (a: { createdAt: Date }, b: { createdAt: Date }) => a.createdAt.getTime() - b.createdAt.getTime()

/** SQLite sorts NULL below every value. */
const startedMs = (turn: TurnRecord) => turn.startedAt?.getTime() ?? Number.NEGATIVE_INFINITY

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
    if (current) map.set(id, { ...current, ...changes })
  }

  const checkpointKey = (agentId: string, sequence: number) => `${agentId}\u0000${sequence}`

  const storage: Storage = {
    transaction,
    afterCommit,

    getAgent: (id) => op("getAgent", () => get(state.agents, id)),
    listAgents: () => op("listAgents", () => [...state.agents.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copy)),
    insertAgent: (agent) =>
      op("insertAgent", () => {
        if (state.agents.has(agent.id)) throw conflict("insertAgent", "agents.id")
        state.agents.set(agent.id, copy(agent))
      }),
    updateAgent: (id, changes, now) => op("updateAgent", () => patch(state.agents, id, { ...defined(changes), updatedAt: now })),

    getSubmission: (id) => op("getSubmission", () => get(state.submissions, id)),
    findSubmissionByRequest: (agentId, requestId) =>
      op("findSubmissionByRequest", () => {
        for (const s of state.submissions.values()) if (s.agentId === agentId && s.requestId === requestId) return copy(s)
        return null
      }),
    nextQueuedSubmission: (agentId) =>
      op("nextQueuedSubmission", () => {
        const queued = [...state.submissions.values()].filter((s) => s.agentId === agentId && s.state === "queued")
        const next = queued.sort(byCreated)[0]
        return next ? copy(next) : null
      }),
    listSubmissions: (agentId, limit) =>
      op("listSubmissions", () =>
        [...state.submissions.values()]
          .filter((s) => s.agentId === agentId)
          .reverse()
          .sort((a, b) => byCreated(b, a))
          .slice(0, limit)
          .map(copy)
      ),
    insertSubmission: (submission) =>
      op("insertSubmission", () => {
        if (state.submissions.has(submission.id)) throw conflict("insertSubmission", "submissions.id")
        if (
          submission.requestId !== null &&
          [...state.submissions.values()].some((s) => s.agentId === submission.agentId && s.requestId === submission.requestId)
        ) {
          throw conflict("insertSubmission", "submissions.agent_id, submissions.request_id")
        }
        state.submissions.set(submission.id, copy(submission))
      }),
    updateSubmission: (id, changes, now) =>
      op("updateSubmission", () => patch(state.submissions, id, { ...defined(changes), updatedAt: now })),

    getTurn: (id) => op("getTurn", () => get(state.turns, id)),
    activeTurn: (agentId) =>
      op("activeTurn", () => {
        for (const t of state.turns.values()) if (t.agentId === agentId && ACTIVE_TURN.has(t.state)) return copy(t)
        return null
      }),
    unfinishedTurns: () =>
      op("unfinishedTurns", () =>
        [...state.turns.values()]
          .filter((t) => ACTIVE_TURN.has(t.state))
          .sort((a, b) => startedMs(a) - startedMs(b))
          .map(copy)
      ),
    listTurns: (agentId, limit) =>
      op("listTurns", () =>
        [...state.turns.values()]
          .filter((t) => t.agentId === agentId)
          .reverse()
          .sort((a, b) => startedMs(b) - startedMs(a))
          .slice(0, limit)
          .map(copy)
      ),
    turnForSubmission: (submissionId) =>
      op("turnForSubmission", () => {
        const turns = [...state.turns.values()].filter((t) => t.submissionId === submissionId)
        const last = turns.at(-1)
        return last ? copy(last) : null
      }),
    insertTurn: (turn) =>
      op("insertTurn", () => {
        if (state.turns.has(turn.id)) throw conflict("insertTurn", "turns.id")
        if (ACTIVE_TURN.has(turn.state) && storage.activeTurn(turn.agentId)) {
          throw conflict("insertTurn", "turns.agent_id (one active turn per agent)")
        }
        state.turns.set(turn.id, copy(turn))
      }),
    updateTurn: (id, changes) => op("updateTurn", () => patch(state.turns, id, defined(changes))),

    getTask: (id) => op("getTask", () => get(state.tasks, id)),
    tasksForTurn: (turnId) => op("tasksForTurn", () => [...state.tasks.values()].filter((t) => t.turnId === turnId).map(copy)),
    unfinishedTasks: () =>
      op("unfinishedTasks", () => [...state.tasks.values()].filter((t) => UNFINISHED_TASK.has(t.state)).map(copy)),
    abandonedTasks: () =>
      op("abandonedTasks", () => {
        const retried = new Set([...state.tasks.values()].map((t) => t.parentTaskId))
        return [...state.tasks.values()]
          .filter((t) => t.state === "interrupted" && t.type === "tool" && !retried.has(t.id))
          .filter((t) => SETTLED_TURN.has(state.turns.get(t.turnId)?.state ?? "running"))
          .map(copy)
      }),
    insertTask: (task) =>
      op("insertTask", () => {
        if (state.tasks.has(task.id)) throw conflict("insertTask", "tasks.id")
        state.tasks.set(task.id, {
          ...copy(task),
          output: null,
          error: null,
          acknowledged: false,
          completedAt: null
        })
      }),
    updateTask: (id, changes) => op("updateTask", () => patch(state.tasks, id, copy(defined(changes)))),

    latestCheckpoint: (agentId) =>
      op("latestCheckpoint", () => {
        let latest: AgentCheckpoint | null = null
        for (const c of state.checkpoints.values()) {
          if (c.agentId === agentId && (latest === null || c.sequence > latest.sequence)) latest = c
        }
        return latest ? copy(latest) : null
      }),
    getCheckpoint: (agentId, sequence) => op("getCheckpoint", () => get(state.checkpoints, checkpointKey(agentId, sequence))),
    insertCheckpoint: (checkpoint) =>
      op("insertCheckpoint", () => {
        const key = checkpointKey(checkpoint.agentId, checkpoint.sequence)
        if (state.checkpoints.has(key)) throw conflict("insertCheckpoint", "checkpoints.agent_id, checkpoints.sequence")
        state.checkpoints.set(key, copy(checkpoint))
      }),

    appendEvent: (event) =>
      op("appendEvent", () => {
        const log = state.events.get(event.agentId) ?? []
        const stored: DurableEvent = { ...copy(event), sequence: log.length + 1 }
        state.events.set(event.agentId, [...log, stored])
        return copy(stored)
      }),
    eventsAfter: (agentId, after, limit) =>
      op("eventsAfter", () => (state.events.get(agentId) ?? []).slice(after, after + limit).map(copy)),

    registerExecutor: (executor) =>
      op("registerExecutor", () => {
        if (state.executors.has(executor.id)) throw conflict("registerExecutor", "executors.id")
        state.executors.set(executor.id, copy(executor))
      }),
    heartbeatExecutor: (id, now) => op("heartbeatExecutor", () => patch(state.executors, id, { heartbeatAt: now })),
    stopExecutor: (id, now) => op("stopExecutor", () => patch(state.executors, id, { stoppedAt: now })),
    getExecutor: (id) => op("getExecutor", () => get(state.executors, id)),

    close: () => {
      open = false
    }
  }
  return storage
}
