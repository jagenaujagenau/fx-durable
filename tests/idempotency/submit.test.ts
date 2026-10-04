import { describe, expect, it } from "vitest"
import { openFx, tempDb } from "../helpers.js"

const echo = () => ({ text: "ok" })

describe("submission idempotency", () => {
  it("a repeated requestId resolves to the same logical submission", async () => {
    const fx = await openFx(tempDb(), echo, { runtimes: { coding: {} } })
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const a = await agent.submit("Deploy staging", { requestId: "deploy-42" })
    const b = await agent.submit("Deploy staging", { requestId: "deploy-42" })
    expect(b.id).toBe(a.id)
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    await a.result()
    // Even after completion, the same requestId attaches to the finished submission.
    const c = await agent.submit("Deploy staging", { requestId: "deploy-42" })
    expect(c.id).toBe(a.id)
    expect((await c.result()).text).toBe("ok")
    expect(await agent.submissions()).toHaveLength(1)
    await fx.close()
  })

  it("concurrent duplicate submissions create exactly one", async () => {
    const fx = await openFx(tempDb(), echo, { runtimes: { coding: {} } })
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const all = await Promise.all(Array.from({ length: 10 }, () => agent.submit("x", { requestId: "same" })))
    expect(new Set(all.map((s) => s.id)).size).toBe(1)
    expect(all.filter((s) => s.created)).toHaveLength(1)
    await fx.close()
  })

  it("request ids are scoped per agent; no request id means a new submission", async () => {
    const fx = await openFx(tempDb(), echo, { runtimes: { coding: {} } })
    const a = await fx.agent("a", { runtime: "coding", model: "test/model" })
    const b = await fx.agent("b", { runtime: "coding", model: "test/model" })
    const s1 = await a.submit("x", { requestId: "r" })
    const s2 = await b.submit("x", { requestId: "r" })
    const s3 = await a.submit("x")
    const s4 = await a.submit("x")
    expect(new Set([s1.id, s2.id, s3.id, s4.id]).size).toBe(4)
    await Promise.all([s1, s2, s3, s4].map((s) => s.result()))
    await fx.close()
  })

  it("agent identity is stable across application restarts", async () => {
    const db = tempDb()
    let fx = await openFx(db, echo, { runtimes: { coding: {} } })
    let agent = await fx.agent("engineer", { runtime: "coding", model: "test/model", cwd: "/repo" })
    const created = (await agent.info()).createdAt
    await fx.close()
    fx = await openFx(db, echo, { runtimes: { coding: {} } })
    agent = await fx.attach("engineer")
    const info = await agent.info()
    expect(info.createdAt).toEqual(created)
    expect(info.cwd).toBe("/repo")
    expect(info.runtimeId).toBe("coding")
    await fx.close()
  })
})
