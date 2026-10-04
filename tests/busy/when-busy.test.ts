import { describe, expect, it } from "vitest"
import { AgentBusyError, defineDurableTool } from "../../src/index.js"
import { deferred, openFx, openTestJournal, tempDb } from "../helpers.js"

describe("submit with whenBusy", () => {
  it("rejects while a turn is running, and submits nothing", async () => {
    const started = deferred()
    const release = deferred()
    const wait = defineDurableTool({
      name: "wait",
      replay: "safe",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        started.resolve()
        await release.promise
        return null
      }
    })
    const script = (req: { userText: string; toolResults: ReadonlyArray<unknown> }) =>
      req.userText === "long task" && req.toolResults.length === 0 ? { toolCalls: [{ name: "wait", input: {} }] } : { text: `done: ${req.userText}` }
    const fx = await openFx(tempDb(), script, { runtimes: { chat: { tools: [wait] } } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const running = await agent.submit("long task")
    await started.promise

    await expect(agent.submit("only if idle", { whenBusy: "reject" })).rejects.toBeInstanceOf(AgentBusyError)
    expect(await agent.submissions(10)).toHaveLength(1)

    release.resolve()
    await running.result()
    const later = await agent.submit("now idle", { whenBusy: "reject" })
    expect((await later.result()).text).toBe("done: now idle")
    await fx.close()
  })

  it("is atomic in the journal: busy means a running turn or a queued request", () => {
    const { journal } = openTestJournal(tempDb())
    journal.upsertAgent("a", { runtime: "chat", model: "m", cwd: null })
    const first = journal.submitIfIdle("a", null, "first")
    expect(first?.created).toBe(true)
    // Queued, not started: still busy.
    expect(journal.submitIfIdle("a", null, "second")).toBeNull()
    // A retried request ID resolves to its submission even while busy.
    const keyed = journal.submit("a", "req-1", "keyed")
    expect(journal.submitIfIdle("a", "req-1", "keyed again")?.record.id).toBe(keyed.record.id)
  })

  it("queues by default", async () => {
    const fx = await openFx(tempDb(), (req) => ({ text: req.userText }), { runtimes: { chat: {} } })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const one = await agent.submit("one")
    const two = await agent.submit("two")
    expect((await two.result()).text).toBe("two")
    expect((await one.result()).text).toBe("one")
    await fx.close()
  })
})
