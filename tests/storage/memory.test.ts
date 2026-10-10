import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineDurableTool, openMemoryStorage, type DurableEvent } from "../../src/index.js"
import { isJsonString } from "../../src/domain/json.js"
import type { ScriptedRequest } from "../../src/testing/index.js"
import { openFx } from "../helpers.js"

const eventsOf = async (iterable: AsyncIterable<DurableEvent>) => {
  const out: Array<DurableEvent> = []
  for await (const event of iterable) out.push(event)
  return out
}

/** "add" calls the tool once, then answers with its result; anything else echoes the user messages. */
const script = (req: ScriptedRequest) => {
  if (req.userText === "add" && req.step === 0) return { toolCalls: [{ name: "add", input: { a: 2, b: 3 } }] }
  if (req.userText === "add") return { text: `sum: ${req.toolResults[0]?.output}` }
  const users = req.messages.filter((m) => m.role === "user").map((m) => (isJsonString(m.content) ? m.content : m.content.map((p) => p.text ?? "").join("")))
  return { text: users.join(" | ") }
}

const add = defineDurableTool({
  name: "add",
  replay: "safe",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: (input) => ({ sum: input.a + input.b })
})

describe("DurableFx on memory storage", () => {
  it("runs tool-using turns, keeps the conversation, and forks", async () => {
    const fx = await openFx("unused", script, { storage: openMemoryStorage(), runtimes: { calc: { tools: [add] } } })
    const agent = await fx.agent("a", { runtime: "calc", model: "test/model" })

    expect((await (await agent.submit("add")).result()).text).toBe('sum: {"sum":5}')
    expect((await (await agent.submit("hello")).result()).text).toBe("add | hello")

    const types = (await eventsOf(agent.events({ follow: false }))).map((e) => e.type)
    expect(types).toContain("tool.completed")
    expect(types).toContain("checkpoint.created")
    expect(types.filter((t) => t === "submission.completed")).toHaveLength(2)

    const fork = await agent.fork("b")
    expect((await (await fork.submit("again")).result()).text).toBe("add | hello | again")
    await fx.close()
  })
})
