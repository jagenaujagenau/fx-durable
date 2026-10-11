import { describe, expect, it } from "vitest"
import { defineDurableTool } from "../../src/index.js"
import { openFx, tempDb } from "../helpers.js"

describe("agents on libfx sessions", () => {
  it("answers a request, keeps the conversation, and records usage", async () => {
    const add = defineDurableTool({ name: "add", replay: "safe", execute: () => 42 })
    const fx = await openFx(
      tempDb(),
      (req) => (req.step === 0 && req.userText.includes("add") ? { toolCalls: [{ name: "add", input: {} }] } : { text: `echo: ${req.userText} ${req.toolResults.map((r) => r.output).join("")}` }),
      { runtimes: { r: { tools: [add] } } }
    )
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    const first = await agent.submit("please add")
    expect(await first.result()).toMatchObject({ text: "echo: please add 42", stopReason: "end_turn" })
    const second = await agent.submit("again", { requestId: "r-2" })
    expect((await second.result()).text).toBe("echo: again ")
    expect((await agent.submit("again", { requestId: "r-2" })).created).toBe(false)

    const [latest] = await agent.submissions()
    expect(latest).toMatchObject({ id: "r-2", state: "completed" })
    expect((await agent.info()).sessionId).toMatch(/.+/)
    expect((await agent.usage()).total.turns).toBe(2)
    const calls = await agent.toolCalls((await agent.info()).sessionId!, (await fx.taskGraph()).nodes[0]?.id ?? "x")
    expect(calls).toEqual([])
    await fx.close()
  })
})
