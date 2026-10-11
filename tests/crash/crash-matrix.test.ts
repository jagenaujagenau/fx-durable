/**
 * The crash matrix. Each case runs a real application process, SIGKILLs it at
 * a deterministic boundary, runs it again, and checks the invariants:
 *
 *   an unsafe effect occurs at most once automatically
 *   a safe effect may run again; an idempotent one runs again with the same key
 *   a requestId never creates duplicate logical work
 *   unknown external state is represented as unknown
 *   completed work is never repeated
 *   a tool's document writes happen exactly when its result does
 */
import { describe, expect, it } from "vitest"
import { assertInvariants, crashAt, sandbox, toolCalls, type Sandbox } from "./harness.js"
import type { CrashPlan } from "../../src/runtime/crash.js"

const crashThenRecover = (box: Sandbox, plan: CrashPlan) => {
  const crashed = box.run({ crash: plan })
  expect(crashed.signal, `expected SIGKILL at ${plan.point}\n${crashed.stderr}`).toBe("SIGKILL")
  const recovered = box.run()
  expect(recovered.status, recovered.stderr).toBe(0)
  expect(recovered.output?.ok, JSON.stringify(recovered.output)).toBe(true)
  assertInvariants(box, expect)
  return recovered
}

describe("crash matrix: requests", () => {
  it("after the request is recorded, before libfx stores it: it is prompted again and runs once", () => {
    const box = sandbox("deploy")
    crashThenRecover(box, crashAt("submission.after-persist"))
    expect(box.count("read_file")).toBe(1)
    expect(box.count("deploy")).toBe(1)
  })

  it("after libfx stored the request: the turn runs once", () => {
    const box = sandbox("deploy")
    crashThenRecover(box, crashAt("submission.after-accept"))
    expect(box.count("deploy")).toBe(1)
  })
})

describe("crash matrix: tool calls", () => {
  it("during an unsafe call: it is never run again, and is recorded and reported as unknown", () => {
    const box = sandbox("deploy")
    const recovered = crashThenRecover(box, crashAt("test.during-unsafe-tool", "deploy"))
    expect(box.count("deploy")).toBe(1)
    expect(toolCalls(box).find((c) => c.name === "deploy")).toMatchObject({ state: "outcome_unknown" })
    expect(recovered.output?.result?.text).toContain("may have partly run")
  })

  it("after an unsafe call returned, before its result was stored: unknown, never run again", () => {
    const box = sandbox("deploy")
    crashThenRecover(box, crashAt("tool.after-execute", "deploy"))
    expect(box.count("deploy")).toBe(1)
    expect(toolCalls(box).find((c) => c.name === "deploy")).toMatchObject({ state: "outcome_unknown" })
  })

  it("after an unsafe call's result was stored: it does not run again, and keeps its recorded result", () => {
    const box = sandbox("deploy")
    const recovered = crashThenRecover(box, crashAt("tool.after-result-persist", "deploy"))
    expect(box.count("deploy")).toBe(1)
    expect(toolCalls(box).find((c) => c.name === "deploy")).toMatchObject({ state: "completed", attempts: 1 })
    // libfx never runs an unsafe call again; it tells the model the call may have partly run.
    expect(recovered.output?.result?.text).toContain("may have partly run")
  })

  it("during a safe call: it runs again and completes", () => {
    const box = sandbox("deploy")
    crashThenRecover(box, crashAt("test.during-safe-tool", "read_file"))
    expect(box.count("read_file")).toBe(2)
    expect(toolCalls(box).find((c) => c.name === "read_file")).toMatchObject({ state: "completed", attempts: 2 })
    expect(box.count("deploy")).toBe(1)
  })

  it("during an idempotent call: it runs again with the same idempotency key", () => {
    const box = sandbox("charge")
    crashThenRecover(box, crashAt("test.during-idempotent-tool", "charge"))
    const charges = box.ledgerEntries().filter((e) => e.effect === "charge")
    expect(charges).toHaveLength(2)
    expect(charges[0]!.detail.key).toBe(charges[1]!.detail.key)
  })
})

describe("crash matrix: documents", () => {
  it("a write staged by a call cut off by a crash is not stored; the rerun stores it once", () => {
    const box = sandbox("note")
    crashThenRecover(box, crashAt("test.after-document-update", "note"))
    expect(box.count("note")).toBe(2)
    const [doc] = box.query("SELECT value FROM documents WHERE kind = 'test.notes'")
    expect(JSON.parse(String(doc!.value)).data).toEqual({ lines: ["remember"] })
  })
})

describe("crash matrix: nested calls", () => {
  it("a crash after a nested unsafe call completed: the caller runs again and gets the stored result", () => {
    const box = sandbox("nested")
    crashThenRecover(box, crashAt("test.in-release", "release"))
    expect(box.count("release")).toBe(2)
    expect(box.count("deploy")).toBe(1)
    expect(toolCalls(box)).toEqual([
      { name: "release", key: "", state: "completed", attempts: 2 },
      { name: "deploy", key: "0", state: "completed", attempts: 1 }
    ])
  })

  it("a crash during a nested unsafe call: the caller runs again and the nested call is refused as unknown", () => {
    const box = sandbox("nested")
    crashThenRecover(box, crashAt("test.during-unsafe-tool", "deploy"))
    expect(box.count("deploy")).toBe(1)
    expect(toolCalls(box)).toEqual([
      { name: "release", key: "", state: "failed", attempts: 2 },
      { name: "deploy", key: "0", state: "outcome_unknown", attempts: 1 }
    ])
  })
})

describe("crash matrix: subagents", () => {
  it("a crash inside a subagent's work continues the same subagent instead of starting another", () => {
    const box = sandbox("subagent")
    crashThenRecover(box, crashAt("test.during-work", "work"))
    expect(box.count("work")).toBe(2)
    expect(box.query("SELECT id FROM agents ORDER BY id").map((r) => String(r.id))).toHaveLength(2)
  })
})
