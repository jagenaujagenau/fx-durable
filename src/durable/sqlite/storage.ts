import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { StorageError } from "../../domain/errors.js"
import {
  DocumentRecord,
  DurableAgentRecord,
  SubmissionRecord,
  ToolCallRecord,
  decodePayloadSync,
  decodeSync,
  encodePayload
} from "../../domain/schema.js"
import type { Json } from "../../domain/json.js"
import type { Storage, ToolCallKey } from "../storage.js"
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
const decodeToolCall = decodeSync(ToolCallRecord, "tool call row")
const decodeDocument = decodeSync(DocumentRecord, "document row")

type Row = Record<string, SQLOutputValue>
type Column = SQLOutputValue | undefined

const str = (v: Column): string | null => (v === null || v === undefined ? null : String(v))
const date = (v: Column): Date | null => (v === null || v === undefined ? null : new Date(Number(v)))
const blobText = (v: Column): string | null => {
  if (v === null || v === undefined) return null
  if (v instanceof Uint8Array) return new TextDecoder().decode(v)
  return String(v)
}
const bytes = (v: Column): Uint8Array | null => (v instanceof Uint8Array ? new Uint8Array(v) : null)
const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null)
const payload = (value: Json | null): string | null => (value === null ? null : encodePayload(value))

const agentFromRow = (r: Row): DurableAgentRecord =>
  decodeAgent({
    id: r.id,
    runtimeId: r.runtime_id,
    model: r.model,
    cwd: str(r.cwd),
    sessionId: str(r.session_id),
    sessionStore: str(r.session_store),
    summary: str(r.summary),
    startCheckpoint: bytes(r.start_checkpoint),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at)
  })

const submissionFromRow = (r: Row): SubmissionRecord =>
  decodeSubmission({
    id: r.id,
    agentId: r.agent_id,
    requestId: str(r.request_id),
    sessionId: r.session_id,
    sessionStore: r.session_store,
    model: r.model,
    content: decodePayloadSync(blobText(r.content), "submission.content"),
    state: r.state,
    result: decodePayloadSync(blobText(r.result), "submission.result"),
    error: str(r.error),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at)
  })

const toolCallFromRow = (r: Row): ToolCallRecord =>
  decodeToolCall({
    sessionId: r.session_id,
    executionId: r.execution_id,
    callKey: r.call_key,
    agentId: r.agent_id,
    submissionId: str(r.submission_id),
    name: r.name,
    input: decodePayloadSync(blobText(r.input), "tool_call.input"),
    replayPolicy: r.replay_policy,
    idempotencyKey: str(r.idempotency_key),
    state: r.state,
    output: decodePayloadSync(blobText(r.output), "tool_call.output"),
    error: str(r.error),
    attempts: Number(r.attempts),
    progress: str(r.progress),
    startedAt: date(r.started_at),
    completedAt: date(r.completed_at)
  })

const documentFromRow = (r: Row): DocumentRecord =>
  decodeDocument({
    agentId: r.owner === "" ? null : r.owner,
    kind: r.kind,
    version: Number(r.version),
    revision: Number(r.revision),
    value: decodePayloadSync(blobText(r.value), "document.value"),
    fork: r.fork,
    updatedAt: date(r.updated_at)
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

/** `undefined` (leave as is) or the value converted for SQLite. */
const maybe = <A>(value: A | undefined, convert: (a: A) => SQLInputValue): SQLInputValue | undefined =>
  value === undefined ? undefined : convert(value)

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
  const update = (table: string, patch: Record<string, SQLInputValue | undefined>, where: string, ...keys: Array<SQLInputValue>) => {
    const [set, values] = setClause(patch)
    if (set) db.prepare(`UPDATE ${table} SET ${set} WHERE ${where}`).run(...values, ...keys)
  }
  const callKeyParams = (key: ToolCallKey): Array<SQLInputValue> => [key.sessionId, key.executionId, key.callKey]

  const service: Storage = {
    transaction,
    afterCommit,

    getAgent: (id) => op("getAgent", () => one("SELECT * FROM agents WHERE id = ?", agentFromRow, id)),
    listAgents: () => op("listAgents", () => all("SELECT * FROM agents ORDER BY id", agentFromRow)),
    insertAgent: (a) =>
      op("insertAgent", () => {
        stmt(
          "INSERT INTO agents (id, runtime_id, model, cwd, session_id, session_store, summary, start_checkpoint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(a.id, a.runtimeId, a.model, a.cwd, a.sessionId, a.sessionStore, a.summary, a.startCheckpoint, ms(a.createdAt), ms(a.updatedAt))
      }),
    updateAgent: (id, p) =>
      op("updateAgent", () =>
        update(
          "agents",
          {
            session_id: p.sessionId,
            session_store: p.sessionStore,
            summary: p.summary,
            start_checkpoint: p.startCheckpoint,
            model: p.model,
            runtime_id: p.runtimeId,
            cwd: p.cwd,
            updated_at: ms(p.updatedAt)
          },
          "id = ?",
          id
        )
      ),

    getSubmission: (agentId, id) =>
      op("getSubmission", () => one("SELECT * FROM submissions WHERE agent_id = ? AND id = ?", submissionFromRow, agentId, id)),
    insertSubmission: (s) =>
      op("insertSubmission", () => {
        stmt(
          "INSERT INTO submissions (agent_id, id, request_id, session_id, session_store, model, content, state, result, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(s.agentId, s.id, s.requestId, s.sessionId, s.sessionStore, s.model, encodePayload(s.content), s.state, payload(s.result), s.error, ms(s.createdAt), ms(s.updatedAt))
      }),
    updateSubmission: (agentId, id, p) =>
      op("updateSubmission", () =>
        update(
          "submissions",
          { state: p.state, session_id: p.sessionId, result: maybe(p.result, payload), error: p.error, updated_at: ms(p.updatedAt) },
          "agent_id = ? AND id = ?",
          agentId,
          id
        )
      ),
    listSubmissions: (agentId, limit) =>
      op("listSubmissions", () =>
        all("SELECT * FROM submissions WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", submissionFromRow, agentId, limit)
      ),
    runningSubmissions: () =>
      op("runningSubmissions", () => all("SELECT * FROM submissions WHERE state = 'running' ORDER BY created_at, rowid", submissionFromRow)),
    finishedSubmissions: (agentId) =>
      op("finishedSubmissions", () =>
        agentId === null
          ? all("SELECT * FROM submissions WHERE result IS NOT NULL ORDER BY created_at, rowid", submissionFromRow)
          : all("SELECT * FROM submissions WHERE agent_id = ? AND result IS NOT NULL ORDER BY created_at, rowid", submissionFromRow, agentId)
      ),

    getToolCall: (key) =>
      op("getToolCall", () =>
        one("SELECT * FROM tool_calls WHERE session_id = ? AND execution_id = ? AND call_key = ?", toolCallFromRow, ...callKeyParams(key))
      ),
    insertToolCall: (c) =>
      op("insertToolCall", () => {
        stmt(
          "INSERT INTO tool_calls (session_id, execution_id, call_key, agent_id, submission_id, name, input, replay_policy, idempotency_key, state, output, error, attempts, progress, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          c.sessionId,
          c.executionId,
          c.callKey,
          c.agentId,
          c.submissionId,
          c.name,
          encodePayload(c.input),
          c.replayPolicy,
          c.idempotencyKey,
          c.state,
          payload(c.output),
          c.error,
          c.attempts,
          c.progress,
          ms(c.startedAt),
          ms(c.completedAt)
        )
      }),
    updateToolCall: (key, p) =>
      op("updateToolCall", () =>
        update(
          "tool_calls",
          {
            state: p.state,
            output: maybe(p.output, encodePayload),
            error: p.error,
            attempts: p.attempts,
            progress: p.progress,
            completed_at: maybe(p.completedAt, ms)
          },
          "session_id = ? AND execution_id = ? AND call_key = ?",
          ...callKeyParams(key)
        )
      ),
    runningToolCalls: () =>
      op("runningToolCalls", () => all("SELECT * FROM tool_calls WHERE state = 'running' ORDER BY started_at, rowid", toolCallFromRow)),
    toolCallsOf: (sessionId, executionId) =>
      op("toolCallsOf", () =>
        all("SELECT * FROM tool_calls WHERE session_id = ? AND execution_id = ? ORDER BY rowid", toolCallFromRow, sessionId, executionId)
      ),

    getDocument: (agentId, kind) =>
      op("getDocument", () => one("SELECT * FROM documents WHERE owner = ? AND kind = ?", documentFromRow, agentId ?? "", kind)),
    putDocument: (d) =>
      op("putDocument", () => {
        stmt("INSERT OR REPLACE INTO documents (owner, kind, version, revision, value, fork, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          d.agentId ?? "",
          d.kind,
          d.version,
          d.revision,
          encodePayload(d.value),
          d.fork,
          ms(d.updatedAt)
        )
      }),
    agentDocuments: (agentId) =>
      op("agentDocuments", () => all("SELECT * FROM documents WHERE owner = ? ORDER BY kind", documentFromRow, agentId)),

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
