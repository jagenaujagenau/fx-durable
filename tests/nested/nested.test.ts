import { describe, expect, it } from "vitest"
import { z } from "zod"
import { ToolBlockedError, defineDurableTool, type DurableAgent, type Json, type TaskRecord, type ToolCall } from "../../src/index.js"
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

const toolTasks = async (agent: DurableAgent) => {
  const tasks: Array<TaskRecord> = []
  for await (const event of agent.events({ follow: false })) {
    if (event.type === "tool.started" && event.taskId) tasks.push(await agent.task(event.taskId))
  }
  return tasks
}

describe("tools calling tools", () => {
  it("journals each nested call as a task owned by its caller", async () => {
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: async (_input, { executeTool }) => [await executeTool("add", { a: 1, b: 2 }), await executeTool("add", { a: 3, b: 4 })]
    })
    const fx = await openFx(tempDb(), callOnce("script"), { runtimes: { r: { tools: [script, add] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toBe("[3,7]")

    const [caller, first, second] = await toolTasks(agent)
    expect(caller).toMatchObject({ name: "script", callerTaskId: null, state: "completed" })
    expect(first).toMatchObject({ name: "add", callerTaskId: caller!.id, callKey: "0", output: 3, state: "completed" })
    expect(second).toMatchObject({ name: "add", callerTaskId: caller!.id, callKey: "1", output: 7 })
    await fx.close()
  })

  it("offers the model only tools it may call, and tools only tools they may call", async () => {
    const offered: Array<ReadonlyArray<string>> = []
    const modelOnly = defineDurableTool({ name: "model_only", replay: "safe", callers: "model", execute: () => "x" })
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: async (_input, { executeTool }) => {
        await executeTool("model_only", {})
      }
    })
    const fx = await openFx(
      tempDb(),
      (req) => {
        offered.push(req.tools)
        return callOnce("script")(req)
      },
      { runtimes: { r: { tools: [script, add, modelOnly] } } }
    )
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("go")).result()
    expect(offered[0]).toEqual(["script", "model_only"])
    const [caller] = await toolTasks(agent)
    expect(caller).toMatchObject({ state: "failed", error: "no tool named model_only can be called from a tool" })
    await fx.close()
  })

  it("runs the runtime's hooks, which see the caller", async () => {
    const seen: Array<ToolCall> = []
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: async (_input, { executeTool }) => {
        try {
          return await executeTool("add", { a: 1, b: 1 })
        } catch (error) {
          return error instanceof ToolBlockedError ? `blocked: ${error.message}` : "other error"
        }
      }
    })
    const fx = await openFx(tempDb(), callOnce("script"), {
      runtimes: {
        r: {
          tools: [script, add],
          hooks: {
            beforeTool: (call) => {
              seen.push(call)
              return call.caller ? { block: "no nested adds" } : undefined
            }
          }
        }
      }
    })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toBe("blocked: no nested adds")
    expect(seen.map((c) => c.caller?.tool ?? null)).toEqual([null, "script"])
    await fx.close()
  })

  it("nests", async () => {
    const outer = defineDurableTool({ name: "outer", replay: "safe", execute: (_i, { executeTool }) => executeTool("inner", {}) })
    const inner = defineDurableTool({ name: "inner", replay: "safe", callers: "tools", execute: (_i, { executeTool }) => executeTool("add", { a: 20, b: 22 }) })
    const fx = await openFx(tempDb(), callOnce("outer"), { runtimes: { r: { tools: [outer, inner, add] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toBe("42")
    const [o, i, a] = await toolTasks(agent)
    expect([i?.callerTaskId, a?.callerTaskId]).toEqual([o?.id, i?.id])
    await fx.close()
  })

  it("aborts nested calls still running when the caller returns", async () => {
    const aborted = deferred()
    const slow = defineDurableTool({
      name: "slow",
      replay: "safe",
      callers: "tools",
      execute: (_i, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            aborted.resolve()
            reject(new Error("aborted"))
          })
        )
    })
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: (_i, { executeTool }) => {
        executeTool("slow", {}).catch(() => undefined)
        return "returned early"
      }
    })
    const fx = await openFx(tempDb(), callOnce("script"), { runtimes: { r: { tools: [script, slow] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toBe("returned early")
    await aborted.promise
    const nested = (await toolTasks(agent)).find((t) => t.name === "slow")
    expect(nested?.state).toBe("cancelled")
    await fx.close()
  })

  it("after a restart, a caller that runs again gets its finished nested calls back", async () => {
    const db = tempDb()
    const deployed: Array<string> = []
    const deploy = defineDurableTool({
      name: "deploy",
      replay: "unsafe",
      callers: "tools",
      inputSchema: z.object({ version: z.string() }),
      execute: ({ version }) => {
        deployed.push(version)
        return `deployed ${version}`
      }
    })
    const halfway = deferred()
    let firstRun = true
    const release = defineDurableTool({
      name: "release",
      replay: "safe",
      execute: async (_i, { executeTool }) => {
        const result = await executeTool("deploy", { version: "v2" })
        if (firstRun) {
          firstRun = false
          halfway.resolve()
          await new Promise(() => undefined) // the process goes away here
        }
        return `${result}, announced`
      }
    })
    const runtimes = { r: { tools: [release, deploy] } }
    const fx = await openFx(db, callOnce("release"), { runtimes })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    const submission = await agent.submit("ship it")
    await halfway.promise
    await fx.close()

    const reopened = await openFx(db, callOnce("release"), { runtimes })
    const again = await reopened.attach("a")
    await waitFor(async () => (await again.submissions()).find((s) => s.id === submission.id)?.state === "completed")
    expect((await again.submissions())[0]?.result?.text).toBe("deployed v2, announced")
    expect(deployed).toEqual(["v2"])
    const events = []
    for await (const e of again.events({ follow: false })) events.push(e)
    expect(events.find((e) => e.type === "tool.reused")?.payload).toMatchObject({ tool: "deploy", state: "completed" })
    await reopened.close()
  })

  it("rejects calls to unknown tools", async () => {
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: (_i, { executeTool }) => executeTool("nope", {}).catch((cause: unknown) => (cause instanceof Error ? cause.message : "?"))
    })
    const fx = await openFx(tempDb(), callOnce("script"), { runtimes: { r: { tools: [script] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect((await (await agent.submit("go")).result()).text).toBe("no tool named nope can be called from a tool")
    await fx.close()
  })
})
