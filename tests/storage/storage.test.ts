import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { StorageError } from "../../src/domain/errors.js"
import { decodePayloadSync, encodePayload } from "../../src/domain/schema.js"
import { openSqliteStorage } from "../../src/durable/sqlite/storage.js"
import { openTestJournal, tempDb } from "../helpers.js"

describe("SQLite storage", () => {
  it("opens in WAL mode with its migrations applied", () => {
    const db = tempDb()
    openTestJournal(db).storage.close()
    const raw = new DatabaseSync(db)
    expect(raw.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal")
    expect(raw.prepare("SELECT version FROM fxd_migrations").all()).toEqual([{ version: 1 }])
    raw.close()
  })

  it("refuses a database written by fx-durable 0.2", () => {
    const db = tempDb()
    const raw = new DatabaseSync(db)
    raw.exec("CREATE TABLE turns (id TEXT PRIMARY KEY)")
    raw.close()
    expect(() => openSqliteStorage({ path: db })).toThrow(/fx-durable 0.2/)
  })

  it("rejects persisted rows that do not decode", () => {
    const db = tempDb()
    const { storage } = openTestJournal(db)
    const raw = new DatabaseSync(db)
    raw.exec("INSERT INTO agents (id, runtime_id, model, created_at, updated_at) VALUES ('a','r','m',1,1)")
    raw.exec(`INSERT INTO submissions (agent_id, id, session_id, session_store, model, content, state, created_at, updated_at) VALUES ('a', 'q', 's', 't', 'm', '{"v":1,"data":"hi"}', 'exploded', 1, 1)`)
    raw.close()
    expect(() => storage.getSubmission("a", "q")).toThrow(StorageError)
    storage.close()
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
})
