import { describe, expect, it } from "vitest"
import { defineDurableTool, type DurableEvent, type Json, type Transport, type TransportContext } from "../../src/index.js"
import { scriptedModel } from "../../src/testing/index.js"
import { openFx, tempDb } from "../helpers.js"

const script = () => ({ text: "hello" })

const eventsOf = async (iterable: AsyncIterable<DurableEvent>) => {
  const out: Array<DurableEvent> = []
  for await (const event of iterable) out.push(event)
  return out
}

describe("model transport", () => {
  it("passes the durable model call's context to the transport", async () => {
    const contexts: Array<TransportContext> = []
    const scripted = scriptedModel(script)
    const fetch: Transport = (input, init, context) => {
      if (context) contexts.push(context)
      return scripted(input, init)
    }
    const fx = await openFx(tempDb(), script, { fetch, runtimes: { chat: {} } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const submission = await agent.submit("hi")
    await submission.result()
    const events = await eventsOf(agent.events({ follow: false }))
    const started = events.find((e) => e.type === "model.started")

    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ agentId: "a", submissionId: submission.id, model: "test/model", taskId: started?.taskId })
    await fx.close()
  })

  it("journals the model call when `finish` arrives, even if the body never closes", async () => {
    const scripted = scriptedModel(script)
    // A model response body that delivers the whole stream and then stays open,
    // like a connection the reader abandons after the `finish` part. Only model
    // calls (those with a context); libfx also fetches the model catalog.
    const fetch: Transport = async (input, init, context) => {
      const response = await scripted(input, init)
      if (!context) return response
      const bytes = new Uint8Array(await response.arrayBuffer())
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(bytes),
        pull: () => new Promise<void>(() => undefined)
      })
      return new Response(body, { status: response.status, headers: response.headers })
    }
    const fx = await openFx(tempDb(), script, { fetch, runtimes: { chat: {} } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("hi")).result()
    const types = (await eventsOf(agent.events({ follow: false }))).map((e) => e.type)

    expect(types).toContain("model.completed")
    expect(types.indexOf("model.completed")).toBeLessThan(types.indexOf("turn.completed"))
    await fx.close()
  })

  it("accepts tool inputs the model pretty-printed (libfx cannot parse multi-line tool input)", async () => {
    const received: Array<Json> = []
    const todo = defineDurableTool({
      name: "todo",
      replay: "safe",
      inputSchema: { type: "object", properties: { items: { type: "array" } } },
      execute: (input) => {
        received.push(input)
        return { ok: true }
      }
    })
    const sse = (parts: ReadonlyArray<object>) => parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")
    const finish = (unified: string) => ({ type: "finish", finishReason: { unified }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } })
    let calls = 0
    const fetch: Transport = async (_input, _init, context) => {
      if (!context) return new Response("{}", { headers: { "content-type": "application/json" } })
      calls++
      const body =
        calls === 1
          ? sse([
              { type: "tool-call", toolCallId: "call_1", toolName: "todo", input: JSON.stringify({ items: [{ content: "a" }, { content: "b" }] }, null, 2) },
              finish("tool-calls")
            ])
          : sse([{ type: "text-delta", id: "t", delta: "done" }, finish("stop")])
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    const fx = await openFx(tempDb(), script, { fetch, runtimes: { chat: { tools: [todo] } } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const result = await (await agent.submit("hi")).result()

    expect(result.text).toBe("done")
    expect(received).toEqual([{ items: [{ content: "a" }, { content: "b" }] }])
    await fx.close()
  })
})
