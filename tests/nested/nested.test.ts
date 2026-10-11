import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineDurableTool, defineSubagent, type DurableAgent, type Json, type ToolCall, type ToolCallRecord } from "../../src/index.js"
import type { Script, ScriptedRequest } from "../../src/testing/index.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

/** The model calls `tool` once with `input`, then answers with the result. */
const callOnce =
  (tool: string, input: Record<string, Json> = {}): Script =>
  (req: ScriptedRequest) =>
    req.step === 0 ? { toolCalls: [{ name: tool, input }] } : { text: req.toolResults[0]?.output ?? "" }

const add = defineDurableTool({
  name: "add",
  replay: "safe",
  callers: "tools",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: ({ a, b }) => a + b
})

/** The execution id of the last model call of each tool, as the tool saw it. */
const executions = new Map<string, string>()
const remember = (tool: string, executionId: string) => executions.set(tool, executionId)

/** The journaled calls under the model's last call of `tool`: that call first, then its nested calls. */
const callsOf = async (agent: DurableAgent, tool: string): Promise<ReadonlyArray<ToolCallRecord>> => {
  const { sessionId } = await agent.info()
  const executionId = executions.get(tool)
  return sessionId && executionId ? agent.toolCalls(sessionId, executionId) : []
}

describe("tools calling tools", () => {
  it("journals each nested call under its caller, with its own result", async () => {
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: async (_input, { executeTool, executionId }) => {
        remember("script", executionId)
        return [await executeTool("add", { a: 1, b: 2 }), await executeTool("add", { a: 3, b: 4 }, { key: "second" })]
      }
    })
    const fx = await openFx(tempDb(), callOnce("script"), { runtimes: { r: { tools: [script, add] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toBe("[3,7]")
    expect((await callsOf(agent, "script")).map((c) => [c.name, c.callKey, c.state, c.output])).toEqual([
      ["script", "", "completed", [3, 7]],
      ["add", "0", "completed", 3],
      ["add", "second", "completed", 7]
    ])
    await fx.close()
  })

  it("offers the model only tools it may call, and tools only tools they may call", async () => {
    const offered: Array<ReadonlyArray<string>> = []
    const modelOnly = defineDurableTool({ name: "model_only", replay: "safe", callers: "model", execute: () => "x" })
    const script = defineDurableTool({ name: "script", replay: "safe", execute: async (_input, { executeTool }) => executeTool("model_only", {}) })
    const fx = await openFx(tempDb(), (req) => (offered.push(req.tools), callOnce("script")(req)), { runtimes: { r: { tools: [script, add, modelOnly] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toContain("no tool named model_only can be called from a tool")
    expect(offered[0]).toEqual(["script", "model_only"])
    await fx.close()
  })

  it("runs the hooks for nested calls too; they see the caller, and may block or change them", async () => {
    const seen: Array<ToolCall> = []
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: async (_input, { executeTool }) => {
        const doubled = await executeTool("add", { a: 1, b: 1 })
        const blocked = await executeTool("add", { a: 100, b: 0 }).catch((cause: Error) => cause.message)
        return [doubled, blocked]
      }
    })
    const fx = await openFx(tempDb(), callOnce("script"), {
      runtimes: {
        r: {
          tools: [script, add],
          hooks: {
            beforeTool: (call) => {
              seen.push(call)
              if (call.name !== "add") return undefined
              return z.object({ a: z.number() }).parse(call.input).a === 100 ? { block: "too big" } : { input: { a: 2, b: 2 } }
            }
          }
        }
      }
    })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toBe('[4,"too big"]')
    expect(seen.map((c) => [c.name, c.caller?.tool ?? null])).toEqual([
      ["script", null],
      ["add", "script"],
      ["add", "script"]
    ])
    await fx.close()
  })

  it("refuses a nested key reused for a different call", async () => {
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: async (_input, { executeTool }) => {
        await executeTool("add", { a: 1, b: 1 }, { key: "k" })
        return executeTool("add", { a: 2, b: 2 }, { key: "k" })
      }
    })
    const fx = await openFx(tempDb(), callOnce("script"), { runtimes: { r: { tools: [script, add] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toContain("nested call key k was used by another call")
    await fx.close()
  })

  it("keeps a running call's progress in the journal", async () => {
    const release = deferred()
    const long = defineDurableTool({
      name: "long",
      replay: "safe",
      execute: async (_input, { progress, executionId }) => {
        remember("long", executionId)
        progress("step 1\n")
        progress("step 2\n")
        await release.promise
        return "done"
      }
    })
    const fx = await openFx(tempDb(), callOnce("long"), { runtimes: { r: { tools: [long] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    const submission = await agent.submit("go")
    await waitFor(async () => (await callsOf(agent, "long"))[0]?.progress === "step 1\nstep 2\n")
    release.resolve()
    await submission.result()
    await fx.close()
  })
})

describe("subagents", () => {
  it("hands a task to a child agent named after the call, and returns its answer", async () => {
    const delegate = defineSubagent({ name: "delegate", description: "Hand off a task", runtime: "worker" })
    const script: Script = (req) => {
      if (!req.tools.includes("delegate")) return { text: `worker did: ${req.userText}` }
      return req.step === 0 ? { toolCalls: [{ name: "delegate", input: { task: "count the files" } }] } : { text: `parent got ${req.toolResults[0]?.output}` }
    }
    const fx = await openFx(tempDb(), script, { runtimes: { boss: { tools: [delegate] }, worker: {} } })
    const agent = await fx.agent("boss", { runtime: "boss", model: "test/model" })
    const answer = (await (await agent.submit("go")).result()).text
    expect(answer).toContain("worker did: count the files")
    const children = (await fx.listAgents()).filter((a) => a.id !== "boss")
    expect(children).toHaveLength(1)
    // Named after the model's call, as the tool card knows it.
    expect(children[0]?.id).toMatch(/^boss\/delegate\/call_[a-z0-9]+$/)
    await fx.close()
  })
})
