import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineDurableTool, usageOf, type DurableEvent, type JsonObject, type Transport } from "../../src/index.js"
import { scriptedModel, type Script } from "../../src/testing/index.js"
import { openFx, tempDb } from "../helpers.js"

let sequence = 0
const event = (type: string, payload: JsonObject): DurableEvent => ({
  id: `e${++sequence}`,
  agentId: "a",
  submissionId: null,
  turnId: null,
  taskId: null,
  sequence,
  type,
  payload,
  createdAt: new Date(0)
})

const completed = (model: string, usage: JsonObject) => event("model.completed", { model, usage })

describe("usageOf", () => {
  const events = [
    completed("m/a", { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 100, reasoningTokens: 50 }),
    completed("m/a", { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }),
    // Journaled before cache and reasoning counts were recorded.
    completed("m/b", { inputTokens: 300, outputTokens: 30 }),
    event("model.failed", { model: "m/a", error: "HTTP 400" }),
    event("model.interrupted", { model: "m/b", reason: "process_terminated" }),
    event("tool.completed", { tool: "x" })
  ]

  it("totals tokens per model and overall", () => {
    const report = usageOf(events)
    expect(report.byModel.get("m/a")).toEqual({
      requests: 2,
      failedRequests: 1,
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
      reasoningTokens: 50,
      costUsd: null
    })
    expect(report.byModel.get("m/b")).toMatchObject({ requests: 1, failedRequests: 1, inputTokens: 300, cacheReadTokens: 0 })
    expect(report.total).toMatchObject({ requests: 3, failedRequests: 2, inputTokens: 1800, outputTokens: 330, costUsd: null })
  })

  it("prices uncached input, cache reads, cache writes, and output separately", () => {
    const prices = { "m/a": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, "m/b": { input: 1, output: 2 } }
    const report = usageOf(events, prices)
    // m/a: uncached 800 * 3 + 600 * 0.3 + 100 * 3.75 + 300 * 15, per million tokens
    expect(report.byModel.get("m/a")?.costUsd).toBeCloseTo((800 * 3 + 600 * 0.3 + 100 * 3.75 + 300 * 15) / 1e6, 12)
    // m/b: cache prices default to the input price
    expect(report.byModel.get("m/b")?.costUsd).toBeCloseTo((300 * 1 + 30 * 2) / 1e6, 12)
    expect(report.total.costUsd).toBeCloseTo((800 * 3 + 600 * 0.3 + 100 * 3.75 + 300 * 15 + 300 + 60) / 1e6, 12)
    expect(usageOf(events, new Map(Object.entries(prices))).total.costUsd).toBe(report.total.costUsd)
  })

  it("leaves the total cost unknown when one model has no price", () => {
    const report = usageOf(events, { "m/a": { input: 3, output: 15 } })
    expect(report.byModel.get("m/a")?.costUsd).not.toBeNull()
    expect(report.byModel.get("m/b")?.costUsd).toBeNull()
    expect(report.total.costUsd).toBeNull()
  })

  it("costs nothing for a model whose requests all failed", () => {
    expect(usageOf([event("model.failed", { model: "m/x", error: "boom" })]).total.costUsd).toBe(0)
  })
})

describe("agent.usage() and fx.usage()", () => {
  const add = defineDurableTool({
    name: "add",
    replay: "safe",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    execute: (input) => ({ sum: input.a + input.b })
  })

  /** "add" makes two model requests (tool call, then answer); anything else makes one. */
  const script: Script = (req) => {
    const usage = { input: 1000, output: 100, cacheRead: 400, cacheWrite: 0, reasoning: 20 }
    if (req.userText === "add" && req.step === 0) return { toolCalls: [{ name: "add", input: { a: 1, b: 2 } }], usage }
    return { text: "done", usage }
  }

  it("totals each agent's model requests, and all agents together", async () => {
    const fx = await openFx(tempDb(), script, { runtimes: { calc: { tools: [add] } } })
    const a = await fx.agent("a", { runtime: "calc", model: "test/model" })
    const b = await fx.agent("b", { runtime: "calc", model: "test/other" })
    await (await a.submit("add")).result()
    await (await b.submit("hello")).result()

    const prices = { "test/model": { input: 2, output: 10, cacheRead: 0.2 }, "test/other": { input: 1, output: 5 } }
    const usageA = await a.usage({ prices })
    expect(usageA.total).toEqual({
      requests: 2,
      failedRequests: 0,
      inputTokens: 2000,
      outputTokens: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      reasoningTokens: 40,
      costUsd: (1200 * 2 + 800 * 0.2 + 200 * 10) / 1e6
    })
    expect([...usageA.byModel.keys()]).toEqual(["test/model"])

    const all = await fx.usage({ prices })
    expect(all.total.requests).toBe(3)
    expect([...all.byModel.keys()].sort()).toEqual(["test/model", "test/other"])
    expect(all.total.costUsd).toBeCloseTo(usageA.total.costUsd! + (600 * 1 + 400 * 1 + 100 * 5) / 1e6, 12)

    // A fork starts with no usage of its own.
    const fork = await a.fork("a2")
    expect((await fork.usage()).total.requests).toBe(0)
    await fx.close()
  })

  it("counts a rejected model request as failed", async () => {
    const scripted = scriptedModel(script)
    let calls = 0
    const fetch: Transport = (input, init, context) => {
      if (context && ++calls === 1) return Promise.resolve(new Response("bad request", { status: 400 }))
      return scripted(input, init)
    }
    const fx = await openFx(tempDb(), script, { fetch, runtimes: { calc: { tools: [add] } } })
    const agent = await fx.agent("a", { runtime: "calc", model: "test/model" })
    await (await agent.submit("hello")).result().catch(() => undefined)
    await (await agent.submit("hello again")).result()
    expect((await agent.usage()).total).toMatchObject({ requests: 1, failedRequests: 1, inputTokens: 1000 })
    await fx.close()
  })
})
