import { describe, expect, it } from "vitest"
import { defineDurableTool, type DurableEvent } from "../../src/index.js"
import { isJsonString } from "../../src/domain/json.js"
import type { Script, ScriptedRequest } from "../../src/testing/index.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

const eventsOf = async (iterable: AsyncIterable<DurableEvent>) => {
  const out: Array<DurableEvent> = []
  for await (const event of iterable) out.push(event)
  return out
}

const systemOf = (req: ScriptedRequest) => req.messages.filter((m) => m.role === "system").map((m) => (isJsonString(m.content) ? m.content : "")).join("\n")
const usersOf = (req: ScriptedRequest) =>
  req.messages.filter((m) => m.role === "user").map((m) => (isJsonString(m.content) ? m.content : m.content.map((p) => p.text ?? "").join("")))

const isCompaction = (req: ScriptedRequest) => req.userText.startsWith("Summarize this conversation")

/**
 * Answers with what it sees: the user messages, and the summary in its
 * instructions, if any. Asked to compact, it summarizes the user messages.
 */
const seeing: Script = (req) => {
  if (isCompaction(req)) {
    const earlier = /<previous_context>[\s\S]*?\n\n([\s\S]*?)\n<\/previous_context>/.exec(systemOf(req))?.[1]
    const said = usersOf(req).slice(0, -1).join(", ")
    return { text: `SUMMARY(${earlier ? `${earlier}; ` : ""}${said})` }
  }
  const summary = /<previous_context>[\s\S]*?\n\n([\s\S]*?)\n<\/previous_context>/.exec(systemOf(req))?.[1]
  return { text: `${summary ? `[${summary}] ` : ""}${usersOf(req).join(" | ")}` }
}

const runtimes = { chat: { instructions: "You are terse." } }

describe("reset", () => {
  it("starts a new context: the model no longer sees the conversation", async () => {
    const fx = await openFx(tempDb(), seeing, { runtimes })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("one")).result()
    await (await agent.submit("two")).result()

    const reset = await agent.reset()
    expect(await reset.result()).toMatchObject({ text: "", stopReason: "reset" })
    expect((await reset.status()).kind).toBe("reset")
    expect((await (await agent.submit("three")).result()).text).toBe("three")
    expect((await (await agent.submit("four")).result()).text).toBe("three | four")

    const events = await eventsOf(agent.events({ follow: false }))
    expect(events.find((e) => e.type === "context.reset")?.payload).toEqual({ sequence: 3, kind: "reset", summary: null })
    await fx.close()
  })

  it("hands off a summary the model sees in its instructions, turn after turn", async () => {
    const requests: Array<ScriptedRequest> = []
    const fx = await openFx(tempDb(), (req) => (requests.push(req), seeing(req)), { runtimes })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("secret plan")).result()
    await (await agent.reset({ summary: "the user is planning a party" })).result()

    expect((await (await agent.submit("what now?")).result()).text).toBe("[the user is planning a party] what now?")
    expect((await (await agent.submit("and then?")).result()).text).toBe("[the user is planning a party] what now? | and then?")
    // The runtime's own instructions come first.
    expect(systemOf(requests.at(-1)!)).toMatch(/^You are terse\.\n\n<previous_context>/)
    await fx.close()
  })

  it("waits for the work already queued", async () => {
    const gate = deferred()
    const fx = await openFx(
      tempDb(),
      async (req) => {
        if (req.userText === "slow") await gate.promise
        return seeing(req)
      },
      { runtimes }
    )
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const slow = await agent.submit("slow")
    const reset = await agent.reset()
    const after = await agent.submit("after")
    gate.resolve()
    expect((await slow.result()).text).toBe("slow")
    await reset.result()
    expect((await after.result()).text).toBe("after")
    await fx.close()
  })

  it("is inherited by a fork, summary included", async () => {
    const fx = await openFx(tempDb(), seeing, { runtimes })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("one")).result()
    await (await agent.reset({ summary: "S" })).result()
    await (await agent.submit("two")).result()
    const fork = await agent.fork("b")
    expect((await (await fork.submit("three")).result()).text).toBe("[S] two | three")
    await fx.close()
  })
})

describe("compaction", () => {
  it("replaces the context with the model's summary of it", async () => {
    const fx = await openFx(tempDb(), seeing, { runtimes })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("one")).result()
    await (await agent.submit("two")).result()

    const compaction = await agent.compact()
    expect((await compaction.result()).text).toBe("SUMMARY(one, two)")
    expect((await (await agent.submit("three")).result()).text).toBe("[SUMMARY(one, two)] three")

    // A second compaction folds the first summary in.
    await (await agent.compact()).result()
    expect((await (await agent.submit("four")).result()).text).toBe("[SUMMARY(SUMMARY(one, two); three)] four")

    // The summaries are model requests like any other.
    expect((await agent.usage()).total.requests).toBe(6)
    const reset = (await eventsOf(agent.events({ follow: false }))).filter((e) => e.type === "context.reset")
    expect(reset.map((e) => e.payload.kind)).toEqual(["compaction", "compaction"])
    await fx.close()
  })

  it("passes extra guidance to the summary", async () => {
    const prompts: Array<string> = []
    const fx = await openFx(tempDb(), (req) => (isCompaction(req) && prompts.push(req.userText), seeing(req)), { runtimes })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("one")).result()
    await (await agent.compact({ instructions: "keep the failing tests" })).result()
    expect(prompts[0]).toContain("Also: keep the failing tests")
    await fx.close()
  })

  it("keeps the tools defined but does not run them while summarizing", async () => {
    const ran: Array<string> = []
    const probe = defineDurableTool({ name: "probe", replay: "safe", execute: () => (ran.push("probe"), "ok") })
    const fx = await openFx(
      tempDb(),
      (req) => {
        if (isCompaction(req)) {
          expect(req.tools).toEqual(["probe"])
          return req.step === 0 ? { toolCalls: [{ name: "probe", input: {} }] } : { text: `SUMMARY after ${req.toolResults[0]?.isError ? "error" : "ok"}` }
        }
        return { text: "hi" }
      },
      { runtimes: { chat: { tools: [probe] } } }
    )
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("hello")).result()
    expect((await (await agent.compact()).result()).text).toBe("SUMMARY after error")
    expect(ran).toEqual([])
    await fx.close()
  })

  it("on an empty context makes no model request", async () => {
    const fx = await openFx(tempDb(), seeing, { runtimes })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    expect(await (await agent.compact()).result()).toMatchObject({ text: "", stopReason: "empty" })
    expect((await agent.usage()).total.requests).toBe(0)
    await fx.close()
  })

  it("runs automatically once the context reaches the limit, before the next queued request", async () => {
    const gate = deferred()
    const fx = await openFx(
      tempDb(),
      async (req) => {
        if (req.userText === "big") await gate.promise
        const response = seeing(req)
        return req.userText === "big" ? { ...response, usage: { input: 9000, output: 1000 } } : response
      },
      { runtimes: { chat: { compaction: { maxContextTokens: 10_000 } } } }
    )
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("small")).result()
    const big = await agent.submit("big")
    const next = await agent.submit("next") // queued before the compaction exists
    gate.resolve()
    await big.result()
    expect((await next.result()).text).toBe("[SUMMARY(small, big)] next")
    // Turns ran in this order: small, big, the compaction, next.
    const started = (await eventsOf(agent.events({ follow: false }))).filter((e) => e.type === "submission.started")
    const kinds = new Map((await agent.submissions()).map((sub) => [sub.id, sub.kind]))
    expect(started.map((e) => kinds.get(e.submissionId ?? ""))).toEqual(["input", "input", "compaction", "input"])
    await fx.close()
  })

  it("does not take guidance meant for the work: steering during a compaction becomes a request", async () => {
    const summarizing = deferred()
    const gate = deferred()
    const fx = await openFx(
      tempDb(),
      async (req) => {
        if (isCompaction(req)) {
          summarizing.resolve()
          await gate.promise
        }
        return seeing(req)
      },
      { runtimes }
    )
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("one")).result()
    const compaction = await agent.compact()
    await summarizing.promise
    const steered = await agent.steer("also this")
    expect(steered.id).not.toBe(compaction.id)
    gate.resolve()
    expect((await steered.result()).text).toBe("[SUMMARY(one)] also this")
    await fx.close()
  })

  it("is summarized again after a restart interrupts it", async () => {
    const db = tempDb()
    const summarizing = deferred()
    const fx = await openFx(
      db,
      async (req) => {
        if (isCompaction(req)) {
          summarizing.resolve()
          await new Promise(() => undefined) // never answers: the process goes away first
        }
        return seeing(req)
      },
      { runtimes }
    )
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    await (await agent.submit("one")).result()
    const compaction = await agent.compact()
    await summarizing.promise
    await fx.close()

    const reopened = await openFx(db, seeing, { runtimes })
    const again = await reopened.attach("a")
    const stateOf = async () => (await again.submissions()).find((s) => s.id === compaction.id)
    await waitFor(async () => (await stateOf())?.state === "completed")
    expect((await stateOf())?.result?.text).toBe("SUMMARY(one)")
    expect((await (await again.submit("two")).result()).text).toBe("[SUMMARY(one)] two")
    await reopened.close()
  })
})
