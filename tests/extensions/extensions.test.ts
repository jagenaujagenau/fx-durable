import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineDocument, defineDurableTool, defineExtension, type DurableTool, type Json } from "../../src/index.js"
import { isJsonString } from "../../src/domain/json.js"
import type { Script, ScriptedRequest } from "../../src/testing/index.js"
import { openFx, tempDb } from "../helpers.js"

const systemOf = (req: ScriptedRequest) =>
  req.messages.filter((m) => m.role === "system").map((m) => (isJsonString(m.content) ? m.content : "")).join("\n")

const echo = (name: string, output: Json = name): DurableTool => defineDurableTool({ name, replay: "safe", execute: () => output })

/** Records each first-step request; the model answers with text, or calls `call` when the user asks for it by name. */
const recording = () => {
  const requests: Array<ScriptedRequest> = []
  const script: Script = (req) => {
    if (req.step === 0) requests.push(req)
    const tool = /^call (\S+)/.exec(req.userText)?.[1]
    if (tool && req.step === 0) return { toolCalls: [{ name: tool, input: {} }] }
    return { text: req.toolResults.map((r) => String(r.output)).join(" ") || "ok" }
  }
  return { requests, script, last: () => requests.at(-1)! }
}

describe("extensions", () => {
  it("adds a runtime's extensions: their tools and instructions, after the runtime's own", async () => {
    const files = defineExtension({ name: "files", tools: [echo("read")], instructions: "Read before you edit." })
    const model = recording()
    const fx = await openFx(tempDb(), model.script, {
      runtimes: { r: { tools: [echo("own")], instructions: "You are terse.", extensions: [files] } }
    })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("hi")).result()
    expect(model.last().tools).toEqual(["own", "read"])
    expect(systemOf(model.last())).toBe("You are terse.\n\nRead before you edit.")
    expect(await agent.extensions()).toEqual(["files"])
    await fx.close()
  })

  it("lets an agent select its extensions, from its next turn, and forks keep the selection", async () => {
    const files = defineExtension({ name: "files", tools: [echo("read")] })
    const web = defineExtension({ name: "web", tools: [echo("fetch")] })
    const model = recording()
    const fx = await openFx(tempDb(), model.script, { runtimes: { r: { extensions: [files] } } })
    await fx.installExtension(web)
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("one")).result()
    expect(model.last().tools).toEqual(["read"])

    await agent.setExtensions([web, "files", "not-installed"])
    expect(await agent.extensions()).toEqual(["web", "files"])
    await (await agent.submit("two")).result()
    expect(model.last().tools).toEqual(["fetch", "read"])

    const fork = await agent.fork("b")
    expect(await fork.extensions()).toEqual(["web", "files"])

    await agent.setExtensions(null)
    await (await agent.submit("three")).result()
    expect(model.last().tools).toEqual(["read"])
    await fx.close()
  })

  it("reloads an extension by installing another with its name, and falls back to the runtime's on uninstall", async () => {
    const model = recording()
    const v1 = defineExtension({ name: "greeter", tools: [echo("greet", "hello v1")] })
    const fx = await openFx(tempDb(), model.script, { runtimes: { r: { extensions: [v1] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("call greet")).result()).text).toBe("hello v1")

    await fx.installExtension(defineExtension({ name: "greeter", tools: [echo("greet", "hello v2")], instructions: "Greet warmly." }))
    expect((await (await agent.submit("call greet")).result()).text).toBe("hello v2")
    expect(systemOf(model.last())).toBe("Greet warmly.")

    await fx.uninstallExtension("greeter")
    expect((await (await agent.submit("call greet")).result()).text).toBe("hello v1")
    expect(systemOf(model.last())).toBe("")
    await fx.close()
  })

  it("applies a runtime registered again under its id from the agent's next turn", async () => {
    const model = recording()
    const fx = await openFx(tempDb(), model.script, { runtimes: { r: { instructions: "Version one." } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("one")).result()
    await fx.registerRuntime("r", { instructions: "Version two.", tools: [echo("added")] })
    await (await agent.submit("two")).result()
    expect(systemOf(model.last())).toBe("Version two.")
    expect(model.last().tools).toEqual(["added"])
    await fx.close()
  })

  it("renders instructions before each turn, from documents", async () => {
    const Todos = defineDocument<{ items: Array<string> }>({ kind: "test.todos", version: 1, scope: "agent", initial: () => ({ items: [] }) })
    const todo = defineExtension({
      name: "todo",
      tools: [
        defineDurableTool({
          name: "todo",
          replay: "safe",
          inputSchema: z.object({ item: z.string() }),
          execute: async ({ item }, { documents }) => void (await documents.update(Todos, (todos) => void todos.items.push(item)))
        })
      ],
      instructions: async ({ document }) => {
        const { items } = await document(Todos)
        return items.length === 0 ? undefined : `Your todo list:\n${items.map((item) => `- ${item}`).join("\n")}`
      }
    })
    const requests: Array<ScriptedRequest> = []
    const script: Script = (req) => {
      if (req.step === 0) requests.push(req)
      return req.userText === "remember" && req.step === 0 ? { toolCalls: [{ name: "todo", input: { item: "fix the build" } }] } : { text: "ok" }
    }
    const fx = await openFx(tempDb(), script, { runtimes: { r: { extensions: [todo] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("remember")).result()
    expect(systemOf(requests[0]!)).toBe("")
    await (await agent.submit("what next?")).result()
    expect(systemOf(requests[1]!)).toBe("Your todo list:\n- fix the build")
    await fx.close()
  })

  it("runs the runtime's hooks, then each extension's: inputs chain, the first block wins", async () => {
    const seen: Array<Json> = []
    const record = defineDurableTool({
      name: "record",
      replay: "safe",
      execute: (input) => {
        seen.push(input)
        return "recorded"
      }
    })
    const redact = defineExtension({
      name: "redact",
      hooks: { beforeTool: (call) => ({ input: { ...Object(call.input), secret: "[redacted]" } }) }
    })
    const guard = defineExtension({
      name: "guard",
      hooks: {
        beforeTool: (call) => (Object(call.input).stop === true ? { block: "stopped by guard" } : undefined),
        afterTool: (_call, output) => `${String(output)} and audited`
      }
    })
    const calls: Array<Record<string, Json>> = [{ secret: "s3cret" }, { stop: true }]
    const script: Script = (req) => (req.step === 0 ? { toolCalls: [{ name: "record", input: calls.shift() ?? {} }] } : { text: String(req.toolResults[0]?.output) })
    const fx = await openFx(tempDb(), script, {
      runtimes: { r: { tools: [record], hooks: { beforeTool: (call) => ({ input: { ...Object(call.input), by: "runtime" } }) }, extensions: [redact, guard] } }
    })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("one")).result()).text).toBe("recorded and audited")
    expect(seen).toEqual([{ secret: "[redacted]", by: "runtime" }])
    await (await agent.submit("two")).result()
    expect(seen).toHaveLength(1)
    await fx.close()
  })

  it("refuses a request while two extensions bring tools with the same name, and takes it once fixed", async () => {
    const fx = await openFx(tempDb(), () => ({ text: "ok" }), {
      runtimes: { r: { extensions: [defineExtension({ name: "a", tools: [echo("x")] }), defineExtension({ name: "b", tools: [echo("x")] })] } }
    })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await expect(agent.submit("hi")).rejects.toThrow("duplicate tool name: x")
    expect(await agent.submissions()).toEqual([])

    await fx.installExtension(defineExtension({ name: "b", tools: [echo("y")] }))
    expect((await (await agent.submit("hi")).result()).text).toBe("ok")
    await fx.close()
  })
})
