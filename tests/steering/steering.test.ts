import { describe, expect, it } from "vitest"
import { defineDurableTool, type DurableEvent } from "../../src/index.js"
import { buildRecoveryPrompt } from "../../src/domain/tool-outcomes.js"
import { steeringFor } from "../../src/domain/steering.js"
import { deferred, openFx, openTestJournal, tempDb } from "../helpers.js"

const eventsOf = async (iterable: AsyncIterable<DurableEvent>) => {
  const out: Array<DurableEvent> = []
  for await (const event of iterable) out.push(event)
  return out
}

describe("steering", () => {
  it("delivers guidance to the running turn at the next model boundary", async () => {
    const started = deferred()
    const release = deferred()
    const slow = defineDurableTool({
      name: "slow",
      replay: "safe",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        started.resolve()
        await release.promise
        return { done: true }
      }
    })
    const seen: Array<string> = []
    const script = (req: { userText: string; toolResults: ReadonlyArray<unknown> }) => {
      seen.push(req.userText)
      if (req.userText === "go" && req.toolResults.length === 0) return { toolCalls: [{ name: "slow", input: {} }] }
      return { text: `last user message: ${req.userText}` }
    }
    const fx = await openFx(tempDb(), script, { runtimes: { chat: { tools: [slow] } } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const submission = await agent.submit("go")
    await started.promise

    const steered = await agent.steer("use pnpm, not npm")
    release.resolve()
    const result = await submission.result()

    expect(steered.id).toBe(submission.id)
    // libfx hands guidance to the model as a tagged user message.
    expect(result.text).toContain("<user_steering>")
    expect(result.text).toContain("use pnpm, not npm")
    const types = (await eventsOf(agent.events({ follow: false }))).map((e) => e.type)
    expect(types).toContain("turn.steered")
    await fx.close()
  })

  it("submits the guidance as a new request when no turn is running", async () => {
    const fx = await openFx(tempDb(), (req) => ({ text: `answer to: ${req.userText}` }), { runtimes: { chat: {} } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const submission = await agent.steer("hello")
    expect(submission.created).toBe(true)
    expect((await submission.result()).text).toBe("answer to: hello")
    await fx.close()
  })

  it("rejects empty guidance", async () => {
    const fx = await openFx(tempDb(), () => ({ text: "x" }), { runtimes: { chat: {} } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await expect(agent.steer("  ")).rejects.toThrow(/empty/)
    await fx.close()
  })

  it("is journaled against the active turn and replayed into the recovery prompt", () => {
    const { journal, storage } = openTestJournal(tempDb())
    journal.upsertAgent("a", { runtime: "chat", model: "m", cwd: null })
    const { record } = journal.submit("a", null, "fix the tests")
    expect(journal.recordSteering("a", "too early")).toBeNull()
    const turn = journal.startTurn(record, "executor-1")
    if (!turn) throw new Error("turn did not start")
    expect(journal.recordSteering("a", "use pnpm")).toEqual({ turnId: turn.id, submissionId: record.id })
    journal.recordSteering("a", "keep the API stable")

    const steering = steeringFor(journal.reader, "a", turn.id)
    expect(steering).toEqual(["use pnpm", "keep the API stable"])
    const prompt = buildRecoveryPrompt(record, { ...turn, attempt: 2 }, storage.tasksForTurn(turn.id), steering)
    expect(prompt).toContain("Guidance the user added while the turn ran")
    expect(prompt).toContain("- use pnpm")
    expect(prompt).toContain("- keep the API stable")
  })
})
