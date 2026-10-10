import { describe, expect, it } from "vitest"
import { DurableFxFailedError, Journal, StorageError, type Storage } from "../../src/index.js"
import { openSqliteStorage } from "../../src/durable/sqlite/storage.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

/** SQLite storage whose transactions start failing once `broken` is set, like a full or vanished disk. */
const breakable = (path: string) => {
  const storage = openSqliteStorage({ path })
  const state = { broken: false }
  const wrapped: Storage = {
    ...storage,
    transaction: (fn) => {
      if (state.broken) throw new StorageError({ operation: "begin", message: "disk I/O error" })
      return storage.transaction(fn)
    }
  }
  return { storage: wrapped, state }
}

describe("a storage error closes fx-durable", () => {
  it("rejects the call that hit it with the error, settles `closed`, and rejects later calls", async () => {
    const db = tempDb()
    const { storage, state } = breakable(db)
    const fx = await openFx(db, () => ({ text: "hi" }), { storage, runtimes: { chat: {} } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })

    state.broken = true
    const error = await agent.submit("hello").catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(StorageError)

    expect(await fx.closed).toEqual({ reason: "failed", error })
    const later = await fx.agent("b", { runtime: "chat", model: "test/model" }).catch((cause: unknown) => cause)
    expect(later).toBeInstanceOf(DurableFxFailedError)
    expect(later).toMatchObject({ cause: error })
  })

  it("stops a turn whose journal write fails; reopening recovers and finishes it", async () => {
    const db = tempDb()
    const { storage, state } = breakable(db)
    const modelCalled = deferred()
    const release = deferred()
    const fx = await openFx(
      db,
      async () => {
        modelCalled.resolve()
        await release.promise
        return { text: "answer" }
      },
      { storage, runtimes: { chat: {} } }
    )
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const submission = await agent.submit("question")
    const result = submission.result().catch((cause: unknown) => cause)

    await modelCalled.promise
    state.broken = true
    release.resolve()

    const closed = await fx.closed
    expect(closed.reason).toBe("failed")
    expect(await result).toBeInstanceOf(DurableFxFailedError)

    // The same database, healthy again, in a new process.
    const reopened = await openFx(db, () => ({ text: "answer" }), { runtimes: { chat: {} } })
    const again = await reopened.attach("a")
    const stateOf = async () => (await again.submissions()).find((s) => s.id === submission.id)?.state
    await waitFor(async () => (await stateOf()) === "completed")
    await reopened.close()
  })

  it("settles `closed` with reason closed after close()", async () => {
    const fx = await openFx(tempDb(), () => ({ text: "hi" }), { runtimes: { chat: {} } })
    await fx.close()
    expect(await fx.closed).toEqual({ reason: "closed" })
    await expect(fx.listAgents()).rejects.toThrow(/not open/)
  })
})

describe("duplicate request ids across processes", () => {
  it("returns the submission that won the race instead of failing on the unique constraint", () => {
    const sqlite = openSqliteStorage({ path: tempDb() })
    // Another process's submission is invisible to the first lookup, as with a storage that does not serialize transactions.
    let hidden = false
    const storage: Storage = {
      ...sqlite,
      findSubmissionByRequest: (agentId, requestId) => (hidden ? ((hidden = false), null) : sqlite.findSubmissionByRequest(agentId, requestId))
    }
    const journal = new Journal({ storage, nextId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2)}` })
    journal.upsertAgent("a", { runtime: "r", model: "m" })
    const first = journal.submit("a", "req-1", "hello")
    hidden = true
    expect(journal.submit("a", "req-1", "hello")).toEqual({ record: first.record, created: false })
  })
})
