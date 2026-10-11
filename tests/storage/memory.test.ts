import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineDurableTool, openMemoryStorage, type FxStreamLine } from "../../src/index.js"
import { isJsonString } from "../../src/domain/json.js"
import type { ScriptedRequest } from "../../src/testing/index.js"
import { openFx } from "../helpers.js"

const collect = async (iterable: AsyncIterable<FxStreamLine>) => {
  const out: Array<FxStreamLine> = []
  for await (const line of iterable) out.push(line)
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

describe("DurableFx on memory storage (sessions in memory)", () => {
  it("runs tool-using turns, keeps the conversation, replays its events, and forks", async () => {
    const fx = await openFx("unused", script, { storage: openMemoryStorage(), runtimes: { calc: { tools: [add] } } })
    const agent = await fx.agent("a", { runtime: "calc", model: "test/model" })

    expect((await (await agent.submit("add")).result()).text).toBe('sum: {"sum":5}')
    expect((await (await agent.submit("hello")).result()).text).toBe("add | hello")

    const lines = await collect(agent.events({ follow: false }))
    expect(lines.filter((l) => l.type === "turn_end")).toHaveLength(2)
    expect(lines.find((l) => l.type === "tool_start")).toMatchObject({ name: "add" })
    // Each line carries a cursor to reconnect from.
    const cursor = lines.find((l) => l.type === "turn_end")?.cursor ?? 0
    expect((await collect(agent.events({ after: cursor, follow: false }))).every((l) => (l.cursor ?? 0) > cursor)).toBe(true)

    const fork = await agent.fork("b")
    expect((await (await fork.submit("again")).result()).text).toBe("add | hello | again")
    expect((await (await agent.submit("original")).result()).text).toBe("add | hello | original")
    await fx.close()
  })
})
