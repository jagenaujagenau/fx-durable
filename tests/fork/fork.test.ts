import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AgentExistsError, NotFoundError, type DurableEvent } from "../../src/index.js"
import type { ScriptedRequest } from "../../src/testing/index.js"
import { openFx, tempDb } from "../helpers.js"

const isString = Schema.is(Schema.String)

/** Answers with every user message in the request: what the restored conversation contains. */
const echoHistory = (req: ScriptedRequest) => {
  const users = req.messages
    .filter((m) => m.role === "user")
    .map((m) => (isString(m.content) ? m.content : m.content.map((p) => p.text ?? "").join("")))
  return { text: users.join(" | ") }
}

const eventsOf = async (iterable: AsyncIterable<DurableEvent>) => {
  const out: Array<DurableEvent> = []
  for await (const event of iterable) out.push(event)
  return out
}

describe("fork", () => {
  it("continues from the conversation as it was after a given request", async () => {
    const fx = await openFx(tempDb(), echoHistory, { runtimes: { chat: {} } })
    const source = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const first = await source.submit("my name is Ada")
    await first.result()
    await (await source.submit("I like tea")).result()

    const fork = await source.fork("b", { after: first.id })
    const forked = await (await fork.submit("what do you know?")).result()
    expect(forked.text).toBe("my name is Ada | what do you know?")

    // The source is untouched and keeps its full history.
    const original = await (await source.submit("and you?")).result()
    expect(original.text).toBe("my name is Ada | I like tea | and you?")

    const events = await eventsOf(fork.events({ follow: false }))
    expect(events.find((e) => e.type === "agent.forked")?.payload).toEqual({ from: "a", checkpoint: 1 })
    await fx.close()
  })

  it("defaults to the latest checkpoint, and can change the model", async () => {
    const fx = await openFx(tempDb(), echoHistory, { runtimes: { chat: {} } })
    const source = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await source.submit("one")).result()
    await (await source.submit("two")).result()
    const fork = await source.fork("b", { model: "test/other", cwd: "/tmp/elsewhere" })
    expect((await fork.info()).model).toBe("test/other")
    expect((await fork.info()).cwd).toBe("/tmp/elsewhere")
    expect((await (await fork.submit("three")).result()).text).toBe("one | two | three")
    await fx.close()
  })

  it("rejects a taken id, an unknown request, and a missing checkpoint", async () => {
    const fx = await openFx(tempDb(), echoHistory, { runtimes: { chat: {} } })
    const source = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await fx.agent("taken", { runtime: "chat", model: "test/model" })
    await (await source.submit("one")).result()
    await expect(source.fork("taken")).rejects.toBeInstanceOf(AgentExistsError)
    await expect(source.fork("b", { after: "sub_nope" })).rejects.toBeInstanceOf(NotFoundError)
    await expect(source.fork("c", { checkpoint: 9 })).rejects.toBeInstanceOf(NotFoundError)
    await fx.close()
  })
})
