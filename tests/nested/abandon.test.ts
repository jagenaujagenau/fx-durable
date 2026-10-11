import { describe, expect, it } from "vitest"
import { defineDurableTool, defineSubagent, type AbandonedCall, type DurableAgent, type DurableEvent } from "../../src/index.js"
import type { Script, ScriptedRequest } from "../../src/testing/index.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

const eventsOf = async (agent: DurableAgent) => {
  const events: Array<DurableEvent> = []
  for await (const event of agent.events({ follow: false })) events.push(event)
  return events
}

/** Waits until cancelled; a retry after a crash waits again. */
const waitForever = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))

describe("abandoned calls", () => {
  it("cancels a subagent's request when the recovered turn moves on without it", async () => {
    const db = tempDb()
    const started = deferred()
    const work = defineDurableTool({
      name: "work",
      replay: { strategy: "idempotent" },
      resumeOnCall: true,
      execute: (_input, { signal }) => {
        started.resolve()
        return waitForever(signal)
      }
    })
    const helper = defineSubagent({ name: "helper", description: "Helps", runtime: "child" })
    const runtimes = { parent: { tools: [helper] }, child: { tools: [work] } }
    const child = (req: ScriptedRequest) => (req.step === 0 ? { toolCalls: [{ name: "work", input: {} }] } : { text: "done" })

    const fx = await openFx(db, (req) => (req.tools.includes("helper") ? { toolCalls: [{ name: "helper", input: { task: "work" } }] } : child(req)), {
      runtimes
    })
    const parent = await fx.agent("a", { runtime: "parent", model: "test/model" })
    const submission = await parent.submit("go")
    await started.promise
    await fx.close()

    // After the restart the model answers without calling the subagent again.
    const reopened = await openFx(db, (req) => (req.tools.includes("helper") ? { text: "moved on" } : child(req)), { runtimes })
    const again = await reopened.attach("a")
    await waitFor(async () => (await again.submissions()).find((s) => s.id === submission.id)?.state === "completed")

    const [childAgent] = (await reopened.listAgents()).filter((agent) => agent.id !== "a")
    const childSubmissions = await (await reopened.attach(childAgent!.id)).submissions()
    await waitFor(async () => (await (await reopened.attach(childAgent!.id)).submissions())[0]?.state === "cancelled")
    expect(childSubmissions).toHaveLength(1)

    const abandoned = (await eventsOf(again)).find((event) => event.type === "tool.abandoned")
    expect(abandoned?.payload).toMatchObject({ tool: "helper" })
    expect(await again.task(abandoned!.taskId!)).toMatchObject({ name: "helper", state: "cancelled" })
    await reopened.close()
  })

  it("after a clean restart, a subagent call made again resumes the same child", async () => {
    const db = tempDb()
    const started = deferred()
    let firstProcess = true
    const work = defineDurableTool({
      name: "work",
      replay: { strategy: "idempotent" },
      resumeOnCall: true,
      execute: (_input, { signal }) => {
        if (!firstProcess) return "worked"
        started.resolve()
        return waitForever(signal)
      }
    })
    const helper = defineSubagent({ name: "helper", description: "Helps", runtime: "child" })
    const runtimes = { parent: { tools: [helper] }, child: { tools: [work] } }
    const script: Script = (req) => {
      if (req.step > 0) return { text: `answer: ${req.toolResults[0]?.output ?? ""}` }
      return req.tools.includes("helper") ? { toolCalls: [{ name: "helper", input: { task: "work" } }] } : { toolCalls: [{ name: "work", input: {} }] }
    }
    const fx = await openFx(db, script, { runtimes })
    const submission = await (await fx.agent("a", { runtime: "parent", model: "test/model" })).submit("go")
    await started.promise
    await fx.close()

    firstProcess = false
    const reopened = await openFx(db, script, { runtimes })
    const again = await reopened.attach("a")
    await waitFor(async () => (await again.submissions()).find((s) => s.id === submission.id)?.state === "completed")
    expect((await again.submissions())[0]?.result?.text).toContain("worked")
    expect((await reopened.listAgents()).map((agent) => agent.id).filter((id) => id !== "a")).toHaveLength(1)
    expect((await eventsOf(again)).some((event) => event.type === "tool.abandoned" || event.type === "tool.outcome_unknown")).toBe(false)
    await reopened.close()
  })

  it("retries a failed abandon hook at the next resume, then records the call as cancelled", async () => {
    const db = tempDb()
    const started = deferred()
    const hooked: Array<AbandonedCall> = []
    let failHook = true
    const job = defineDurableTool({
      name: "job",
      replay: { strategy: "idempotent" },
      resumeOnCall: true,
      execute: (_input, { signal }) => {
        started.resolve()
        return waitForever(signal)
      },
      abandon: (call) => {
        hooked.push(call)
        if (failHook) throw new Error("job service unavailable")
      }
    })
    const runtimes = { r: { tools: [job] } }
    const fx = await openFx(db, (req) => (req.step === 0 ? { toolCalls: [{ name: "job", input: { n: 1 } }] } : { text: "?" }), { runtimes })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    const submission = await agent.submit("go")
    await started.promise
    await fx.close()

    const second = await openFx(db, () => ({ text: "moved on" }), { runtimes })
    const resumed = await second.attach("a")
    await waitFor(async () => (await eventsOf(resumed)).some((event) => event.type === "tool.abandon_failed"))
    expect((await resumed.submissions()).find((s) => s.id === submission.id)?.state).toBe("completed")
    const failed = (await eventsOf(resumed)).find((event) => event.type === "tool.abandon_failed")
    expect(failed?.payload).toMatchObject({ tool: "job", error: "job service unavailable" })
    expect((await resumed.task(failed!.taskId!)).state).toBe("interrupted")
    await second.close()

    failHook = false
    const third = await openFx(db, () => ({ text: "moved on" }), { runtimes })
    const task = await (await third.attach("a")).task(failed!.taskId!)
    expect(task).toMatchObject({ state: "cancelled", error: "abandoned: the turn ended without calling it again" })
    expect(hooked).toHaveLength(2)
    expect(hooked[1]).toEqual({ agentId: "a", turnId: task.turnId, taskId: task.id, input: { n: 1 }, idempotencyKey: task.idempotencyKey })
    expect(task.idempotencyKey).not.toBeNull()
    await third.close()
  })
})
