import { strict as assert } from "node:assert"
import { StorageError } from "../domain/errors.js"
import type { DocumentRecord, DurableAgentRecord, SubmissionRecord, TaskRecord, TurnRecord } from "../domain/schema.js"
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
  kind: "input",
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
    name: "tasks round-trip, with their replay and caller links",
    run: (storage) => {
      storage.insertAgent(agent())
      storage.insertSubmission(submission("s1"))
      storage.insertTurn(turn("t1", "running"))
      const task = (id: string, links: { parentTaskId: string | null; callerTaskId: string | null; callKey: string | null }) => ({
        id,
        turnId: "t1",
        agentId: "a",
        ...links,
        type: "tool" as const,
        state: "running" as const,
        name: "tool",
        input: { x: 1 },
        inputHash: "h",
        replayPolicy: "safe" as const,
        idempotencyKey: null,
        attempt: 1,
        metadata: null,
        startedAt: at
      })
      storage.insertTask(task("k1", { parentTaskId: null, callerTaskId: null, callKey: null }))
      storage.insertTask(task("k2", { parentTaskId: null, callerTaskId: "k1", callKey: "0" }))
      storage.insertTask(task("k3", { parentTaskId: "k2", callerTaskId: "k1", callKey: "0" }))
      assert.deepEqual(
        storage.tasksForTurn("t1").map((t) => [t.id, t.parentTaskId, t.callerTaskId, t.callKey]),
        [
          ["k1", null, null, null],
          ["k2", null, "k1", "0"],
          ["k3", "k2", "k1", "0"]
        ]
      )
      storage.updateTask("k2", { state: "completed", output: 3, completedAt: at })
      assert.equal(storage.getTask("k2")?.output, 3)
      assert.deepEqual(storage.unfinishedTasks().map((t) => t.id), ["k1", "k3"])
    }
  },
  {
    name: "abandoned tasks: interrupted tool calls of ended turns that nothing retries",
    run: (storage) => {
      storage.insertAgent(agent())
      storage.insertSubmission(submission("s1"))
      storage.insertTurn(turn("ended", "completed"))
      storage.insertTurn(turn("recovering", "interrupted"))
      const task = (id: string, turnId: string, state: TaskRecord["state"], parentTaskId: string | null = null, type: TaskRecord["type"] = "tool") => ({
        id,
        turnId,
        agentId: "a",
        parentTaskId,
        callerTaskId: null,
        callKey: null,
        type,
        state,
        name: "tool",
        input: null,
        inputHash: null,
        replayPolicy: "idempotent" as const,
        idempotencyKey: null,
        attempt: 1,
        metadata: null,
        startedAt: at
      })
      storage.insertTask(task("left", "ended", "interrupted"))
      storage.insertTask(task("retried", "ended", "interrupted"))
      storage.insertTask(task("retry", "ended", "completed", "retried"))
      storage.insertTask(task("model", "ended", "interrupted", null, "model"))
      storage.insertTask(task("awaiting", "recovering", "interrupted"))
      storage.insertTask(task("left2", "ended", "interrupted"))
      assert.deepEqual(storage.abandonedTasks().map((t) => t.id), ["left", "left2"])
    }
  },
  {
    name: "documents: current values, history as of a checkpoint, and an agent's documents",
    run: (storage) => {
      storage.insertAgent(agent())
      const doc = (agentId: string | null, kind: string, revision: number, checkpointSeq: number): DocumentRecord => ({
        agentId,
        kind,
        version: 2,
        revision,
        value: { n: revision, nested: { list: [1, "two", null] } },
        history: "rewindable",
        fork: "asOf",
        checkpointSeq,
        updatedAt: at
      })
      assert.equal(storage.getDocument("a", "notes"), null)
      for (const [revision, checkpointSeq] of [[1, 0], [2, 1], [3, 1], [4, 2]] as const) {
        storage.putDocument(doc("a", "notes", revision, checkpointSeq))
        storage.insertDocumentRevision(doc("a", "notes", revision, checkpointSeq))
      }
      storage.putDocument(doc(null, "notes", 1, 0))
      storage.putDocument(doc("a", "board", 1, 0))
      assert.deepEqual(storage.getDocument("a", "notes"), doc("a", "notes", 4, 2))
      assert.deepEqual(storage.getDocument(null, "notes"), doc(null, "notes", 1, 0))
      assert.equal(storage.documentAsOf("a", "notes", 1)?.revision, 1)
      assert.equal(storage.documentAsOf("a", "notes", 2)?.revision, 3)
      assert.equal(storage.documentAsOf("a", "notes", 0), null)
      assert.deepEqual(storage.agentDocuments("a").map((d) => [d.kind, d.revision]), [["board", 1], ["notes", 4]])
      assert.throws(() => storage.insertDocumentRevision(doc("a", "notes", 4, 2)), StorageError)
    }
  },
  {
    name: "lastEventSequence is the agent's latest event sequence, 0 without events",
    run: (storage) => {
      assert.equal(storage.lastEventSequence("a"), 0)
      storage.appendEvent(event("e1"))
      storage.appendEvent(event("e2"))
      storage.appendEvent(event("x1", "b"))
      assert.equal(storage.lastEventSequence("a"), 2)
      assert.equal(storage.lastEventSequence("b"), 1)
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
        summary: sequence === 2 ? "earlier work" : null,
        runtimeId: "runtime",
        model: "model",
        createdAt: at
      })
      storage.insertCheckpoint(checkpoint("c1", 1))
      storage.insertCheckpoint(checkpoint("c2", 2))
      assert.throws(() => storage.insertCheckpoint(checkpoint("c3", 2)), StorageError)
      assert.equal(storage.latestCheckpoint("a")?.id, "c2")
      assert.deepEqual(Array.from(storage.latestCheckpoint("a")?.fxCheckpoint ?? []), [2])
      assert.equal(storage.latestCheckpoint("a")?.summary, "earlier work")
      assert.equal(storage.getCheckpoint("a", 1)?.summary, null)
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
