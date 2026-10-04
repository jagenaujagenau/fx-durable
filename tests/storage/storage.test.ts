import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { EventLog } from "../../src/core/events.js"
import { Storage } from "../../src/core/storage.js"
import { decodePayloadSync, encodePayload } from "../../src/core/schema.js"
import { journalRuntime, tempDb } from "../helpers.js"

const agent = (id: string) => ({
  id,
  runtimeId: "coding",
  model: "m",
  cwd: null,
  state: "idle" as const,
  stateReason: null,
  createdAt: new Date(1),
  updatedAt: new Date(1)
})

describe("SQLite storage", () => {
  it("opens in WAL mode with migrations applied", async () => {
    const db = tempDb()
    const j = journalRuntime(db)
    await j.storage()
    const raw = new DatabaseSync(db)
    expect(raw.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal")
    expect(raw.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }])
    raw.close()
    await j.runtime.dispose()
  })

  it("transactions are atomic: a failure rolls back every write and its events", async () => {
    const j = journalRuntime(tempDb())
    const result = await j.run(
      Effect.gen(function* () {
        const storage = yield* Storage
        const events = yield* EventLog
        yield* storage.insertAgent(agent("a"))
        const exit = yield* storage
          .transaction(
            Effect.gen(function* () {
              yield* storage.updateAgent("a", { state: "running" }, new Date(2))
              yield* events.append({ agentId: "a", type: "agent.updated" })
              return yield* Effect.fail("boom" as const)
            })
          )
          .pipe(Effect.exit)
        const after = yield* storage.getAgent("a")
        const history = yield* events.history("a")
        return { failed: exit._tag === "Failure", state: after?.state, events: history.length }
      })
    )
    expect(result).toEqual({ failed: true, state: "idle", events: 0 })
    await j.runtime.dispose()
  })

  it("defects inside a transaction also roll back", async () => {
    const j = journalRuntime(tempDb())
    const state = await j.run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.insertAgent(agent("a"))
        yield* storage
          .transaction(
            Effect.gen(function* () {
              yield* storage.updateAgent("a", { state: "running" }, new Date(2))
              return yield* Effect.die(new Error("programmer error"))
            })
          )
          .pipe(Effect.exit)
        return (yield* storage.getAgent("a"))?.state
      })
    )
    expect(state).toBe("idle")
    await j.runtime.dispose()
  })

  it("afterCommit hooks run only after a successful commit", async () => {
    const j = journalRuntime(tempDb())
    const seen: Array<string> = []
    await j.run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.transaction(storage.afterCommit(Effect.sync(() => seen.push("committed"))))
        yield* storage
          .transaction(
            Effect.gen(function* () {
              yield* storage.afterCommit(Effect.sync(() => seen.push("rolled-back")))
              return yield* Effect.fail("no")
            })
          )
          .pipe(Effect.exit)
      })
    )
    expect(seen).toEqual(["committed"])
    await j.runtime.dispose()
  })

  it("enforces UNIQUE(agent_id, request_id) at the database level", async () => {
    const j = journalRuntime(tempDb())
    const exit = await j.run(
      Effect.gen(function* () {
        const storage = yield* Storage
        yield* storage.insertAgent(agent("a"))
        const sub = (id: string) => ({
          id,
          agentId: "a",
          requestId: "same",
          content: "x",
          state: "queued" as const,
          result: null,
          error: null,
          cancelRequested: false,
          createdAt: new Date(1),
          updatedAt: new Date(1)
        })
        yield* storage.insertSubmission(sub("s1"))
        return yield* storage.insertSubmission(sub("s2")).pipe(Effect.exit)
      })
    )
    expect(exit._tag).toBe("Failure")
    await j.runtime.dispose()
  })

  it("enforces one active turn per agent at the database level", async () => {
    const db = tempDb()
    const j = journalRuntime(db)
    await j.storage()
    const raw = new DatabaseSync(db)
    raw.exec("INSERT INTO agents VALUES ('a','coding','m',NULL,'idle',NULL,1,1)")
    raw.exec("INSERT INTO submissions (id, agent_id, content, state, created_at, updated_at) VALUES ('s1','a','{}','running',1,1)")
    raw.exec("INSERT INTO turns (id, agent_id, submission_id, state) VALUES ('t1','a','s1','running')")
    expect(() => raw.exec("INSERT INTO turns (id, agent_id, submission_id, state) VALUES ('t2','a','s1','interrupted')")).toThrow(/UNIQUE/)
    raw.exec("INSERT INTO turns (id, agent_id, submission_id, state) VALUES ('t3','a','s1','completed')")
    raw.close()
    await j.runtime.dispose()
  })

  it("event sequences are per-agent and gap-free", async () => {
    const j = journalRuntime(tempDb())
    const seqs = await j.run(
      Effect.gen(function* () {
        const events = yield* EventLog
        for (let i = 0; i < 3; i++) {
          yield* events.append({ agentId: "a", type: "agent.idle" })
          yield* events.append({ agentId: "b", type: "agent.idle" })
        }
        const a = yield* events.history("a")
        const b = yield* events.history("b", 1)
        return { a: a.map((e) => e.sequence), b: b.map((e) => e.sequence) }
      })
    )
    expect(seqs).toEqual({ a: [1, 2, 3], b: [2, 3] })
    await j.runtime.dispose()
  })
})

describe("persisted payload envelopes", () => {
  it("round-trips versioned payloads", () => {
    expect(decodePayloadSync(encodePayload({ x: 1 }), "t")).toEqual({ x: 1 })
  })

  it("never trusts payloads from a newer format version", () => {
    expect(() => decodePayloadSync(JSON.stringify({ v: 99, data: {} }), "t")).toThrow(/newer than supported/)
  })

  it("rejects unenveloped JSON", () => {
    expect(() => decodePayloadSync(JSON.stringify({ x: 1 }), "t")).toThrow(/envelope/)
  })

  it("rejects persisted rows with invalid states", async () => {
    const db = tempDb()
    const j = journalRuntime(db)
    await j.storage()
    const raw = new DatabaseSync(db)
    raw.exec("INSERT INTO agents VALUES ('bad','coding','m',NULL,'exploded',NULL,1,1)")
    raw.close()
    const exit = await j.run(Effect.flatMap(Storage, (s) => s.getAgent("bad")).pipe(Effect.exit))
    expect(exit._tag).toBe("Failure")
    await j.runtime.dispose()
  })
})
