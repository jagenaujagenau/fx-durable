import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { StorageError } from "../../domain/errors.js"
import {
  AgentCheckpoint,
  DurableAgentRecord,
  DurableEvent,
  SubmissionRecord,
  TaskRecord,
  TurnRecord,
  decodePayloadSync,
  decodeSync,
  encodePayload
} from "../../domain/schema.js"
import type { ExecutorRecord, Storage } from "../storage.js"
import { applyMigrations } from "./schema.js"

export interface SqliteOptions {
  readonly path: string
  /**
   * `FULL` (default) survives power loss; `NORMAL` survives process crashes
   * in WAL mode but may lose the last commits on power loss.
   */
  readonly synchronous?: "FULL" | "NORMAL"
}

const decodeAgent = decodeSync(DurableAgentRecord, "agent row")
const decodeSubmission = decodeSync(SubmissionRecord, "submission row")
const decodeTurn = decodeSync(TurnRecord, "turn row")
const decodeTask = decodeSync(TaskRecord, "task row")
const decodeCheckpoint = decodeSync(AgentCheckpoint, "checkpoint row")
const decodeEvent = decodeSync(DurableEvent, "event row")

type Row = Record<string, SQLOutputValue>

type Column = SQLOutputValue | undefined

const str = (v: Column): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: Column): number | null => (v === null || v === undefined ? null : Number(v))
const date = (v: Column): Date | null => (v === null || v === undefined ? null : new Date(Number(v)))
const blobText = (v: Column): string | null => {
  if (v === null || v === undefined) return null
  if (v instanceof Uint8Array) return new TextDecoder().decode(v)
  return String(v)
}
const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null)

const agentFromRow = (r: Row): DurableAgentRecord =>
  decodeAgent({
    id: r.id,
    runtimeId: r.runtime_id,
    model: r.model,
    cwd: str(r.cwd),
    state: r.state,
    stateReason: str(r.state_reason),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at)
  })

const submissionFromRow = (r: Row): SubmissionRecord =>
  decodeSubmission({
    id: r.id,
    agentId: r.agent_id,
    requestId: str(r.request_id),
    content: decodePayloadSync(blobText(r.content), "submission.content"),
    state: r.state,
    result: decodePayloadSync(blobText(r.result), "submission.result"),
    error: str(r.error),
    cancelRequested: Number(r.cancel_requested) === 1,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at)
  })

const turnFromRow = (r: Row): TurnRecord =>
  decodeTurn({
    id: r.id,
    agentId: r.agent_id,
    submissionId: r.submission_id,
    state: r.state,
    attempt: Number(r.attempt),
    executorId: str(r.executor_id),
    baseCheckpointSeq: num(r.base_checkpoint_seq),
    startedAt: date(r.started_at),
    completedAt: date(r.completed_at)
  })

const taskFromRow = (r: Row): TaskRecord =>
  decodeTask({
    id: r.id,
    turnId: r.turn_id,
    agentId: r.agent_id,
    parentTaskId: str(r.parent_task_id),
    type: r.type,
    state: r.state,
    name: str(r.name),
    input: decodePayloadSync(blobText(r.input), "task.input"),
    inputHash: str(r.input_hash),
    output: decodePayloadSync(blobText(r.output), "task.output"),
    error: str(r.error),
    replayPolicy: str(r.replay_policy),
    idempotencyKey: str(r.idempotency_key),
    attempt: Number(r.attempt),
    acknowledged: Number(r.acknowledged) === 1,
    metadata: decodePayloadSync(blobText(r.metadata), "task.metadata"),
    startedAt: date(r.started_at),
    completedAt: date(r.completed_at)
  })

const checkpointFromRow = (r: Row): AgentCheckpoint =>
  decodeCheckpoint({
    id: r.id,
    agentId: r.agent_id,
    sequence: Number(r.sequence),
    fxCheckpoint: r.data instanceof Uint8Array ? new Uint8Array(r.data) : r.data,
    runtimeId: r.runtime_id,
    model: r.model,
    createdAt: date(r.created_at)
  })

const eventFromRow = (r: Row): DurableEvent =>
  decodeEvent({
    id: r.id,
    agentId: r.agent_id,
    submissionId: str(r.submission_id),
    turnId: str(r.turn_id),
    taskId: str(r.task_id),
    sequence: Number(r.sequence),
    type: r.type,
    payload: decodePayloadSync(blobText(r.payload), "event.payload"),
    createdAt: date(r.created_at)
  })

const executorFromRow = (r: Row): ExecutorRecord => ({
  id: String(r.id),
  pid: Number(r.pid),
  hostname: String(r.hostname),
  startedAt: new Date(Number(r.started_at)),
  heartbeatAt: new Date(Number(r.heartbeat_at)),
  stoppedAt: date(r.stopped_at)
})

/** Build an `UPDATE ... SET` from a sparse patch. */
const setClause = (patch: Record<string, SQLInputValue | undefined>): [string, Array<SQLInputValue>] => {
  const cols: Array<string> = []
  const vals: Array<SQLInputValue> = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    cols.push(`${k} = ?`)
    vals.push(v)
  }
  return [cols.join(", "), vals]
}

export const openDatabase = (options: SqliteOptions): DatabaseSync => {
  if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`PRAGMA synchronous = ${options.synchronous ?? "FULL"}`)
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  applyMigrations(db)
  return db
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Open SQLite storage. Plain synchronous code: no Effect runtime involved. */
export const openSqliteStorage = (options: SqliteOptions): Storage => {
  let db: DatabaseSync
  try {
    db = openDatabase(options)
  } catch (cause) {
    throw new StorageError({ operation: "open", message: message(cause), cause })
  }
  const statements = new Map<string, StatementSync>()
  const stmt = (sql: string): StatementSync => {
    let s = statements.get(sql)
    if (!s) {
      s = db.prepare(sql)
      statements.set(sql, s)
    }
    return s
  }

  /** Run one operation, reporting driver and decode failures as `StorageError`. */
  const op = <A>(operation: string, f: () => A): A => {
    try {
      return f()
    } catch (cause) {
      if (cause instanceof StorageError) throw cause
      throw new StorageError({ operation, message: message(cause), cause })
    }
  }

  let depth = 0
  let hooks: Array<() => void> = []

  const transaction = <A>(fn: () => A): A => {
    if (depth > 0) return fn()
    op("begin", () => db.exec("BEGIN IMMEDIATE"))
    depth = 1
    hooks = []
    let result: A
    try {
      result = fn()
      if (result instanceof Promise) {
        throw new TypeError("transaction bodies must be synchronous; got a Promise")
      }
      op("commit", () => db.exec("COMMIT"))
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
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

  const all = <A>(sql: string, map: (r: Row) => A, ...params: Array<SQLInputValue>): Array<A> =>
    stmt(sql).all(...params).map(map)
  const one = <A>(sql: string, map: (r: Row) => A, ...params: Array<SQLInputValue>): A | null => {
    const row = stmt(sql).get(...params)
    return row ? map(row) : null
  }

  const service: Storage = {
    transaction,
    afterCommit,

    getAgent: (id) => op("getAgent", () => one("SELECT * FROM agents WHERE id = ?", agentFromRow, id)),
    listAgents: () => op("listAgents", () => all("SELECT * FROM agents ORDER BY id", agentFromRow)),
    insertAgent: (a) =>
      op("insertAgent", () => {
        stmt(
          "INSERT INTO agents (id, runtime_id, model, cwd, state, state_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(a.id, a.runtimeId, a.model, a.cwd, a.state, a.stateReason, ms(a.createdAt), ms(a.updatedAt))
      }),
    updateAgent: (id, patch, now) =>
      op("updateAgent", () => {
        const [set, vals] = setClause({
          state: patch.state,
          state_reason: patch.stateReason,
          runtime_id: patch.runtimeId,
          model: patch.model,
          cwd: patch.cwd,
          updated_at: now.getTime()
        })
        db.prepare(`UPDATE agents SET ${set} WHERE id = ?`).run(...vals, id)
      }),

    getSubmission: (id) =>
      op("getSubmission", () => one("SELECT * FROM submissions WHERE id = ?", submissionFromRow, id)),
    findSubmissionByRequest: (agentId, requestId) =>
      op("findSubmissionByRequest", () =>
        one("SELECT * FROM submissions WHERE agent_id = ? AND request_id = ?", submissionFromRow, agentId, requestId)
      ),
    nextQueuedSubmission: (agentId) =>
      op("nextQueuedSubmission", () =>
        one(
          "SELECT * FROM submissions WHERE agent_id = ? AND state = 'queued' ORDER BY created_at, rowid LIMIT 1",
          submissionFromRow,
          agentId
        )
      ),
    listSubmissions: (agentId, limit) =>
      op("listSubmissions", () =>
        all(
          "SELECT * FROM submissions WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
          submissionFromRow,
          agentId,
          limit
        )
      ),
    insertSubmission: (s) =>
      op("insertSubmission", () => {
        stmt(
          "INSERT INTO submissions (id, agent_id, request_id, content, state, result, error, cancel_requested, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          s.id,
          s.agentId,
          s.requestId,
          encodePayload(s.content),
          s.state,
          s.result === null ? null : encodePayload(s.result),
          s.error,
          s.cancelRequested ? 1 : 0,
          ms(s.createdAt),
          ms(s.updatedAt)
        )
      }),
    updateSubmission: (id, patch, now) =>
      op("updateSubmission", () => {
        const [set, vals] = setClause({
          state: patch.state,
          result: patch.result === undefined ? undefined : encodePayload(patch.result),
          error: patch.error,
          cancel_requested: patch.cancelRequested === undefined ? undefined : patch.cancelRequested ? 1 : 0,
          updated_at: now.getTime()
        })
        db.prepare(`UPDATE submissions SET ${set} WHERE id = ?`).run(...vals, id)
      }),

    getTurn: (id) => op("getTurn", () => one("SELECT * FROM turns WHERE id = ?", turnFromRow, id)),
    activeTurn: (agentId) =>
      op("activeTurn", () =>
        one("SELECT * FROM turns WHERE agent_id = ? AND state IN ('running', 'interrupted')", turnFromRow, agentId)
      ),
    unfinishedTurns: () =>
      op("unfinishedTurns", () =>
        all("SELECT * FROM turns WHERE state IN ('running', 'interrupted') ORDER BY started_at, rowid", turnFromRow)
      ),
    listTurns: (agentId, limit) =>
      op("listTurns", () =>
        all("SELECT * FROM turns WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?", turnFromRow, agentId, limit)
      ),
    turnForSubmission: (submissionId) =>
      op("turnForSubmission", () =>
        one("SELECT * FROM turns WHERE submission_id = ? ORDER BY rowid DESC LIMIT 1", turnFromRow, submissionId)
      ),
    insertTurn: (t) =>
      op("insertTurn", () => {
        stmt(
          "INSERT INTO turns (id, agent_id, submission_id, state, attempt, executor_id, base_checkpoint_seq, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          t.id,
          t.agentId,
          t.submissionId,
          t.state,
          t.attempt,
          t.executorId,
          t.baseCheckpointSeq,
          ms(t.startedAt),
          ms(t.completedAt)
        )
      }),
    updateTurn: (id, patch) =>
      op("updateTurn", () => {
        const [set, vals] = setClause({
          state: patch.state,
          attempt: patch.attempt,
          executor_id: patch.executorId,
          completed_at: patch.completedAt === undefined ? undefined : ms(patch.completedAt)
        })
        if (set) db.prepare(`UPDATE turns SET ${set} WHERE id = ?`).run(...vals, id)
      }),

    getTask: (id) => op("getTask", () => one("SELECT * FROM tasks WHERE id = ?", taskFromRow, id)),
    tasksForTurn: (turnId) =>
      op("tasksForTurn", () => all("SELECT * FROM tasks WHERE turn_id = ? ORDER BY rowid", taskFromRow, turnId)),
    unfinishedTasks: () =>
      op("unfinishedTasks", () =>
        all("SELECT * FROM tasks WHERE state IN ('pending', 'running') ORDER BY rowid", taskFromRow)
      ),
    insertTask: (t) =>
      op("insertTask", () => {
        stmt(
          "INSERT INTO tasks (id, turn_id, agent_id, parent_task_id, type, state, name, input, input_hash, replay_policy, idempotency_key, attempt, metadata, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          t.id,
          t.turnId,
          t.agentId,
          t.parentTaskId,
          t.type,
          t.state,
          t.name,
          t.input === null ? null : encodePayload(t.input),
          t.inputHash,
          t.replayPolicy,
          t.idempotencyKey,
          t.attempt,
          t.metadata === null ? null : encodePayload(t.metadata),
          ms(t.startedAt)
        )
      }),
    updateTask: (id, patch) =>
      op("updateTask", () => {
        const [set, vals] = setClause({
          state: patch.state,
          output: patch.output === undefined ? undefined : encodePayload(patch.output),
          error: patch.error,
          acknowledged: patch.acknowledged === undefined ? undefined : patch.acknowledged ? 1 : 0,
          metadata: patch.metadata === undefined ? undefined : encodePayload(patch.metadata),
          completed_at: patch.completedAt === undefined ? undefined : ms(patch.completedAt)
        })
        if (set) db.prepare(`UPDATE tasks SET ${set} WHERE id = ?`).run(...vals, id)
      }),

    latestCheckpoint: (agentId) =>
      op("latestCheckpoint", () =>
        one(
          "SELECT * FROM checkpoints WHERE agent_id = ? ORDER BY sequence DESC LIMIT 1",
          checkpointFromRow,
          agentId
        )
      ),
    getCheckpoint: (agentId, sequence) =>
      op("getCheckpoint", () =>
        one("SELECT * FROM checkpoints WHERE agent_id = ? AND sequence = ?", checkpointFromRow, agentId, sequence)
      ),
    insertCheckpoint: (c) =>
      op("insertCheckpoint", () => {
        stmt(
          "INSERT INTO checkpoints (id, agent_id, sequence, runtime_id, model, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(c.id, c.agentId, c.sequence, c.runtimeId, c.model, c.fxCheckpoint, ms(c.createdAt))
      }),

    appendEvent: (e) =>
      op("appendEvent", () => {
        const row = stmt("SELECT COALESCE(MAX(sequence), 0) AS seq FROM events WHERE agent_id = ?").get(e.agentId)
        const sequence = Number(row?.seq ?? 0) + 1
        stmt(
          "INSERT INTO events (id, agent_id, submission_id, turn_id, task_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(e.id, e.agentId, e.submissionId, e.turnId, e.taskId, sequence, e.type, encodePayload(e.payload), ms(e.createdAt))
        return {
          id: e.id,
          agentId: e.agentId,
          submissionId: e.submissionId,
          turnId: e.turnId,
          taskId: e.taskId,
          sequence,
          type: e.type,
          payload: e.payload,
          createdAt: e.createdAt
        }
      }),
    eventsAfter: (agentId, after, limit) =>
      op("eventsAfter", () =>
        all(
          "SELECT * FROM events WHERE agent_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
          eventFromRow,
          agentId,
          after,
          limit
        )
      ),

    registerExecutor: (x) =>
      op("registerExecutor", () => {
        stmt(
          "INSERT INTO executors (id, pid, hostname, started_at, heartbeat_at, stopped_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(x.id, x.pid, x.hostname, ms(x.startedAt), ms(x.heartbeatAt), ms(x.stoppedAt))
      }),
    heartbeatExecutor: (id, now) =>
      op("heartbeatExecutor", () => {
        stmt("UPDATE executors SET heartbeat_at = ? WHERE id = ?").run(now.getTime(), id)
      }),
    stopExecutor: (id, now) =>
      op("stopExecutor", () => {
        stmt("UPDATE executors SET stopped_at = ? WHERE id = ?").run(now.getTime(), id)
      }),
    getExecutor: (id) => op("getExecutor", () => one("SELECT * FROM executors WHERE id = ?", executorFromRow, id)),

    close: () => {
      if (db.isOpen) db.close()
    }
  }
  return service
}

/** Storage configuration accepted by `DurableFx.open({ storage })`. Plain data. */
export interface SqliteStorageConfig {
  readonly _tag: "SqliteStorageConfig"
  readonly options: SqliteOptions
}

export const sqlite = (path: string, options?: Omit<SqliteOptions, "path">): SqliteStorageConfig => ({
  _tag: "SqliteStorageConfig",
  options: { ...options, path }
})
