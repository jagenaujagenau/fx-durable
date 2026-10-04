import { strict as assert } from "node:assert"
import { StorageError } from "../domain/errors.js"
import type { DurableAgentRecord, SubmissionRecord, TurnRecord } from "../domain/schema.js"
import type { Storage } from "../durable/storage.js"

/**
 * Conformance checks for a `Storage` implementation. Each case gets a fresh,
 * empty storage and throws (via `node:assert`) if the contract is broken.
 * Run them from any test framework:
 *
 *   for (const check of storageContract) {
 *     test(check.name, () => check.run(openMyStorage()))
 *   }
 */
export interface StorageContractCase {
  readonly name: string
  readonly run: (storage: Storage) => void
}

const at = new Date(1_700_000_000_000)

const agent = (id = "a"): DurableAgentRecord => ({
  id,
  runtimeId: "runtime",
  model: "model",
  cwd: null,
  state: "idle",
  stateReason: null,
  createdAt: at,
  updatedAt: at
})

const submission = (id: string, requestId: string | null = null): SubmissionRecord => ({
  id,
  agentId: "a",
  requestId,
  content: "hello",
  state: "queued",
  result: null,
  error: null,
  cancelRequested: false,
  createdAt: at,
  updatedAt: at
})

const turn = (id: string, state: TurnRecord["state"]): TurnRecord => ({
  id,
  agentId: "a",
  submissionId: "s1",
  state,
  attempt: 1,
  executorId: null,
  baseCheckpointSeq: null,
  startedAt: at,
  completedAt: null
})

const event = (id: string, agentId = "a") => ({
  id,
  agentId,
  submissionId: null,
  turnId: null,
  taskId: null,
  type: "agent.idle",
  payload: {},
  createdAt: at
})

class Rollback extends Error {}

const rolledBack = (storage: Storage, fn: () => void) =>
  assert.throws(() => storage.transaction(fn), Rollback)

export const storageContract: ReadonlyArray<StorageContractCase> = [
  {
    name: "records round-trip unchanged",
    run: (storage) => {
      storage.insertAgent(agent())
      assert.deepEqual(storage.getAgent("a"), agent())
      storage.insertSubmission(submission("s1", "r1"))
      assert.deepEqual(storage.getSubmission("s1"), submission("s1", "r1"))
    }
  },
  {
    name: "1. a committed transaction applies all of its writes",
    run: (storage) => {
      storage.transaction(() => {
        storage.insertAgent(agent())
        storage.appendEvent(event("e1"))
      })
      assert.equal(storage.getAgent("a")?.id, "a")
      assert.equal(storage.eventsAfter("a", 0, 10).length, 1)
    }
  },
  {
    name: "3. an exception rolls back every write of the transaction",
    run: (storage) => {
      storage.insertAgent(agent())
      rolledBack(storage, () => {
        storage.updateAgent("a", { state: "running" }, at)
        storage.insertSubmission(submission("s1"))
        storage.appendEvent(event("e1"))
        throw new Rollback()
      })
      assert.equal(storage.getAgent("a")?.state, "idle")
      assert.equal(storage.getSubmission("s1"), null)
      assert.deepEqual(storage.eventsAfter("a", 0, 10), [])
    }
  },
  {
    name: "2. nested transactions join the outer one and roll back with it",
    run: (storage) => {
      storage.insertAgent(agent())
      rolledBack(storage, () => {
        storage.transaction(() => storage.updateAgent("a", { state: "running" }, at))
        throw new Rollback()
      })
      assert.equal(storage.getAgent("a")?.state, "idle")
    }
  },
  {
    name: "4. an asynchronous transaction body is rejected and commits nothing",
    run: (storage) => {
      storage.insertAgent(agent())
      assert.throws(() =>
        storage.transaction(() => {
          storage.updateAgent("a", { state: "running" }, at)
          return Promise.resolve()
        })
      )
      assert.equal(storage.getAgent("a")?.state, "idle")
    }
  },
  {
    name: "6. reads inside a transaction observe its own writes",
    run: (storage) => {
      storage.transaction(() => {
        storage.insertAgent(agent())
        storage.updateAgent("a", { state: "running" }, at)
        assert.equal(storage.getAgent("a")?.state, "running")
        storage.appendEvent(event("e1"))
        assert.equal(storage.eventsAfter("a", 0, 10).length, 1)
      })
    }
  },
  {
    name: "7. afterCommit runs after the outermost commit, never after a rollback",
    run: (storage) => {
      const seen: Array<string> = []
      storage.afterCommit(() => seen.push("outside"))
      assert.deepEqual(seen, ["outside"])
      storage.transaction(() => {
        storage.transaction(() => storage.afterCommit(() => seen.push("nested")))
        assert.deepEqual(seen, ["outside"], "must not run before the outer commit")
      })
      assert.deepEqual(seen, ["outside", "nested"])
      rolledBack(storage, () => {
        storage.afterCommit(() => seen.push("rolled back"))
        throw new Rollback()
      })
      assert.deepEqual(seen, ["outside", "nested"])
    }
  },
  {
    name: "9. one submission per (agentId, requestId); null request ids do not collide",
    run: (storage) => {
      storage.insertAgent(agent())
      storage.insertSubmission(submission("s1", "same"))
      assert.throws(() => storage.insertSubmission(submission("s2", "same")), StorageError)
      storage.insertSubmission(submission("s3"))
      storage.insertSubmission(submission("s4"))
      assert.equal(storage.findSubmissionByRequest("a", "same")?.id, "s1")
    }
  },
  {
    name: "9. one active turn per agent",
    run: (storage) => {
      storage.insertAgent(agent())
      storage.insertSubmission(submission("s1"))
      storage.insertTurn(turn("t1", "running"))
      assert.throws(() => storage.insertTurn(turn("t2", "interrupted")), StorageError)
      storage.insertTurn(turn("t3", "completed"))
      assert.equal(storage.activeTurn("a")?.id, "t1")
    }
  },
  {
    name: "9. one checkpoint per (agentId, sequence); latest is the highest sequence",
    run: (storage) => {
      storage.insertAgent(agent())
      const checkpoint = (id: string, sequence: number) => ({
        id,
        agentId: "a",
        sequence,
        fxCheckpoint: new Uint8Array([sequence]),
        runtimeId: "runtime",
        model: "model",
        createdAt: at
      })
      storage.insertCheckpoint(checkpoint("c1", 1))
      storage.insertCheckpoint(checkpoint("c2", 2))
      assert.throws(() => storage.insertCheckpoint(checkpoint("c3", 2)), StorageError)
      assert.equal(storage.latestCheckpoint("a")?.id, "c2")
      assert.deepEqual(Array.from(storage.latestCheckpoint("a")?.fxCheckpoint ?? []), [2])
      assert.equal(storage.getCheckpoint("a", 1)?.id, "c1")
      assert.equal(storage.getCheckpoint("a", 3), null)
    }
  },
  {
    name: "9. event sequences are per agent, start at 1, and have no gaps",
    run: (storage) => {
      for (let i = 0; i < 3; i++) {
        storage.appendEvent(event(`a${i}`, "a"))
        storage.appendEvent(event(`b${i}`, "b"))
      }
      assert.deepEqual(storage.eventsAfter("a", 0, 10).map((e) => e.sequence), [1, 2, 3])
      assert.deepEqual(storage.eventsAfter("b", 1, 10).map((e) => e.sequence), [2, 3])
      assert.deepEqual(storage.eventsAfter("a", 0, 2).map((e) => e.sequence), [1, 2])
    }
  }
]
