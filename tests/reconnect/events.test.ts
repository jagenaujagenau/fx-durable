import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { EventLog } from "../../src/core/events.js"
import type { DurableEvent } from "../../src/index.js"
import { journalRuntime, openFx, tempDb } from "../helpers.js"

const take = async (iterable: AsyncIterable<DurableEvent>, n: number) => {
  const out: Array<DurableEvent> = []
  for await (const event of iterable) {
    out.push(event)
    if (out.length >= n) break
  }
  return out
}

describe("reconnect from an event cursor", () => {
  it("replays persisted events after the cursor, then continues live without gaps", async () => {
    const j = journalRuntime(tempDb())
    const result = await j.run(
      Effect.gen(function* () {
        const log = yield* EventLog
        for (let i = 0; i < 10; i++) yield* log.append({ agentId: "a", type: "agent.idle", payload: { i } })
        // Attach after seq 4, then keep appending concurrently.
        const producer = Effect.gen(function* () {
          for (let i = 10; i < 30; i++) {
            yield* log.append({ agentId: "a", type: "agent.idle", payload: { i } })
            yield* Effect.yieldNow
          }
        })
        yield* Effect.forkChild(producer)
        const events = yield* log.subscribe("a", { after: 4 }).pipe(Stream.take(26), Stream.runCollect)
        return Array.from(events).map((e) => e.sequence)
      })
    )
    expect(result).toEqual(Array.from({ length: 26 }, (_, i) => i + 5))
    await j.runtime.dispose()
  })

  it("a slow consumer falls behind the bounded live channel and still sees every event", async () => {
    const j = journalRuntime(tempDb())
    const result = await j.run(
      Effect.gen(function* () {
        const log = yield* EventLog
        const total = 3000 // more than the live channel's capacity
        const fiber = yield* Effect.forkChild(
          log.subscribe("a", { pollInterval: 50 }).pipe(
            Stream.mapEffect((e) => (e.sequence % 500 === 0 ? Effect.sleep(20).pipe(Effect.as(e)) : Effect.succeed(e))),
            Stream.take(total),
            Stream.runCollect
          )
        )
        yield* Effect.sleep(10)
        for (let i = 0; i < total; i++) yield* log.append({ agentId: "a", type: "agent.idle" })
        const collected = yield* Fiber.join(fiber)
        return Array.from(collected).map((e) => e.sequence)
      })
    )
    expect(result).toHaveLength(3000)
    expect(result).toEqual(Array.from({ length: 3000 }, (_, i) => i + 1))
    await j.runtime.dispose()
  })

  it("clients attach to agents and resume from their last seen sequence across restarts", async () => {
    const db = tempDb()
    const script = () => ({ text: "done" })
    let fx = await openFx(db, script, { runtimes: { coding: {} } })
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const first = await agent.submit("one")
    await first.result()
    const seen = await take(agent.events({ follow: false }), Number.MAX_SAFE_INTEGER)
    const lastSeen = seen[seen.length - 1]!.sequence
    await fx.close()

    fx = await openFx(db, script, { runtimes: { coding: {} } })
    const attached = await fx.attach("engineer")
    const second = await attached.submit("two")
    // A live follower from the cursor sees the new turn through to completion.
    const live: Array<DurableEvent> = []
    for await (const e of attached.events({ after: lastSeen })) {
      live.push(e)
      if (e.type === "submission.completed") break
    }
    expect(live[0]!.sequence).toBe(lastSeen + 1)
    await second.result()
    const after = await take(attached.events({ after: lastSeen, follow: false }), 1000)
    expect(after[0]!.sequence).toBe(lastSeen + 1)
    expect(after.map((e) => e.type)).toContain("submission.completed")
    expect(after.every((e, i) => e.sequence === lastSeen + 1 + i)).toBe(true)
    await fx.close()
  })

  it("disconnecting a client does not cancel the agent", async () => {
    const db = tempDb()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fx = await openFx(
      db,
      async (req) => {
        if (req.step === 0) await gate
        return { text: "finished anyway" }
      },
      { runtimes: { coding: {} } }
    )
    const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
    const submission = await agent.submit("work")
    // A client watches a few events, then disconnects (breaks out of the iterator).
    await take(submission.events(), 2)
    release()
    expect((await submission.result()).text).toBe("finished anyway")
    await fx.close()
  })
})
