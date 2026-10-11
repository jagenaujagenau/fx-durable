import { describe, expect, it } from "vitest"
import { usageOf, type SubmissionRecord, type TurnUsage } from "../../src/index.js"
import { openFx, tempDb } from "../helpers.js"

const finished = (model: string, usage: TurnUsage | null): SubmissionRecord => ({
  id: `q-${Math.random()}`,
  agentId: "a",
  requestId: null,
  sessionId: "s",
  sessionStore: "t",
  model,
  content: "hi",
  state: "completed",
  result: { text: "ok", stopReason: "end_turn", usage },
  error: null,
  createdAt: new Date(0),
  updatedAt: new Date(0)
})

describe("usageOf", () => {
  const turns = [
    finished("m/a", { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 100, reasoningTokens: 50 }),
    finished("m/a", { inputTokens: 500, outputTokens: 100 }),
    finished("m/b", { inputTokens: 300, outputTokens: 30 }),
    finished("m/b", null)
  ]

  it("totals tokens per model and overall", () => {
    const report = usageOf(turns)
    expect(report.byModel.get("m/a")).toEqual({
      turns: 2,
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
      reasoningTokens: 50,
      costUsd: null
    })
    expect(report.byModel.get("m/b")).toMatchObject({ turns: 1, inputTokens: 300 })
    expect(report.total).toMatchObject({ turns: 3, inputTokens: 1800, outputTokens: 330, costUsd: null })
  })

  it("prices uncached input, cache reads, cache writes, and output separately", () => {
    const report = usageOf(turns, { "m/a": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, "m/b": { input: 1, output: 5 } })
    // m/a: uncached 800 × 3 + 600 × 0.3 + 100 × 3.75 + 300 × 15; m/b: 300 × 1 + 30 × 5.
    expect(report.byModel.get("m/a")?.costUsd).toBeCloseTo((800 * 3 + 600 * 0.3 + 100 * 3.75 + 300 * 15) / 1e6)
    expect(report.total.costUsd).toBeCloseTo((800 * 3 + 600 * 0.3 + 100 * 3.75 + 300 * 15 + 300 + 150) / 1e6)
  })
})

describe("agent.usage() and fx.usage()", () => {
  it("totals each agent's turns, and all agents together", async () => {
    const fx = await openFx(tempDb(), () => ({ text: "hi", usage: { input: 120, output: 7, cacheRead: 20, reasoning: 2 } }), { runtimes: { r: {} } })
    const a = await fx.agent("a", { runtime: "r", model: "m/a" })
    const b = await fx.agent("b", { runtime: "r", model: "m/b" })
    await (await a.submit("one")).result()
    await (await a.submit("two")).result()
    await (await b.submit("one")).result()
    expect((await a.usage()).total).toMatchObject({ turns: 2 })
    expect((await a.usage()).total.inputTokens).toBeGreaterThan(0)
    const all = await fx.usage({ prices: { "m/a": { input: 1, output: 1 }, "m/b": { input: 1, output: 1 } } })
    expect(all.total.turns).toBe(3)
    expect([...all.byModel.keys()].sort()).toEqual(["m/a", "m/b"])
    expect(all.total.costUsd).toBeGreaterThan(0)
    await fx.close()
  })
})
