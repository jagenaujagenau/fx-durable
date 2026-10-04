/**
 * The Journal is plain synchronous code, so durable-state correctness is
 * tested here directly: no Effect runtime, an in-memory SQLite database, and
 * a manual clock.
 */
import { describe, expect, it } from "vitest"
import { InvalidTransitionError, InterruptedError } from "../../src/domain/errors.js"
import {
  AgentState as AgentStateSchema,
  SubmissionState as SubmissionStateSchema,
  TaskState as TaskStateSchema,
  TurnState as TurnStateSchema,
  type TaskType,
  type TurnRecord
} from "../../src/domain/schema.js"
import {
  AgentTransitions,
  SubmissionTransitions,
  TaskTransitions,
  TurnTransitions
} from "../../src/domain/state-machine.js"
import { manualClock } from "../../src/durable/clock.js"
import { Journal } from "../../src/durable/journal.js"
import { openSqliteStorage } from "../../src/durable/sqlite/storage.js"
import type { ReplayPolicyName } from "../../src/domain/schema.js"

const T0 = 1_700_000_000_000

const open = () => {
  const clock = manualClock(T0)
  let n = 0
  const journal = new Journal({
    storage: openSqliteStorage({ path: ":memory:" }),
    nextId: (prefix) => `${prefix}_${++n}`,
    clock
  })
  return { journal, clock, storage: journal.storage }
}

const events = (journal: Journal, agentId = "a") => journal.storage.eventsAfter(agentId, 0, 1000)
const eventTypes = (journal: Journal, agentId = "a") => events(journal, agentId).map((e) => e.type)

/** An agent with a queued submission. */
const withSubmission = (journal: Journal, requestId: string | null = null) => {
  journal.upsertAgent("a", { runtime: "r", model: "m" })
  return journal.submit("a", requestId, "do it").record
}

/** An agent with a running turn. */
const withTurn = (journal: Journal): TurnRecord => {
  const submission = withSubmission(journal)
  const turn = journal.startTurn(submission, "exec_1")
  if (!turn) throw new Error("turn did not start")
  return turn
}

const toolTask = (journal: Journal, turn: TurnRecord, policy: ReplayPolicyName, name = "tool") =>
  journal.startTask({
    turnId: turn.id,
    agentId: "a",
    type: "tool",
    name,
    input: { x: 1 },
    replayPolicy: policy,
    event: { type: "tool.started", payload: { tool: name } }
  })

// ---------------------------------------------------------------------------
// Every transition of every state machine
// ---------------------------------------------------------------------------

describe("state transitions: every (from, to) pair", () => {
  const pairs = <S extends string>(states: ReadonlyArray<S>, table: Readonly<Record<S, ReadonlyArray<S>>>) =>
    states.flatMap((from) => states.map((to) => ({ from, to, allowed: table[from].includes(to) })))

  describe("tasks", () => {
    for (const { from, to, allowed } of pairs(TaskStateSchema.literals, TaskTransitions)) {
      it(`${from} → ${to}: ${allowed ? "allowed" : "rejected"}`, () => {
        const { journal, storage } = open()
        const turn = withTurn(journal)
        storage.insertTask({
          id: "task_x",
          turnId: turn.id,
          agentId: "a",
          parentTaskId: null,
          type: "tool" satisfies TaskType,
          state: from,
          name: "tool",
          input: null,
          inputHash: null,
          replayPolicy: "safe",
          idempotencyKey: null,
          attempt: 1,
          metadata: null,
          startedAt: null
        })
        const before = events(journal).length
        const transition = () => journal.transitionTask("task_x", to, {}, { type: "tool.completed" })
        if (allowed) {
          expect(transition().state).toBe(to)
          expect(events(journal).length).toBe(before + 1)
        } else {
          expect(transition).toThrow(InvalidTransitionError)
          expect(storage.getTask("task_x")?.state).toBe(from)
          expect(events(journal).length).toBe(before)
        }
      })
    }
  })

  describe("turns", () => {
    for (const { from, to, allowed } of pairs(TurnStateSchema.literals, TurnTransitions)) {
      it(`${from} → ${to}: ${allowed ? "allowed" : "rejected"}`, () => {
        const { journal, storage } = open()
        const submission = withSubmission(journal)
        storage.insertTurn({
          id: "turn_x",
          agentId: "a",
          submissionId: submission.id,
          state: from,
          attempt: 1,
          executorId: null,
          baseCheckpointSeq: null,
          startedAt: null,
          completedAt: null
        })
        const transition = () => journal.transitionTurn("turn_x", to, {}, { type: "turn.completed" })
        if (allowed) {
          transition()
          expect(storage.getTurn("turn_x")?.state).toBe(to)
        } else {
          expect(transition).toThrow(InvalidTransitionError)
          expect(storage.getTurn("turn_x")?.state).toBe(from)
        }
      })
    }
  })

  describe("submissions", () => {
    for (const { from, to, allowed } of pairs(SubmissionStateSchema.literals, SubmissionTransitions)) {
      it(`${from} → ${to}: ${allowed ? "allowed" : "rejected"}`, () => {
        const { journal, storage, clock } = open()
        const submission = withSubmission(journal)
        storage.updateSubmission(submission.id, { state: from }, journal.now())
        clock.advance(1000)
        const transition = () => journal.transitionSubmission(submission.id, to)
        if (allowed) {
          transition()
          expect(storage.getSubmission(submission.id)).toMatchObject({ state: to, updatedAt: new Date(T0 + 1000) })
        } else {
          expect(transition).toThrow(InvalidTransitionError)
          expect(storage.getSubmission(submission.id)?.state).toBe(from)
        }
      })
    }
  })

  describe("agents", () => {
    for (const { from, to, allowed } of pairs(AgentStateSchema.literals, AgentTransitions)) {
      it(`${from} → ${to}: ${allowed ? "allowed" : "rejected"}`, () => {
        const { journal, storage } = open()
        journal.upsertAgent("a", { runtime: "r", model: "m" })
        storage.updateAgent("a", { state: from }, journal.now())
        const transition = () => journal.transitionAgent("a", to, "reason")
        if (allowed) {
          transition()
          expect(storage.getAgent("a")).toMatchObject({ state: to, stateReason: "reason" })
        } else {
          expect(transition).toThrow(InvalidTransitionError)
          expect(storage.getAgent("a")?.state).toBe(from)
        }
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe("transactions", () => {
  it("a composite transition that fails midway leaves no partial state", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    journal.transitionSubmission(turn.submissionId, "completed", { result: { text: "", stopReason: "end", usage: null } })
    const before = events(journal).length
    // failTurn moves the turn first, then the (already completed) submission: invalid.
    expect(() => journal.failTurn(turn, "boom")).toThrow(InvalidTransitionError)
    expect(storage.getTurn(turn.id)?.state).toBe("running")
    expect(storage.getAgent("a")?.state).toBe("running")
    expect(events(journal).length).toBe(before)
  })

  it("nested journal transactions roll back with the outer one", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    expect(() =>
      journal.transaction(() => {
        journal.cancelTurn(turn)
        throw new Error("outer")
      })
    ).toThrow("outer")
    expect(storage.getTurn(turn.id)?.state).toBe("running")
    expect(storage.getSubmission(turn.submissionId)?.state).toBe("running")
  })

  it("rejects a transaction body that returns a Promise", () => {
    const { journal, storage } = open()
    journal.upsertAgent("a", { runtime: "r", model: "m" })
    expect(() =>
      journal.transaction(() => {
        journal.transitionAgent("a", "running")
        return Promise.resolve()
      })
    ).toThrow(/synchronous/)
    expect(storage.getAgent("a")?.state).toBe("idle")
  })

  it("committed-event listeners see only committed events, in order", () => {
    const { journal } = open()
    const seen: Array<string> = []
    journal.onCommitted((event) => seen.push(`${event.sequence}:${event.type}`))
    journal.upsertAgent("a", { runtime: "r", model: "m" })
    expect(() =>
      journal.transaction(() => {
        journal.transitionAgent("a", "running", null, { type: "agent.updated" })
        throw new Error("no")
      })
    ).toThrow()
    journal.transitionAgent("a", "running", null, { type: "agent.updated" })
    expect(seen).toEqual(["1:agent.created", "2:agent.updated"])
  })
})

// ---------------------------------------------------------------------------
// Events, clock, checkpoints
// ---------------------------------------------------------------------------

describe("events and time", () => {
  it("a turn's events are ordered and gap-free, stamped by the injected clock", () => {
    const { journal, clock } = open()
    const submission = withSubmission(journal)
    clock.advance(5_000)
    journal.startTurn(submission, "exec_1")
    const log = events(journal)
    expect(log.map((e) => e.type)).toEqual(["agent.created", "submission.created", "submission.started", "turn.started"])
    expect(log.map((e) => e.sequence)).toEqual([1, 2, 3, 4])
    expect(log[0]!.createdAt).toEqual(new Date(T0))
    expect(log[3]!.createdAt).toEqual(new Date(T0 + 5_000))
    expect(log.slice(2).every((e) => e.submissionId === submission.id)).toBe(true)
  })
})

describe("checkpoints", () => {
  const completion = (journal: Journal, turn: TurnRecord) => {
    const checkpointTask = journal.startTask({ turnId: turn.id, agentId: "a", type: "checkpoint" })
    const agent = journal.storage.getAgent("a")
    if (!agent) throw new Error("no agent")
    return {
      turn,
      agent,
      checkpointTaskId: checkpointTask.id,
      checkpoint: new Uint8Array([1, 2, 3]),
      result: { text: "done", stopReason: "end_turn", usage: null }
    }
  }

  it("completeTurn writes the checkpoint and completes turn and submission together", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    const checkpoint = journal.completeTurn(completion(journal, turn))
    expect(checkpoint.sequence).toBe(1)
    expect(storage.getTurn(turn.id)?.state).toBe("completed")
    expect(storage.getSubmission(turn.submissionId)).toMatchObject({ state: "completed", result: { text: "done" } })
    expect(eventTypes(journal).slice(-3)).toEqual(["checkpoint.created", "turn.completed", "submission.completed"])
  })

  it("a failure before commit leaves neither the checkpoint nor the completion", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    expect(() =>
      journal.completeTurn(completion(journal, turn), () => {
        throw new Error("crash inside the transaction")
      })
    ).toThrow("crash inside")
    expect(storage.latestCheckpoint("a")).toBeNull()
    expect(storage.getTurn(turn.id)?.state).toBe("running")
  })

  it("checkpoint sequences advance per turn, and a stale base is rejected", () => {
    const { journal, storage } = open()
    const first = withTurn(journal)
    journal.completeTurn(completion(journal, first))
    const next = journal.submit("a", null, "again").record
    const second = journal.startTurn(next, "exec_1")
    if (!second) throw new Error("no turn")
    expect(second.baseCheckpointSeq).toBe(1)
    // A turn claiming to start from no checkpoint conflicts with checkpoint #1.
    expect(() => journal.completeTurn(completion(journal, { ...second, baseCheckpointSeq: null }))).toThrow(/sequence conflict/)
    expect(storage.latestCheckpoint("a")?.sequence).toBe(1)
    expect(journal.completeTurn(completion(journal, second)).sequence).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Unknown outcomes and recovery
// ---------------------------------------------------------------------------

describe("outcome unknown", () => {
  it("classification follows the persisted replay policy", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    const unsafe = toolTask(journal, turn, "unsafe", "deploy")
    const safe = toolTask(journal, turn, "safe", "read")
    const idempotent = toolTask(journal, turn, "idempotent", "charge")
    const model = journal.startTask({ turnId: turn.id, agentId: "a", type: "model" })
    const done = toolTask(journal, turn, "unsafe", "done")
    journal.transitionTask(done.id, "completed", { output: "ok" })

    expect(journal.classifyTurnTasks(turn.id, "process_terminated")).toEqual([unsafe.id])
    expect(storage.getTask(unsafe.id)?.state).toBe("outcome_unknown")
    expect(storage.getTask(safe.id)?.state).toBe("interrupted")
    expect(storage.getTask(idempotent.id)?.state).toBe("interrupted")
    expect(storage.getTask(model.id)?.state).toBe("interrupted")
    expect(storage.getTask(done.id)?.state).toBe("completed")

    const unknown = events(journal).filter((e) => e.type === "tool.outcome_unknown")
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.payload).toMatchObject({ taskId: unsafe.id, tool: "deploy", input: { x: 1 }, reason: "process_terminated" })
  })

  it("classification is idempotent", () => {
    const { journal } = open()
    const turn = withTurn(journal)
    toolTask(journal, turn, "unsafe")
    journal.classifyTurnTasks(turn.id, "process_terminated")
    const before = events(journal).length
    expect(journal.classifyTurnTasks(turn.id, "process_terminated")).toEqual([])
    expect(events(journal).length).toBe(before)
  })

  it("an outcome-unknown task can never become completed or failed", () => {
    const { journal } = open()
    const turn = withTurn(journal)
    const task = toolTask(journal, turn, "unsafe")
    journal.markOutcomeUnknown(task, "executor_lost")
    expect(() => journal.transitionTask(task.id, "completed")).toThrow(InvalidTransitionError)
    expect(() => journal.transitionTask(task.id, "failed")).toThrow(InvalidTransitionError)
  })

  it("refusing a repeat marks the task acknowledged and records why", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    const task = toolTask(journal, turn, "unsafe", "deploy")
    journal.markOutcomeUnknown(task, "process_terminated")
    journal.refuseUnknownOutcomeRepeat(task, turn.submissionId, { x: 1 })
    expect(storage.getTask(task.id)?.acknowledged).toBe(true)
    expect(eventTypes(journal).at(-1)).toBe("tool.outcome_unknown_refused")
  })
})

describe("recovery", () => {
  it("a full recovery cycle: begin, classify, resume", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    const deploy = toolTask(journal, turn, "unsafe", "deploy")
    journal.beginRecovery(turn, "process_terminated")
    expect(storage.getTurn(turn.id)?.state).toBe("interrupted")
    expect(storage.getAgent("a")?.state).toBe("recovering")
    const unknown = journal.classifyTurnTasks(turn.id, "process_terminated")
    journal.resumeTurn(turn, "exec_2", [], unknown)
    expect(storage.getTurn(turn.id)).toMatchObject({ state: "running", attempt: 2, executorId: "exec_2" })
    expect(storage.getAgent("a")?.state).toBe("running")
    expect(storage.getTask(deploy.id)?.state).toBe("outcome_unknown")
  })

  it("journal-only recovery is idempotent", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal) // executor exec_1 was never registered → gone
    toolTask(journal, turn, "unsafe", "deploy")
    const first = journal.recoverJournal()
    expect(first).toHaveLength(1)
    expect(first[0]!.unknown).toHaveLength(1)
    const before = events(journal).length
    expect(journal.recoverJournal()).toEqual([])
    expect(events(journal).length).toBe(before)
    expect(storage.getTurn(turn.id)?.state).toBe("interrupted")
  })

  it("repeated recovery converges: after giving up, nothing is left to recover", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    toolTask(journal, turn, "unsafe")
    journal.beginRecovery(turn, "process_terminated")
    journal.abandonRecovery({ ...turn, attempt: 4 }, "process_terminated")
    expect(storage.getTurn(turn.id)?.state).toBe("failed")
    expect(storage.getSubmission(turn.submissionId)?.state).toBe("failed")
    expect(storage.getAgent("a")?.state).toBe("needs_input")
    expect(storage.unfinishedTurns()).toEqual([])
    expect(storage.unfinishedTasks()).toEqual([])
    expect(journal.recoverJournal()).toEqual([])
  })

  it("a missing runtime parks the turn without discarding work", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    journal.parkTurn(turn, "coding-v1", "runtime missing")
    expect(storage.getTurn(turn.id)?.state).toBe("interrupted")
    expect(storage.getAgent("a")).toMatchObject({ state: "configuration_error", stateReason: "runtime missing" })
    expect(storage.getSubmission(turn.submissionId)?.state).toBe("running")
  })
})

// ---------------------------------------------------------------------------
// Submissions, cancellation, model calls
// ---------------------------------------------------------------------------

describe("submissions", () => {
  it("a duplicate request id resolves to the same submission with one event", () => {
    const { journal } = open()
    journal.upsertAgent("a", { runtime: "r", model: "m" })
    const first = journal.submit("a", "deploy-42", "Deploy")
    const second = journal.submit("a", "deploy-42", "Deploy (again)")
    expect(second).toEqual({ record: first.record, created: false })
    expect(eventTypes(journal).filter((t) => t === "submission.created")).toHaveLength(1)
  })

  it("startTurn refuses submissions that are no longer runnable", () => {
    const { journal } = open()
    const cancelled = withSubmission(journal)
    journal.requestCancellation(cancelled)
    expect(journal.storage.getSubmission(cancelled.id)?.state).toBe("cancelled")
    expect(journal.startTurn(cancelled, "exec_1")).toBeNull()
  })

  it("cancelling a running submission only records the request", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    const submission = storage.getSubmission(turn.submissionId)
    if (!submission) throw new Error("no submission")
    journal.requestCancellation(submission)
    expect(storage.getSubmission(turn.submissionId)).toMatchObject({ state: "running", cancelRequested: true })
  })

  it("upsertAgent keeps identity stable and records real changes only", () => {
    const { journal, storage } = open()
    expect(journal.upsertAgent("a", { runtime: "r", model: "m", cwd: "/repo" })).toBe("created")
    expect(journal.upsertAgent("a", { runtime: "r", model: "m" })).toBe("unchanged")
    expect(journal.upsertAgent("a", { runtime: "r", model: "m2" })).toBe("updated")
    expect(storage.getAgent("a")).toMatchObject({ model: "m2", cwd: "/repo", createdAt: new Date(T0) })
    expect(eventTypes(journal)).toEqual(["agent.created", "agent.updated"])
  })
})

describe("model calls", () => {
  const call = (turn: TurnRecord) => ({ agentId: "a", submissionId: turn.submissionId, turnId: turn.id, attempt: 1, model: "m" })

  it("intent is committed before the request, the result after", () => {
    const { journal, storage, clock } = open()
    const turn = withTurn(journal)
    const taskId = journal.modelStarted(call(turn))
    expect(storage.getTask(taskId)?.state).toBe("running")
    clock.advance(1200)
    journal.modelCompleted(call(turn), taskId, {
      text: "hi",
      toolCalls: [],
      finishReason: "stop",
      inputTokens: 10,
      outputTokens: 2,
      durationMs: 1200
    })
    expect(storage.getTask(taskId)).toMatchObject({ state: "completed", completedAt: new Date(T0 + 1200) })
    expect(eventTypes(journal).slice(-2)).toEqual(["model.started", "model.completed"])
  })

  it("refuses to start once cancellation was requested", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    const submission = storage.getSubmission(turn.submissionId)
    if (!submission) throw new Error("no submission")
    journal.requestCancellation(submission)
    expect(() => journal.modelStarted(call(turn))).toThrow(InterruptedError)
  })

  it("a failure after the task settled is ignored", () => {
    const { journal, storage } = open()
    const turn = withTurn(journal)
    const taskId = journal.modelStarted(call(turn))
    journal.modelFailed(call(turn), taskId, "HTTP 500")
    journal.modelFailed(call(turn), taskId, "again")
    expect(storage.getTask(taskId)).toMatchObject({ state: "failed", error: "HTTP 500" })
  })
})
