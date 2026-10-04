import { describe, expect, it } from "vitest"
import {
  assertAgentTransition,
  assertSubmissionTransition,
  assertTaskTransition,
  assertTurnTransition,
  TaskTransitions
} from "../../src/domain/state-machine.js"
import { recoveryActionFor } from "../../src/tools/replay-policy.js"

describe("task state machine", () => {
  it("allows the documented transitions", () => {
    expect(() => assertTaskTransition("pending", "running")).not.toThrow()
    expect(() => assertTaskTransition("running", "completed")).not.toThrow()
    expect(() => assertTaskTransition("running", "outcome_unknown")).not.toThrow()
    expect(() => assertTaskTransition("running", "interrupted")).not.toThrow()
    expect(() => assertTaskTransition("interrupted", "outcome_unknown")).not.toThrow()
  })

  it("rejects invalid transitions as programmer errors", () => {
    expect(() => assertTaskTransition("completed", "running")).toThrow()
    expect(() => assertTaskTransition("outcome_unknown", "completed")).toThrow()
    expect(() => assertTaskTransition("pending", "completed")).toThrow()
    expect(() => assertTaskTransition("failed", "completed")).toThrow()
  })

  it("terminal states have no exits — unknown can never silently become success", () => {
    for (const s of ["completed", "failed", "cancelled", "outcome_unknown"] as const) {
      expect(TaskTransitions[s]).toEqual([])
    }
  })
})

describe("other state machines", () => {
  it("turns", () => {
    expect(() => assertTurnTransition("running", "interrupted")).not.toThrow()
    expect(() => assertTurnTransition("interrupted", "running")).not.toThrow()
    expect(() => assertTurnTransition("completed", "running")).toThrow()
  })
  it("submissions", () => {
    expect(() => assertSubmissionTransition("queued", "running")).not.toThrow()
    expect(() => assertSubmissionTransition("queued", "completed")).toThrow()
    expect(() => assertSubmissionTransition("completed", "failed")).toThrow()
  })
  it("agents", () => {
    expect(() => assertAgentTransition("idle", "running")).not.toThrow()
    expect(() => assertAgentTransition("running", "recovering")).not.toThrow()
    expect(() => assertAgentTransition("recovering", "needs_input")).not.toThrow()
    expect(() => assertAgentTransition("failed", "needs_input")).toThrow()
  })
})

describe("replay policy classification", () => {
  it("safe → replay, idempotent → retry with same key, unsafe → outcome_unknown", () => {
    expect(recoveryActionFor("safe")).toBe("replay")
    expect(recoveryActionFor("idempotent")).toBe("retry_with_same_key")
    expect(recoveryActionFor("unsafe")).toBe("mark_outcome_unknown")
  })
})
