import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { InvalidTransitionError, StorageError } from "../../src/domain/errors.js"
import { decodePayloadSync, encodePayload } from "../../src/domain/schema.js"
import { openTestJournal, tempDb } from "../helpers.js"

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

const submission = (id: string) => ({
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

describe("SQLite storage (plain synchronous code)", () => {
  it("opens in WAL mode with migrations applied", () => {
    const db = tempDb()
    openTestJournal(db).storage.close()
    const raw = new DatabaseSync(db)
    expect(raw.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal")
    expect(raw.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }])
    raw.close()
  })

  it("transactions are atomic: a throw rolls back every write and its events", () => {
    const j = openTestJournal(tempDb())
    j.storage.insertAgent(agent("a"))
    expect(() =>
      j.transaction(() => {
        j.storage.updateAgent("a", { state: "running" }, new Date(2))
        j.appendEvent({ agentId: "a", type: "agent.updated" })
        throw new Error("boom")
      })
    ).toThrow("boom")
    expect(j.storage.getAgent("a")?.state).toBe("idle")
    expect(j.storage.eventsAfter("a", 0, 10)).toEqual([])
    j.storage.close()
  })

  it("invalid state transitions throw and roll back", () => {
    const j = openTestJournal(tempDb())
    j.storage.insertAgent(agent("a"))
    expect(() =>
      j.transaction(() => {
        j.storage.updateAgent("a", { stateReason: "half-written" }, new Date(2))
        j.transitionAgent("a", "needs_input")
        j.transitionAgent("a", "failed") // needs_input → failed is not allowed
      })
    ).toThrow(InvalidTransitionError)
    expect(j.storage.getAgent("a")).toMatchObject({ state: "idle", stateReason: null })
    j.storage.close()
  })

  it("nested transactions flatten into the outer one", () => {
    const j = openTestJournal(tempDb())
    j.storage.insertAgent(agent("a"))
    expect(() =>
      j.transaction(() => {
        j.transaction(() => j.transitionAgent("a", "running"))
        throw new Error("outer fails")
      })
    ).toThrow("outer fails")
    expect(j.storage.getAgent("a")?.state).toBe("idle")
    j.storage.close()
  })

  it("rejects asynchronous transaction bodies", () => {
    const j = openTestJournal(tempDb())
    expect(() => j.transaction(async () => undefined)).toThrow(/must be synchronous/)
    j.storage.close()
  })

  it("committed-event listeners run only after a successful commit", () => {
    const j = openTestJournal(tempDb())
    const seen: Array<string> = []
    j.onCommitted((event) => seen.push(event.type))
    j.transaction(() => j.appendEvent({ agentId: "a", type: "agent.idle" }))
    expect(() =>
      j.transaction(() => {
        j.appendEvent({ agentId: "a", type: "agent.updated" })
        throw new Error("no")
      })
    ).toThrow()
    expect(seen).toEqual(["agent.idle"])
    j.storage.close()
  })

  it("enforces UNIQUE(agent_id, request_id) at the database level", () => {
    const j = openTestJournal(tempDb())
    j.storage.insertAgent(agent("a"))
    j.storage.insertSubmission(submission("s1"))
    expect(() => j.storage.insertSubmission(submission("s2"))).toThrow(StorageError)
    j.storage.close()
  })

  it("enforces one active turn per agent at the database level", () => {
    const db = tempDb()
    openTestJournal(db).storage.close()
    const raw = new DatabaseSync(db)
    raw.exec("INSERT INTO agents VALUES ('a','coding','m',NULL,'idle',NULL,1,1)")
    raw.exec("INSERT INTO submissions (id, agent_id, content, state, created_at, updated_at) VALUES ('s1','a','{}','running',1,1)")
    raw.exec("INSERT INTO turns (id, agent_id, submission_id, state) VALUES ('t1','a','s1','running')")
    expect(() => raw.exec("INSERT INTO turns (id, agent_id, submission_id, state) VALUES ('t2','a','s1','interrupted')")).toThrow(/UNIQUE/)
    raw.exec("INSERT INTO turns (id, agent_id, submission_id, state) VALUES ('t3','a','s1','completed')")
    raw.close()
  })

  it("event sequences are per-agent and gap-free", () => {
    const j = openTestJournal(tempDb())
    for (let i = 0; i < 3; i++) {
      j.appendEvent({ agentId: "a", type: "agent.idle" })
      j.appendEvent({ agentId: "b", type: "agent.idle" })
    }
    expect(j.storage.eventsAfter("a", 0, 10).map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(j.storage.eventsAfter("b", 1, 10).map((e) => e.sequence)).toEqual([2, 3])
    j.storage.close()
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

  it("rejects persisted rows with invalid states", () => {
    const db = tempDb()
    const j = openTestJournal(db)
    const raw = new DatabaseSync(db)
    raw.exec("INSERT INTO agents VALUES ('bad','coding','m',NULL,'exploded',NULL,1,1)")
    raw.close()
    expect(() => j.storage.getAgent("bad")).toThrow(StorageError)
    j.storage.close()
  })
})
