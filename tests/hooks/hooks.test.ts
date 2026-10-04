import { describe, expect, it } from "vitest"
import { defineDurableTool, type DurableEvent, type Json, type ToolHooks } from "../../src/index.js"
import { openFx, tempDb } from "../helpers.js"

const eventsOf = async (iterable: AsyncIterable<DurableEvent>) => {
  const out: Array<DurableEvent> = []
  for await (const event of iterable) out.push(event)
  return out
}

/** One call to `echo`, then the model reports what the tool returned (or the error). */
const run = async (hooks: ToolHooks) => {
  const received: Array<Json> = []
  const echo = defineDurableTool({
    name: "echo",
    replay: "unsafe",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: (input) => {
      received.push(input)
      return { echoed: input }
    }
  })
  const script = (req: { toolResults: ReadonlyArray<{ output: string; isError: boolean }> }) => {
    const result = req.toolResults[0]
    if (!result) return { toolCalls: [{ name: "echo", input: { text: "hi" } }] }
    return { text: `${result.isError ? "error" : "ok"}: ${result.output}` }
  }
  const fx = await openFx(tempDb(), script, { runtimes: { chat: { tools: [echo], hooks } } })
  const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
  const result = await (await agent.submit("go")).result()
  const events = await eventsOf(agent.events({ follow: false }))
  await fx.close()
  return { result, received, events }
}

describe("tool hooks", () => {
  it("beforeTool can block a call: it never starts, and the model gets the reason", async () => {
    const { result, received, events } = await run({ beforeTool: () => ({ block: "not allowed here" }) })
    expect(received).toEqual([])
    expect(result.text).toContain("not allowed here")
    expect(events.map((e) => e.type)).toContain("tool.blocked")
    expect(events.map((e) => e.type)).not.toContain("tool.started")
  })

  it("beforeTool can rewrite the input, and sees the call and its turn", async () => {
    const seen: Array<string> = []
    const { received } = await run({
      beforeTool: (call, context) => {
        seen.push(`${call.name} ${JSON.stringify(call.input)} ${context.agentId}`)
        return { input: { text: "rewritten" } }
      }
    })
    expect(seen).toEqual(['echo {"text":"hi"} a'])
    expect(received).toEqual([{ text: "rewritten" }])
  })

  it("beforeTool may take its time (a permission prompt) before allowing", async () => {
    const { received, result } = await run({
      beforeTool: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return undefined
      }
    })
    expect(received).toEqual([{ text: "hi" }])
    expect(result.text).toContain("ok")
  })

  it("afterTool can replace the result before it is journaled", async () => {
    const { result, events } = await run({ afterTool: () => ({ redacted: true }) })
    expect(result.text).toContain('"redacted":true')
    const completed = events.find((e) => e.type === "tool.completed")
    expect(completed).toBeDefined()
  })

  it("a failing afterTool keeps the original result, since the effect already happened", async () => {
    const { result } = await run({
      afterTool: () => {
        throw new Error("hook bug")
      }
    })
    expect(result.text).toContain("echoed")
  })

  it("a failing beforeTool blocks the call", async () => {
    const { received, result } = await run({
      beforeTool: () => {
        throw new Error("policy service down")
      }
    })
    expect(received).toEqual([])
    expect(result.text).toContain("policy service down")
  })
})
