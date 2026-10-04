import { describe, expect, it } from "vitest"
import { defineDurableTool, defineSubagent, NotFoundError, type DurableEvent } from "../../src/index.js"
import { openFx, tempDb } from "../helpers.js"

const echo = defineDurableTool({
  name: "echo",
  replay: "safe",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  execute: (input) => ({ echoed: input })
})

const script = (req: { toolResults: ReadonlyArray<unknown> }) =>
  req.toolResults.length === 0 ? { toolCalls: [{ name: "echo", input: { text: "hi" } }] } : { text: "done" }

describe("DurableAgent.task", () => {
  it("returns a journaled tool call with its input and output, scoped to the agent", async () => {
    const fx = await openFx(tempDb(), script, { runtimes: { chat: { tools: [echo] } } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const other = await fx.agent("b", { runtime: "chat", model: "test/model" })
    await (await agent.submit("go")).result()

    const events: Array<DurableEvent> = []
    for await (const event of agent.events({ follow: false })) events.push(event)
    const taskId = events.find((e) => e.type === "tool.completed")?.taskId ?? ""

    const task = await agent.task(taskId)
    expect(task).toMatchObject({ type: "tool", name: "echo", state: "completed", input: { text: "hi" }, output: { echoed: { text: "hi" } } })
    await expect(other.task(taskId)).rejects.toBeInstanceOf(NotFoundError)
    await fx.close()
  })
})

describe("defineDurableTool reuse", () => {
  it("allows reuse: false only on replay-safe tools", () => {
    expect(defineDurableTool({ name: "look", replay: "safe", reuse: false, inputSchema: { type: "object" }, execute: () => null }).reuse).toBe(false)
    expect(echo.reuse).toBe(true)
    expect(() => defineDurableTool({ name: "ship", replay: "unsafe", reuse: false, inputSchema: { type: "object" }, execute: () => null })).toThrow(/reuse: false/)
  })
})

describe("resumeOnCall and subagents", () => {
  it("allows resumeOnCall only with the idempotent policy", () => {
    expect(() => defineDurableTool({ name: "wait", replay: "safe", resumeOnCall: true, inputSchema: { type: "object" }, execute: () => null })).toThrow(/resumeOnCall/)
    const subagent = defineSubagent({ name: "research", description: "Research", runtime: "researcher" })
    expect(subagent.resumeOnCall).toBe(true)
    expect(subagent.replay).toEqual({ strategy: "idempotent" })
  })

  it("fails clearly when the subagent tool runs outside an open runtime", async () => {
    const subagent = defineSubagent({ name: "research", description: "Research", runtime: "researcher" })
    const context = { agentId: "a", turnId: "t", taskId: "k", idempotencyKey: "k", signal: new AbortController().signal, replay: false, progress: () => undefined }
    await expect(subagent.run({ task: "x" }, context)).rejects.toThrow(/not part of an open DurableFx/)
  })
})

