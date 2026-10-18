import { describe, expect, it } from "vitest"
import { defineDurableTool, defineExtension, type FxStreamLine } from "../../src/index.js"
import { isJsonString } from "../../src/domain/json.js"
import type { Script, ScriptedRequest } from "../../src/testing/index.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

const users = (req: ScriptedRequest) =>
  req.messages
    .filter((m) => m.role === "user")
    .map((m) => (isJsonString(m.content) ? m.content : m.content.map((p) => p.text ?? "").join("")))
    .join(" | ")
const system = (req: ScriptedRequest) =>
  req.messages
    .filter((m) => m.role === "system")
    .map((m) => (isJsonString(m.content) ? m.content : ""))
    .join("\n")

/** Answers with what the model has seen of the conversation. */
const echo: Script = (req) => ({ text: users(req) })

const collect = async (iterable: AsyncIterable<FxStreamLine>, until?: (line: FxStreamLine) => boolean) => {
  const out: Array<FxStreamLine> = []
  for await (const line of iterable) {
    out.push(line)
    if (until?.(line)) break
  }
  return out
}

describe("agent sessions", () => {
  it("keeps one conversation across requests, and starts a new one on reset; a handoff summary reaches the instructions", async () => {
    const seen: Array<ScriptedRequest> = []
    const fx = await openFx(tempDb(), (req) => (seen.push(req), echo(req)), { runtimes: { r: { instructions: "Be brief." } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("one")).result()
    expect((await (await agent.submit("two")).result()).text).toBe("one | two")
    const first = (await agent.info()).sessionId

    await agent.reset({ summary: "We counted to two." })
    expect((await (await agent.submit("three")).result()).text).toBe("three")
    expect((await agent.info()).sessionId).not.toBe(first)
    expect(system(seen.at(-1)!)).toMatch(/^Be brief\.\n\n<previous_context>[\s\S]*We counted to two\.[\s\S]*<\/previous_context>$/)
    await fx.close()
  })

  it("forks a conversation: the fork continues from it, and both go their own way", async () => {
    const fx = await openFx(tempDb(), echo, { runtimes: { r: {} } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("one")).result()
    const fork = await agent.fork("b")
    expect((await (await fork.submit("fork")).result()).text).toBe("one | fork")
    expect((await (await fork.submit("again")).result()).text).toBe("one | fork | again")
    expect((await (await agent.submit("original")).result()).text).toBe("one | original")
    await fx.close()
  })

  it("carries the conversation into a new session store when the agent's tools change", async () => {
    const offered: Array<ReadonlyArray<string>> = []
    const extra = defineExtension({ name: "extra", tools: [defineDurableTool({ name: "extra", replay: "safe", execute: () => "x" })] })
    const fx = await openFx(tempDb(), (req) => (offered.push(req.tools), echo(req)), { runtimes: { r: {} } })
    await fx.installExtension(extra)
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("before")).result()
    const store = (await agent.info()).sessionStore
    await agent.setExtensions(["extra"])
    expect((await (await agent.submit("after")).result()).text).toBe("before | after")
    expect(offered.at(-1)).toEqual(["extra"])
    expect((await agent.info()).sessionStore).not.toBe(store)
    await fx.close()
  })

  it("replays a session's events from a cursor, and follows new ones live", async () => {
    const fx = await openFx(tempDb(), echo, { runtimes: { r: {} } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("one")).result()
    const history = await collect(agent.events({ follow: false }))
    expect(history.map((l) => l.type)).toEqual(expect.arrayContaining(["turn_start", "text_delta", "turn_end"]))
    const cursor = history.at(-1)?.cursor ?? 0

    const live = collect(agent.events({ after: cursor }), (line) => line.type === "turn_end")
    await (await agent.submit("two")).result()
    const next = await live
    expect(next[0]?.type).toBe("turn_start")
    expect(next.every((line) => (line.cursor ?? 0) > cursor)).toBe(true)
    await fx.close()
  })

  it("steers the running turn", async () => {
    const started = deferred()
    const release = deferred()
    const wait = defineDurableTool({
      name: "wait",
      replay: "safe",
      execute: async () => {
        started.resolve()
        await release.promise
        return "waited"
      }
    })
    const script: Script = (req) => (req.step === 0 && !users(req).includes("Keep it short.") ? { toolCalls: [{ name: "wait", input: {} }] } : { text: users(req) })
    const fx = await openFx(tempDb(), script, { runtimes: { r: { tools: [wait] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    const steered = await agent.submit("work")
    await started.promise
    await agent.steer("Keep it short.")
    // libfx 0.0.14 (local()) misses a steer stored a millisecond before the tool returns (vercel-labs/fx#1342).
    await new Promise((resolve) => setTimeout(resolve, 50))
    release.resolve()
    expect((await steered.result()).text).toContain("Keep it short.")
    await fx.close()
  })

  it("cancels a request's turn: its tool calls are aborted", async () => {
    const aborted = deferred()
    const block = defineDurableTool({
      name: "block",
      replay: "safe",
      execute: (_input, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            aborted.resolve()
            reject(new Error("aborted"))
          })
        )
    })
    const fx = await openFx(tempDb(), (req) => (req.step === 0 && req.userText === "work" ? { toolCalls: [{ name: "block", input: {} }] } : { text: "done" }), {
      runtimes: { r: { tools: [block] } }
    })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    const submission = await agent.submit("work")
    await waitFor(async () => (await fx.taskGraph()).nodes.some((n) => n.name === "block"))
    await submission.cancel()
    await aborted.promise
    await expect(submission.result()).rejects.toMatchObject({ state: "cancelled" })
    expect((await (await agent.submit("next")).result()).text).toBe("done")
    await fx.close()
  })

  it("runs requests to different agents at the same time", async () => {
    const both = deferred()
    let waiting = 0
    const meet = defineDurableTool({
      name: "meet",
      replay: "safe",
      execute: async () => {
        if (++waiting === 2) both.resolve()
        await both.promise
        return "met"
      }
    })
    const fx = await openFx(tempDb(), (req) => (req.step === 0 ? { toolCalls: [{ name: "meet", input: {} }] } : { text: "done" }), { runtimes: { r: { tools: [meet] } } })
    const a = await fx.agent("a", { runtime: "r", model: "test/model" })
    const b = await fx.agent("b", { runtime: "r", model: "test/model" })
    const [ra, rb] = await Promise.all([(await a.submit("go")).result(), (await b.submit("go")).result()])
    expect([ra.text, rb.text]).toEqual(["done", "done"])
    await fx.close()
  })

  it("fails a request libfx refuses as too large, so it is not prompted again on every open", async () => {
    const db = tempDb()
    const fx = await openFx(db, () => ({ text: "ok" }), { runtimes: { r: {} } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await expect(agent.submit("x".repeat(9 * 1024 * 1024))).rejects.toThrow(/the request was not accepted/)
    expect((await fx.taskGraph()).nodes).toEqual([])
    expect((await (await agent.submit("hello")).result()).text).toBe("ok")
    await fx.close()
    const reopened = await openFx(db, () => ({ text: "ok" }), { runtimes: { r: {} } })
    expect((await reopened.taskGraph()).nodes).toEqual([])
    await reopened.close()
  })
})
