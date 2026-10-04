import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { defineDurableTool, type DurableAgent, type TaskRecord } from "../../src/index.js"
import { scriptedModel } from "../../src/testing/index.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

const decodeProgress = Schema.decodeUnknownOption(Schema.Struct({ progress: Schema.String }))
const progressOf = (task: TaskRecord | undefined): string | undefined =>
  Option.getOrUndefined(Option.map(decodeProgress(task?.metadata), (m) => m.progress))

const runningTask = async (agent: DurableAgent, type: string) =>
  (await agent.currentTurn())?.tasks.find((t) => t.type === type && t.state === "running")

describe("durable progress", () => {
  it("keeps a running tool's reported output in its task, for viewers that attach mid-call", async () => {
    const release = deferred()
    const build = defineDurableTool({
      name: "build",
      replay: "safe",
      inputSchema: { type: "object", properties: {} },
      execute: async (_input, { progress }) => {
        progress("compiling…\n")
        progress("linking…\n")
        await release.promise
        return { ok: true }
      }
    })
    const script = (req: { toolResults: ReadonlyArray<unknown> }) =>
      req.toolResults.length === 0 ? { toolCalls: [{ name: "build", input: {} }] } : { text: "built" }
    const fx = await openFx(tempDb(), script, { runtimes: { chat: { tools: [build] } } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const submission = await agent.submit("build it")

    await waitFor(async () => progressOf(await runningTask(agent, "tool")) === "compiling…\nlinking…\n")
    release.resolve()
    expect((await submission.result()).text).toBe("built")
    await fx.close()
  })

  it("keeps a model's partial text while it streams", async () => {
    const text = "word ".repeat(60)
    const slow = await openFx(tempDb(), () => ({ text }), {
      runtimes: { chat: {} },
      fetch: scriptedModel(() => ({ text }), { chunkDelayMs: 15 })
    })
    const agent = await slow.agent("a", { runtime: "chat", model: "test/model" })
    const submission = await agent.submit("talk")
    let partial = ""
    await waitFor(async () => {
      partial = progressOf(await runningTask(agent, "model")) ?? ""
      return partial.length > 0 && partial.length < text.length
    })
    expect(text.startsWith(partial)).toBe(true)
    expect((await submission.result()).text).toBe(text)
    await slow.close()
  })
})
