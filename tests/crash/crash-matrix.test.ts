/**
 * The crash matrix. Each case runs a real application process, SIGKILLs it at
 * a deterministic boundary, restarts it, and checks the core invariants:
 *
 *   unsafe effect occurs <= 1 time automatically
 *   safe effect may replay
 *   submission requestId never creates duplicate logical work
 *   unknown external state is represented as unknown
 *   completed committed work is never unnecessarily repeated
 *   recovery can itself be restarted
 */
import { describe, expect, it } from "vitest"
import { assertInvariants, crashAt, eventTypes, sandbox, type Sandbox } from "./harness.js"

const crashThenRecover = (box: Sandbox, plan: ReturnType<typeof crashAt>, scenario?: string) => {
  const crashed = box.run({ crash: plan, scenario })
  expect(crashed.signal, `expected SIGKILL at ${plan.point}\n${crashed.stderr}`).toBe("SIGKILL")
  const recovered = box.run({ scenario })
  expect(recovered.status, recovered.stderr).toBe(0)
  expect(recovered.output?.ok, JSON.stringify(recovered.output)).toBe(true)
  assertInvariants(box, expect)
  return recovered
}

const unknownTasks = (box: Sandbox, tool: string) =>
  box.query("SELECT id FROM tasks WHERE state = 'outcome_unknown' AND name = ?", tool)

describe("crash matrix: model boundaries", () => {
  it("before model request: the model call is redone, nothing else repeats", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("model.before-request", undefined, 1))
    expect(box.count("read_file")).toBe(1)
    expect(box.count("deploy")).toBe(1)
    expect(unknownTasks(box, "deploy")).toEqual([])
    expect(eventTypes(box)).toContain("model.interrupted")
  })

  it("during model stream: the partial response is discarded and redone", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("model.during-stream", undefined, 2))
    expect(box.count("read_file")).toBe(1)
    expect(box.count("deploy")).toBe(1)
  })

  it("after model response: committed tool work is reused, not re-executed", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("model.after-response", undefined, 2))
    expect(box.count("read_file")).toBe(1)
    expect(box.count("deploy")).toBe(1)
    expect(eventTypes(box)).toContain("tool.reused")
  })
})

describe("crash matrix: tool boundaries", () => {
  it("before tool intent commit: the effect never started, so it runs once after recovery", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("tool.before-persist", "deploy"))
    expect(box.count("deploy")).toBe(1)
    expect(box.count("read_file")).toBe(1)
    expect(unknownTasks(box, "deploy")).toEqual([])
  })

  it("after tool intent commit: unsafe intent without result is outcome_unknown, never replayed", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("tool.after-persist", "deploy"))
    // The effect did not actually run, but the runtime cannot know that: unknown means unknown.
    expect(box.count("deploy")).toBe(0)
    expect(unknownTasks(box, "deploy")).toHaveLength(1)
    expect(eventTypes(box)).toContain("tool.outcome_unknown_refused")
    expect(box.count("check_deploy")).toBe(1)
  })

  it("during safe tool: the safe tool is replayed", () => {
    const box = sandbox("tests")
    crashThenRecover(box, crashAt("test.during-safe-tool", "run_tests"))
    expect(box.count("run_tests")).toBe(2)
    expect(eventTypes(box)).toContain("tool.replayed")
  })

  it("after safe tool execution before result commit: replayed exactly once more", () => {
    const box = sandbox("tests")
    crashThenRecover(box, crashAt("tool.after-execute", "run_tests"))
    expect(box.count("run_tests")).toBe(2)
    const replays = box.query("SELECT id FROM tasks WHERE name = 'run_tests' AND parent_task_id IS NOT NULL AND state = 'completed'")
    expect(replays).toHaveLength(1)
  })

  it("during unsafe tool: outcome_unknown, effect not repeated", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("test.during-unsafe-tool", "deploy"))
    expect(box.count("deploy")).toBe(1)
    expect(unknownTasks(box, "deploy")).toHaveLength(1)
  })

  it("after unsafe effect before result commit: outcome_unknown, the model inspects instead of repeating", () => {
    const box = sandbox()
    const recovered = crashThenRecover(box, crashAt("tool.after-execute", "deploy"))
    expect(box.count("deploy")).toBe(1)
    expect(box.count("check_deploy")).toBe(1)
    expect(unknownTasks(box, "deploy")).toHaveLength(1)
    expect(recovered.output?.result?.text).toContain("inspected")
    const types = eventTypes(box)
    expect(types).toContain("tool.outcome_unknown")
    expect(types).toContain("tool.outcome_unknown_refused")
    expect(types).toContain("turn.recovered")
  })

  it("after tool result commit: completed work is never repeated", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("tool.after-result-persist", "deploy"))
    expect(box.count("deploy")).toBe(1)
    expect(box.count("read_file")).toBe(1)
    expect(unknownTasks(box, "deploy")).toEqual([])
  })

  it("idempotent tool: retried with the same idempotency key", () => {
    const box = sandbox("idempotent")
    crashThenRecover(box, crashAt("tool.after-execute", "charge"), "idempotent")
    const charges = box.ledgerEntries().filter((e) => e.effect === "charge")
    expect(charges).toHaveLength(2)
    expect(charges[0]!.detail.key).toBe(charges[1]!.detail.key)
    expect(charges[1]!.detail.replay).toBe(true)
  })
})

describe("crash matrix: checkpoint boundaries", () => {
  it("before checkpoint: the turn is redone from journal, tools reused", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("checkpoint.before-write"))
    expect(box.count("deploy")).toBe(1)
    expect(box.count("read_file")).toBe(1)
  })

  it("during checkpoint: the uncommitted checkpoint transaction rolls back", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("checkpoint.during-write"))
    expect(box.count("deploy")).toBe(1)
    expect(box.query("SELECT id FROM checkpoints")).toHaveLength(1)
  })

  it("after checkpoint: the committed turn is not recovered or repeated", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("checkpoint.after-write"))
    expect(box.count("deploy")).toBe(1)
    expect(eventTypes(box)).not.toContain("recovery.started")
  })
})

describe("crash matrix: submissions and turns", () => {
  it("after submission persist: restart with the same requestId attaches to the same submission", () => {
    const box = sandbox()
    const recovered = crashThenRecover(box, crashAt("submission.after-persist"))
    const subs = box.query("SELECT id FROM submissions")
    expect(subs).toHaveLength(1)
    expect(recovered.output?.submissionId).toBe(subs[0]!.id)
  })

  it("after turn start: the turn resumes on restart", () => {
    const box = sandbox()
    crashThenRecover(box, crashAt("turn.after-start"))
    expect(box.count("deploy")).toBe(1)
  })
})

describe("crash matrix: recovery itself", () => {
  for (const point of ["recovery.started", "recovery.after-classify", "recovery.before-continue"]) {
    it(`crash at ${point} during recovery: recovery restarts cleanly`, () => {
      const box = sandbox()
      expect(box.run({ crash: crashAt("tool.after-execute", "deploy") }).signal).toBe("SIGKILL")
      expect(box.run({ crash: crashAt(point) }).signal).toBe("SIGKILL")
      const final = box.run()
      expect(final.output?.ok, final.stderr).toBe(true)
      assertInvariants(box, expect)
      expect(box.count("deploy")).toBe(1)
      expect(unknownTasks(box, "deploy")).toHaveLength(1)
    })
  }

  it("crash during a safe replay: the replay is replayed again", () => {
    const box = sandbox("tests")
    expect(box.run({ crash: crashAt("tool.after-execute", "run_tests") }).signal).toBe("SIGKILL")
    expect(box.run({ crash: crashAt("recovery.during-replay", "run_tests") }).signal).toBe("SIGKILL")
    const final = box.run()
    expect(final.output?.ok, final.stderr).toBe(true)
    assertInvariants(box, expect)
    expect(box.count("run_tests")).toBeGreaterThanOrEqual(2)
    const completed = box.query("SELECT id FROM tasks WHERE name = 'run_tests' AND state = 'completed'")
    expect(completed).toHaveLength(1)
  })

  it("repeated crashes give up into needs_input instead of looping forever", () => {
    const box = sandbox()
    for (let i = 0; i < 4; i++) {
      expect(box.run({ crash: crashAt("model.before-request") }).signal).toBe("SIGKILL")
    }
    const final = box.run()
    expect(final.output?.ok).toBe(false)
    const agent = box.query("SELECT state FROM agents WHERE id = 'engineer'")
    expect(agent[0]!.state).toBe("needs_input")
    expect(eventTypes(box)).toContain("recovery.failed")
  })
})
