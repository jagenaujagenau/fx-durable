import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { defineDurableTool, SubmissionError, type JsonObject } from "../../src/index.js"
import { scriptedModel, type Script } from "../../src/testing/index.js"
import { crashAt, sandbox } from "../crash/harness.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

const countUsers: Script = (req) => {
  const users = req.messages.filter((m) => m.role === "user").length
  return { text: `user messages: ${users}` }
}

describe("checkpoint persistence", () => {
  it("process restart restores conversation state from the durable checkpoint", async () => {
    const db = tempDb()
    let fx = await openFx(db, countUsers, { runtimes: { coding: {} } })
    let agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    expect((await (await agent.submit("first")).result()).text).toBe("user messages: 1")
    await fx.close()

    fx = await openFx(db, countUsers, { runtimes: { coding: {} } })
    agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    expect((await (await agent.submit("second")).result()).text).toBe("user messages: 2")
    await fx.close()
  })
})

describe("runtime instructions", () => {
  it("instructions reach the model as a system message", async () => {
    const fx = await openFx(
      tempDb(),
      (req) => ({ text: req.messages.find((m) => m.role === "system") ? "has system" : "no system" }),
      { runtimes: { coding: { instructions: "You are careful." } } }
    )
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    expect((await (await agent.submit("hi")).result()).text).toBe("has system")
    await fx.close()
  })
})

describe("runtime registry", () => {
  it("a missing runtime parks the agent in configuration_error without discarding work", async () => {
    const box = sandbox("chat")
    expect(box.run({ crash: crashAt("model.before-request") }).signal).toBe("SIGKILL")

    const fx = await openFx(box.db, (req) => ({ text: `recovered: ${req.userText.includes("[fx-durable recovery]")}` }), {
      runtimes: {}
    })
    const agent = await fx.attach("engineer")
    const info = await agent.info()
    expect(info.state).toBe("configuration_error")
    expect(info.stateReason).toMatch(/coding/)

    await fx.registerRuntime("coding", {})
    const report = await fx.resume()
    expect(report.recoveredTurns).toHaveLength(1)
    const [submission] = await agent.submissions()
    await waitFor(async () => (await agent.info()).state === "idle")
    const final = (await agent.submissions())[0]!
    expect(final.id).toBe(submission!.id)
    expect(final.state).toBe("completed")
    expect(final.result?.text).toBe("recovered: true")
    await fx.close()
  })
})

describe("startup recovery", () => {
  it("recovery: manual waits for resume()", async () => {
    const box = sandbox("chat")
    expect(box.run({ crash: crashAt("model.before-request") }).signal).toBe("SIGKILL")
    const fx = await openFx(box.db, () => ({ text: "ok" }), { runtimes: { coding: {} }, recovery: "manual" })
    const agent = await fx.attach("engineer")
    expect((await agent.currentTurn())?.turn.state).toBe("running")
    const report = await fx.resume()
    expect(report.recoveredTurns).toHaveLength(1)
    await waitFor(async () => (await agent.info()).state === "idle")
    expect((await agent.submissions())[0]!.state).toBe("completed")
    await fx.close()
  })

  it("a graceful shutdown mid-turn leaves the turn recoverable", async () => {
    const db = tempDb()
    const started = deferred()
    const slow = defineDurableTool({
      name: "slow_read",
      replay: "safe",
      inputSchema: Schema.Struct({}),
      execute: (_input, { signal }) =>
        new Promise((resolve, reject) => {
          started.resolve()
          signal.addEventListener("abort", () => reject(new Error("aborted")))
          setTimeout(resolve, 60_000, "late")
        })
    })
    const script: Script = (req) =>
      req.toolResults.length === 0 && !req.userText.includes("[fx-durable recovery]")
        ? { toolCalls: [{ name: "slow_read", input: {} }] }
        : { text: "resumed after restart" }
    let fx = await openFx(db, script, { runtimes: { coding: { tools: [slow] } } })
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const submission = await agent.submit("go", { requestId: "r" })
    await started.promise
    await fx.close()

    fx = await openFx(db, script, { runtimes: { coding: { tools: [slow] } } })
    const again = await (await fx.attach("engineer")).submit("go", { requestId: "r" })
    expect(again.id).toBe(submission.id)
    expect((await again.result()).text).toBe("resumed after restart")
    await fx.close()
  })
})

describe("cancellation", () => {
  it("cancelling a queued submission means it never runs", async () => {
    const gate = deferred()
    const fx = await openFx(
      tempDb(),
      async (req) => {
        if (req.userText === "first") await gate.promise
        return { text: req.userText }
      },
      { runtimes: { coding: {} } }
    )
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const first = await agent.submit("first")
    const second = await agent.submit("second")
    await second.cancel()
    gate.resolve()
    expect((await first.result()).text).toBe("first")
    await expect(second.result()).rejects.toBeInstanceOf(SubmissionError)
    expect((await second.status()).state).toBe("cancelled")
    await fx.close()
  })

  it("cancelling a running safe tool cancels the task", async () => {
    const started = deferred()
    const wait = defineDurableTool({
      name: "wait",
      replay: "safe",
      execute: (_i, { signal }) =>
        new Promise((_resolve, reject) => {
          started.resolve()
          signal.addEventListener("abort", () => reject(new Error("aborted")))
        })
    })
    const fx = await openFx(tempDb(), (req) => (req.toolResults.length ? { text: "x" } : { toolCalls: [{ name: "wait", input: {} }] }), {
      runtimes: { coding: { tools: [wait] } }
    })
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const submission = await agent.submit("go")
    await started.promise
    await submission.cancel()
    await expect(submission.result()).rejects.toMatchObject({ state: "cancelled" })
    const events: Array<string> = []
    for await (const e of agent.events({ follow: false })) events.push(e.type)
    expect(events).toContain("tool.cancelled")
    expect(events).toContain("submission.cancelled")
    await waitFor(async () => (await agent.info()).state === "idle")
    await fx.close()
  })

  it("local cancellation does not prove an unsafe effect was cancelled: outcome_unknown", async () => {
    const started = deferred()
    const deploy = defineDurableTool({
      name: "deploy",
      replay: "unsafe",
      // Ignores its signal, like a remote system that already accepted the request.
      execute: () =>
        new Promise((resolve) => {
          started.resolve()
          setTimeout(resolve, 200, "deployed")
        })
    })
    const fx = await openFx(tempDb(), (req) => (req.toolResults.length ? { text: "x" } : { toolCalls: [{ name: "deploy", input: {} }] }), {
      runtimes: { coding: { tools: [deploy] } }
    })
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const submission = await agent.submit("deploy")
    await started.promise
    await submission.cancel()
    await expect(submission.result()).rejects.toMatchObject({ state: "cancelled" })
    const unknown: Array<JsonObject> = []
    for await (const e of agent.events({ follow: false })) {
      if (e.type === "tool.outcome_unknown") unknown.push(e.payload)
    }
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.reason).toBe("cancelled")
    // The agent keeps serving new work.
    expect((await (await agent.submit("next")).result()).text).toBeDefined()
    await fx.close()
  })
})

describe("agent execution and fibers", () => {
  it("one active turn per agent: submissions run sequentially in order", async () => {
    const spans: Array<{ name: string; start: number; end: number }> = []
    const work = defineDurableTool({
      name: "work",
      replay: "safe",
      inputSchema: Schema.Struct({ name: Schema.String }),
      execute: async ({ name }) => {
        const start = performance.now()
        await new Promise((r) => setTimeout(r, 20))
        spans.push({ name, start, end: performance.now() })
        return "ok"
      }
    })
    const fx = await openFx(
      tempDb(),
      (req) => (req.toolResults.length ? { text: req.userText } : { toolCalls: [{ name: "work", input: { name: req.userText } }] }),
      { runtimes: { coding: { tools: [work] } } }
    )
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const subs = await Promise.all(["a", "b", "c"].map((t) => agent.submit(t)))
    const results = await Promise.all(subs.map((s) => s.result()))
    expect(results.map((r) => r.text)).toEqual(["a", "b", "c"])
    expect(spans.map((s) => s.name)).toEqual(["a", "b", "c"])
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end)
    await fx.close()
  })

  it("different agents run in parallel", async () => {
    let inside = 0
    const both = deferred()
    const barrier = defineDurableTool({
      name: "barrier",
      replay: "safe",
      execute: async () => {
        inside++
        if (inside === 2) both.resolve()
        await Promise.race([both.promise, new Promise((_, rej) => setTimeout(() => rej(new Error("not parallel")), 5000))])
        return "met"
      }
    })
    const fx = await openFx(
      tempDb(),
      (req) => (req.toolResults.length ? { text: req.toolResults[0]!.output } : { toolCalls: [{ name: "barrier", input: {} }] }),
      { runtimes: { coding: { tools: [barrier] } } }
    )
    const a = await fx.agent("engineer-a", { runtime: "coding", model: "test/model" })
    const b = await fx.agent("engineer-b", { runtime: "coding", model: "test/model" })
    const [ra, rb] = await Promise.all([(await a.submit("go")).result(), (await b.submit("go")).result()])
    expect(ra.text).toContain("met")
    expect(rb.text).toContain("met")
    await fx.close()
  })

  it("tool failures are known failures, distinct from unknown outcomes", async () => {
    const flaky = defineDurableTool({
      name: "flaky",
      replay: "unsafe",
      execute: () => {
        throw new Error("HTTP 400: rejected")
      }
    })
    const fx = await openFx(
      tempDb(),
      (req) => (req.toolResults.length ? { text: `${req.toolResults[0]!.isError}:${req.toolResults[0]!.output}` } : { toolCalls: [{ name: "flaky", input: {} }] }),
      { runtimes: { coding: { tools: [flaky] } } }
    )
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const result = await (await agent.submit("go")).result()
    expect(result.text).toBe("true:HTTP 400: rejected")
    const types: Array<string> = []
    for await (const e of agent.events({ follow: false })) types.push(e.type)
    expect(types).toContain("tool.failed")
    expect(types).not.toContain("tool.outcome_unknown")
    await fx.close()
  })

  it("a model failure fails the turn and the agent keeps serving", async () => {
    let fail = true
    const fx = await openFx(tempDb(), () => ({ text: "fine" }), {
      runtimes: { coding: {} },
      fetch: async (input, init) => {
        if (fail) throw new TypeError("network down")
        return scriptedModel(() => ({ text: "fine" }))(input, init)
      }
    })
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    await expect((await agent.submit("one")).result()).rejects.toMatchObject({ state: "failed" })
    fail = false
    expect((await (await agent.submit("two")).result()).text).toBe("fine")
    await fx.close()
  })
})
