import { describe, expect, it } from "vitest"
import { InvalidTransitionError } from "../../src/domain/errors.js"
import { defineDocument } from "../../src/domain/documents.js"
import type { StagedDocumentWrite } from "../../src/durable/journal.js"
import type { JsonObject } from "../../src/domain/json.js"
import { openTestJournal, tempDb } from "../helpers.js"

const setup = () => {
  const { journal, storage } = openTestJournal(tempDb())
  journal.upsertAgent("a", { runtime: "r", model: "m" })
  return { journal, storage }
}

const call = (executionId: string, callKey = "", submissionId: string | null = "q1") => ({
  sessionId: "s1",
  executionId,
  callKey,
  agentId: "a",
  submissionId,
  name: "deploy",
  input: { v: 1 },
  replayPolicy: "unsafe" as const,
  idempotencyKey: null
})

describe("Journal", () => {
  it("records a request once per id, even when submitted again", () => {
    const { journal } = setup()
    const request = { agentId: "a", id: "q1", requestId: "q1", sessionId: "s1", sessionStore: "t1", model: "m", content: "hi" }
    expect(journal.admitSubmission(request).created).toBe(true)
    expect(journal.admitSubmission({ ...request, content: "different" })).toMatchObject({ created: false, record: { content: "hi" } })
  })

  it("finishes a request once; its turn's calls still running become unknown", () => {
    const { journal, storage } = setup()
    journal.admitSubmission({ agentId: "a", id: "q1", requestId: null, sessionId: "s1", sessionStore: "t1", model: "m", content: "hi" })
    journal.startToolCall(call("e1"))
    journal.startToolCall(call("e2"))
    journal.completeToolCall({ sessionId: "s1", executionId: "e2", callKey: "" }, "ok")
    journal.startToolCall(call("e3", "", "other"))
    const finished = journal.finishSubmission("a", "q1", { state: "completed", result: { text: "done", stopReason: "end_turn", usage: null }, error: null })
    expect(finished.state).toBe("completed")
    expect(storage.getToolCall({ sessionId: "s1", executionId: "e1", callKey: "" })?.state).toBe("outcome_unknown")
    expect(storage.getToolCall({ sessionId: "s1", executionId: "e2", callKey: "" })?.state).toBe("completed")
    expect(storage.getToolCall({ sessionId: "s1", executionId: "e3", callKey: "" })?.state).toBe("running")
    // A second report changes nothing.
    expect(journal.finishSubmission("a", "q1", { state: "failed", result: null, error: "late" }).state).toBe("completed")
  })

  it("tool calls move only forward; a rerun counts its attempts", () => {
    const { journal, storage } = setup()
    const key = { sessionId: "s1", executionId: "e1", callKey: "" }
    journal.startToolCall(call("e1"))
    expect(journal.restartToolCall(key).attempts).toBe(2)
    journal.failToolCall(key, "boom")
    expect(() => journal.completeToolCall(key, "ok")).toThrow(InvalidTransitionError)
    expect(() => journal.restartToolCall(key)).toThrow(InvalidTransitionError)
    expect(storage.getToolCall(key)).toMatchObject({ state: "failed", error: "boom", attempts: 2 })
  })

  it("commits a call's document writes with its result, or neither", () => {
    const { journal, storage } = setup()
    const Notes = defineDocument<{ lines: Array<string> }>({ kind: "notes", version: 1, scope: "agent", initial: () => ({ lines: [] }) })
    journal.startToolCall(call("e1"))
    journal.startToolCall(call("e2"))
    const write = (line: string): StagedDocumentWrite => ({
      document: Notes,
      agentId: "a",
      updates: [(draft: JsonObject) => ({ lines: [...(Array.isArray(draft.lines) ? draft.lines : []), line] })]
    })
    journal.completeToolCall({ sessionId: "s1", executionId: "e1", callKey: "" }, "ok", [write("first")])
    const broken: StagedDocumentWrite = { document: Notes, agentId: "a", updates: [() => { throw new Error("bad update") }] }
    expect(() => journal.completeToolCall({ sessionId: "s1", executionId: "e2", callKey: "" }, "ok", [write("second"), broken])).toThrow(/bad update/)
    expect(storage.getDocument("a", "notes")?.value).toEqual({ lines: ["first"] })
    expect(storage.getToolCall({ sessionId: "s1", executionId: "e2", callKey: "" })?.state).toBe("running")
  })

  it("forks copy the configuration and documents by their fork policy; resets start a new session", () => {
    const { journal, storage } = setup()
    journal.setSession("a", "s1", "t1")
    const Kept = defineDocument<{ n: number }>({ kind: "kept", version: 1, scope: "agent", initial: () => ({ n: 0 }) })
    const Fresh = defineDocument<{ n: number }>({ kind: "fresh", version: 1, scope: "agent", fork: "initial", initial: () => ({ n: 0 }) })
    journal.updateDocument(Kept, "a", [() => ({ n: 1 })])
    journal.updateDocument(Fresh, "a", [() => ({ n: 1 })])
    const fork = journal.forkAgent("a", "b", new Uint8Array([1]), { model: "m2" })
    expect(fork).toMatchObject({ id: "b", runtimeId: "r", model: "m2", sessionId: null, startCheckpoint: new Uint8Array([1]) })
    expect(storage.getDocument("b", "kept")?.value).toEqual({ n: 1 })
    expect(storage.getDocument("b", "fresh")).toBeNull()
    expect(journal.forkAgent("a", "b", null, {})).toBeNull()

    journal.resetContext("a", "earlier we planned the launch")
    expect(storage.getAgent("a")).toMatchObject({ sessionId: null, summary: "earlier we planned the launch" })
  })
})
