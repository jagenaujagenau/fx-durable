import { strict as assert } from "node:assert"
import { StorageError } from "../domain/errors.js"
import type { DocumentRecord, DurableAgentRecord, SubmissionRecord, ToolCallRecord } from "../domain/schema.js"
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
const later = (seconds: number) => new Date(at.getTime() + seconds * 1000)

const agent = (id = "a"): DurableAgentRecord => ({
  id,
  runtimeId: "r",
  model: "m",
  cwd: null,
  sessionId: null,
  sessionStore: null,
  summary: null,
  startCheckpoint: null,
  createdAt: at,
  updatedAt: at
})

const submission = (id: string, agentId = "a", createdAt = at): SubmissionRecord => ({
  id,
  agentId,
  requestId: null,
  sessionId: "s1",
  sessionStore: "t1",
  model: "m",
  content: "hello",
  state: "running",
  result: null,
  error: null,
  createdAt,
  updatedAt: createdAt
})

const toolCall = (executionId: string, callKey = "", startedAt = at): ToolCallRecord => ({
  sessionId: "s1",
  executionId,
  callKey,
  agentId: "a",
  submissionId: "q1",
  name: "deploy",
  input: { version: "v2", tags: ["a", null] },
  replayPolicy: "idempotent",
  idempotencyKey: `s1/${executionId}`,
  state: "running",
  output: null,
  error: null,
  attempts: 1,
  progress: null,
  startedAt,
  completedAt: null
})

const document = (agentId: string | null, kind: string, revision = 1): DocumentRecord => ({
  agentId,
  kind,
  version: 2,
  revision,
  value: { n: revision, nested: { list: [1, "two", null] } },
  fork: "copy",
  updatedAt: at
})

class Rollback extends Error {}

const rolledBack = (storage: Storage, fn: () => void) => assert.throws(() => storage.transaction(fn), Rollback)

export const storageContract: ReadonlyArray<StorageContractCase> = [
  {
    name: "agents round-trip, and patches change only what they name",
    run: (storage) => {
      const checkpoint = new Uint8Array([1, 2, 3])
      storage.insertAgent({ ...agent(), startCheckpoint: checkpoint, summary: "before" })
      assert.deepEqual(storage.getAgent("a"), { ...agent(), startCheckpoint: checkpoint, summary: "before" })
      storage.updateAgent("a", { sessionId: "s9", sessionStore: "t1", startCheckpoint: null, updatedAt: later(1) })
      assert.deepEqual(storage.getAgent("a"), { ...agent(), summary: "before", sessionId: "s9", sessionStore: "t1", updatedAt: later(1) })
      storage.insertAgent(agent("b"))
      assert.deepEqual(storage.listAgents().map((a) => a.id), ["a", "b"])
      assert.equal(storage.getAgent("missing"), null)
    }
  },
  {
    name: "submissions round-trip; running and finished ones are listed in order",
    run: (storage) => {
      storage.insertAgent(agent())
      storage.insertSubmission(submission("q1", "a", at))
      storage.insertSubmission(submission("q2", "a", later(1)))
      storage.insertSubmission({ ...submission("q3", "a", later(2)), content: [{ type: "text", text: "blocks" }] })
      assert.deepEqual(storage.getSubmission("a", "q1"), submission("q1", "a", at))
      const result = { text: "done", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } }
      storage.updateSubmission("a", "q2", { state: "completed", result, updatedAt: later(5) })
      assert.deepEqual(storage.getSubmission("a", "q2"), { ...submission("q2", "a", later(1)), state: "completed", result, updatedAt: later(5) })
      assert.deepEqual(storage.listSubmissions("a", 2).map((s) => s.id), ["q3", "q2"])
      assert.deepEqual(storage.runningSubmissions().map((s) => s.id), ["q1", "q3"])
      assert.deepEqual(storage.finishedSubmissions("a").map((s) => s.id), ["q2"])
      assert.deepEqual(storage.finishedSubmissions(null).map((s) => s.id), ["q2"])
    }
  },
  {
    name: "tool calls round-trip by (session, execution, key); running ones and a call's nested ones are listed",
    run: (storage) => {
      storage.insertAgent(agent())
      storage.insertToolCall(toolCall("e1", "", at))
      storage.insertToolCall(toolCall("e1", "0", later(1)))
      storage.insertToolCall(toolCall("e2", "", later(2)))
      assert.deepEqual(storage.getToolCall({ sessionId: "s1", executionId: "e1", callKey: "0" }), toolCall("e1", "0", later(1)))
      storage.updateToolCall({ sessionId: "s1", executionId: "e1", callKey: "0" }, { state: "completed", output: { ok: true }, completedAt: later(3) })
      assert.deepEqual(storage.getToolCall({ sessionId: "s1", executionId: "e1", callKey: "0" }), {
        ...toolCall("e1", "0", later(1)),
        state: "completed",
        output: { ok: true },
        completedAt: later(3)
      })
      storage.updateToolCall({ sessionId: "s1", executionId: "e2", callKey: "" }, { attempts: 2, progress: "50%" })
      assert.deepEqual(storage.runningToolCalls().map((c) => [c.executionId, c.callKey, c.attempts]), [
        ["e1", "", 1],
        ["e2", "", 2]
      ])
      assert.deepEqual(storage.toolCallsOf("s1", "e1").map((c) => c.callKey), ["", "0"])
      assert.equal(storage.getToolCall({ sessionId: "s2", executionId: "e1", callKey: "" }), null)
    }
  },
  {
    name: "documents: per agent and global, replaced in place, listed by kind",
    run: (storage) => {
      storage.insertAgent(agent())
      assert.equal(storage.getDocument("a", "notes"), null)
      storage.putDocument(document("a", "notes", 1))
      storage.putDocument(document("a", "notes", 2))
      storage.putDocument(document(null, "notes", 1))
      storage.putDocument(document("a", "board", 1))
      assert.deepEqual(storage.getDocument("a", "notes"), document("a", "notes", 2))
      assert.deepEqual(storage.getDocument(null, "notes"), document(null, "notes", 1))
      assert.deepEqual(storage.agentDocuments("a").map((d) => [d.kind, d.revision]), [
        ["board", 1],
        ["notes", 2]
      ])
    }
  },
  {
    name: "1. a committed transaction applies all of its writes",
    run: (storage) => {
      storage.transaction(() => {
        storage.insertAgent(agent())
        storage.insertSubmission(submission("q1"))
      })
      assert.ok(storage.getAgent("a"))
      assert.ok(storage.getSubmission("a", "q1"))
    }
  },
  {
    name: "3. an exception rolls back every write of the transaction",
    run: (storage) => {
      storage.insertAgent(agent())
      rolledBack(storage, () => {
        storage.insertSubmission(submission("q1"))
        storage.updateAgent("a", { sessionId: "s1", updatedAt: later(1) })
        storage.putDocument(document("a", "notes"))
        throw new Rollback()
      })
      assert.equal(storage.getSubmission("a", "q1"), null)
      assert.equal(storage.getAgent("a")?.sessionId, null)
      assert.equal(storage.getDocument("a", "notes"), null)
    }
  },
  {
    name: "2. nested transactions join the outer one and roll back with it",
    run: (storage) => {
      storage.insertAgent(agent())
      rolledBack(storage, () => {
        storage.transaction(() => storage.insertSubmission(submission("q1")))
        throw new Rollback()
      })
      assert.equal(storage.getSubmission("a", "q1"), null)
    }
  },
  {
    name: "4. an asynchronous transaction body is rejected and commits nothing",
    run: (storage) => {
      storage.insertAgent(agent())
      assert.throws(() =>
        storage.transaction(() => {
          storage.insertSubmission(submission("q1"))
          return Promise.resolve()
        })
      )
      assert.equal(storage.getSubmission("a", "q1"), null)
    }
  },
  {
    name: "6. reads inside a transaction observe its own writes",
    run: (storage) => {
      storage.transaction(() => {
        storage.insertAgent(agent())
        assert.ok(storage.getAgent("a"))
        storage.insertSubmission(submission("q1"))
        assert.deepEqual(storage.runningSubmissions().map((s) => s.id), ["q1"])
      })
    }
  },
  {
    name: "7. afterCommit runs after the outermost commit, never after a rollback",
    run: (storage) => {
      const ran: Array<string> = []
      storage.transaction(() => {
        storage.afterCommit(() => ran.push("committed"))
        storage.transaction(() => storage.afterCommit(() => ran.push("nested")))
        assert.deepEqual(ran, [])
      })
      assert.deepEqual(ran, ["committed", "nested"])
      rolledBack(storage, () => {
        storage.afterCommit(() => ran.push("rolled back"))
        throw new Rollback()
      })
      storage.afterCommit(() => ran.push("outside"))
      assert.deepEqual(ran, ["committed", "nested", "outside"])
    }
  },
  {
    name: "9. one agent per id, one submission per (agent, id), one tool call per key",
    run: (storage) => {
      storage.insertAgent(agent())
      assert.throws(() => storage.insertAgent(agent()), StorageError)
      storage.insertAgent(agent("b"))
      storage.insertSubmission(submission("q1"))
      assert.throws(() => storage.insertSubmission(submission("q1")), StorageError)
      // The same id under another agent is another submission.
      storage.insertSubmission(submission("q1", "b"))
      storage.insertToolCall(toolCall("e1"))
      assert.throws(() => storage.insertToolCall(toolCall("e1")), StorageError)
      storage.insertToolCall(toolCall("e1", "0"))
    }
  }
]
