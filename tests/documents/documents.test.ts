import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineDocument, defineDurableTool, type DurableAgent, type DurableEvent, type Json } from "../../src/index.js"
import type { Script } from "../../src/testing/index.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

const Todos = defineDocument<{ items: Array<string> }>({ kind: "test.todos", version: 1, scope: "agent", initial: () => ({ items: [] }) })

const addTodoTool = (callers: "model" | "tools" | "both" = "both") =>
  defineDurableTool({
    name: "add_todo",
    replay: "safe",
    callers,
    inputSchema: z.object({ item: z.string() }),
    execute: async ({ item }, { documents }) => (await documents.update(Todos, (todos) => void todos.items.push(item))).items.length
  })
const addTodo = addTodoTool()
const noTools = { runtimes: { r: { tools: [] } } }

/** The model makes these tool calls in its first step, then answers with their results. */
const calls =
  (...toolCalls: Array<{ readonly name: string; readonly input: Record<string, Json> }>): Script =>
  (req) =>
    req.step === 0 ? { toolCalls } : { text: req.toolResults.map((r) => JSON.stringify(r.output ?? null)).join(" ") }

const eventsOf = async (agent: DurableAgent) => {
  const events: Array<DurableEvent> = []
  for await (const event of agent.events({ follow: false })) events.push(event)
  return events
}

describe("typed documents", () => {
  it("commits a tool's writes with its result, and records them as events", async () => {
    const fx = await openFx(tempDb(), calls({ name: "add_todo", input: { item: "write docs" } }), { runtimes: { r: { tools: [addTodo] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    expect(await agent.document(Todos)).toEqual({ items: [] })
    await (await agent.submit("go")).result()
    expect(await agent.document(Todos)).toEqual({ items: ["write docs"] })

    const events = await eventsOf(agent)
    const updated = events.find((e) => e.type === "document.updated")
    const completed = events.find((e) => e.type === "tool.completed")
    expect(updated).toMatchObject({ payload: { kind: "test.todos", scope: "agent", revision: 1 }, taskId: completed?.taskId })
    // Same transaction: the write and the result are adjacent in the log.
    expect(completed!.sequence).toBe(updated!.sequence + 1)
    await fx.close()
  })

  it("lets a tool read its own writes, and drops them when it fails", async () => {
    const seen: Array<Json> = []
    const failing = defineDurableTool({
      name: "failing",
      replay: "safe",
      execute: async (_input, { documents }) => {
        await documents.update(Todos, (todos) => ({ items: [...todos.items, "never"] }))
        seen.push(await documents.get(Todos))
        throw new Error("boom")
      }
    })
    const fx = await openFx(tempDb(), calls({ name: "failing", input: {} }), { runtimes: { r: { tools: [failing] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("go")).result()
    expect(seen).toEqual([{ items: ["never"] }])
    expect(await agent.document(Todos)).toEqual({ items: [] })
    expect((await eventsOf(agent)).some((e) => e.type === "document.updated")).toBe(false)
    await fx.close()
  })

  it("applies parallel calls' writes on top of each other", async () => {
    const fx = await openFx(
      tempDb(),
      calls({ name: "add_todo", input: { item: "one" } }, { name: "add_todo", input: { item: "two" } }, { name: "add_todo", input: { item: "three" } }),
      { runtimes: { r: { tools: [addTodo] } } }
    )
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await (await agent.submit("go")).result()
    expect((await agent.document(Todos)).items.toSorted()).toEqual(["one", "three", "two"])
    await fx.close()
  })

  it("writes nothing for a call cut off by a restart, and once when it is replayed", async () => {
    const db = tempDb()
    const halfway = deferred()
    let firstProcess = true
    const slowAdd = defineDurableTool({
      name: "slow_add",
      replay: "safe",
      execute: async (_input, { documents }) => {
        await documents.update(Todos, (todos) => void todos.items.push("once"))
        if (firstProcess) {
          halfway.resolve()
          await new Promise(() => undefined) // the process goes away here
        }
        return "added"
      }
    })
    const runtimes = { r: { tools: [slowAdd] } }
    const fx = await openFx(db, calls({ name: "slow_add", input: {} }), { runtimes })
    const submission = await (await fx.agent("a", { runtime: "r", model: "test/model" })).submit("go")
    await halfway.promise
    await fx.close()

    firstProcess = false
    const reopened = await openFx(db, calls({ name: "slow_add", input: {} }), { runtimes })
    const agent = await reopened.attach("a")
    await waitFor(async () => (await agent.submissions()).find((s) => s.id === submission.id)?.state === "completed")
    expect(await agent.document(Todos)).toEqual({ items: ["once"] })
    await reopened.close()
  })

  it("updates documents directly, and rejects an update that throws without writing", async () => {
    const Settings = defineDocument<{ theme: string }>({ kind: "test.settings", version: 1, scope: "global", initial: () => ({ theme: "light" }) })
    const fx = await openFx(tempDb(), calls(), noTools)
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })

    expect(await agent.updateDocument(Todos, (todos) => void todos.items.push("x"))).toEqual({ items: ["x"] })
    expect(await agent.updateDocument(Todos, () => ({ items: ["replaced"] }))).toEqual({ items: ["replaced"] })
    await expect(agent.updateDocument(Todos, () => {
      throw new Error("no")
    })).rejects.toThrow("no")
    // @ts-expect-error -- updates are synchronous; an untyped caller could still pass an async one
    await expect(agent.updateDocument(Todos, async () => ({ items: [] }))).rejects.toThrow("synchronous")
    expect(await agent.document(Todos)).toEqual({ items: ["replaced"] })

    expect(await fx.document(Settings)).toEqual({ theme: "light" })
    await fx.updateDocument(Settings, (settings) => ({ ...settings, theme: "dark" }))
    expect(await fx.document(Settings)).toEqual({ theme: "dark" })
    await expect((await fx.attach("a")).updateDocument(Todos, (t) => t)).resolves.toEqual({ items: ["replaced"] })
    await fx.close()
  })

  it("migrates values stored by an older version, and refuses newer ones", async () => {
    const db = tempDb()
    const V1 = defineDocument<{ items: Array<string> }>({ kind: "test.list", version: 1, scope: "agent", initial: () => ({ items: [] }) })
    const V2 = defineDocument<{ entries: Array<{ text: string }> }>({
      kind: "test.list",
      version: 2,
      scope: "agent",
      initial: () => ({ entries: [] }),
      migrate: (value) => ({ entries: z.object({ items: z.array(z.string()) }).parse(value).items.map((text) => ({ text })) })
    })
    const V2NoMigrate = defineDocument<{ entries: Array<{ text: string }> }>({ kind: "test.list", version: 2, scope: "agent", initial: () => ({ entries: [] }) })
    const fx = await openFx(db, calls(), noTools)
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await agent.updateDocument(V1, () => ({ items: ["a"] }))
    await expect(agent.document(V2NoMigrate)).rejects.toThrow("needs a migrate function")
    expect(await agent.document(V2)).toEqual({ entries: [{ text: "a" }] })
    await agent.updateDocument(V2, (doc) => void doc.entries.push({ text: "b" }))
    await expect(agent.document(V1)).rejects.toThrow("newer than 1")
    expect(await agent.document(V2)).toEqual({ entries: [{ text: "a" }, { text: "b" }] })
    await fx.close()
  })

  it("rewinds to a checkpoint, and gives forks the value their fork policy asks for", async () => {
    const Notes = defineDocument<{ text: string }>({
      kind: "test.notes",
      version: 1,
      scope: "agent",
      history: "rewindable",
      fork: "asOf",
      initial: () => ({ text: "" })
    })
    const Draft = defineDocument<{ text: string }>({ kind: "test.draft", version: 1, scope: "agent", fork: "initial", initial: () => ({ text: "" }) })
    const fx = await openFx(tempDb(), () => ({ text: "ok" }), noTools)
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await agent.updateDocument(Notes, () => ({ text: "before turn 1" }))
    const first = await agent.submit("one")
    await first.result() // checkpoint 1
    await agent.updateDocument(Notes, () => ({ text: "after turn 1" }))
    await agent.updateDocument(Draft, () => ({ text: "draft" }))
    await (await agent.submit("two")).result() // checkpoint 2
    await agent.updateDocument(Notes, () => ({ text: "after turn 2" }))

    expect(await agent.document(Notes, { checkpoint: 1 })).toEqual({ text: "before turn 1" })
    expect(await agent.document(Notes, { checkpoint: 2 })).toEqual({ text: "after turn 1" })
    expect(await agent.document(Notes)).toEqual({ text: "after turn 2" })
    await expect(agent.document(Draft, { checkpoint: 1 })).rejects.toThrow("rewindable")

    const fromFirst = await agent.fork("b", { after: first.id })
    expect(await fromFirst.document(Notes)).toEqual({ text: "before turn 1" })
    expect(await fromFirst.document(Draft)).toEqual({ text: "" })
    const fromLatest = await agent.fork("c")
    expect(await fromLatest.document(Notes)).toEqual({ text: "after turn 1" })
    // The fork's own history starts at its first checkpoint.
    expect(await fromLatest.document(Notes, { checkpoint: 1 })).toEqual({ text: "after turn 1" })
    await fx.close()
  })

  it("watches a document: its value now, then each new value", async () => {
    const fx = await openFx(tempDb(), calls({ name: "add_todo", input: { item: "from a tool" } }), { runtimes: { r: { tools: [addTodo] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    await agent.updateDocument(Todos, () => ({ items: ["first"] }))
    const seen: Array<Array<string>> = []
    const watching = (async () => {
      for await (const todos of agent.watchDocument(Todos)) {
        seen.push(todos.items)
        if (todos.items.length === 3) break
      }
    })()
    await waitFor(() => seen.length === 1)
    await agent.updateDocument(Todos, (todos) => void todos.items.push("second"))
    await waitFor(() => seen.length === 2)
    await (await agent.submit("go")).result()
    await watching
    expect(seen).toEqual([["first"], ["first", "second"], ["first", "second", "from a tool"]])
    await fx.close()
  })

  it("shows a caller the writes of the tools it called", async () => {
    const script = defineDurableTool({
      name: "script",
      replay: "safe",
      execute: async (_input, { documents, executeTool }) => {
        await executeTool("add_todo", { item: "nested" })
        return (await documents.get(Todos)).items
      }
    })
    const nestedAdd = addTodoTool("tools")
    const fx = await openFx(tempDb(), calls({ name: "script", input: {} }), { runtimes: { r: { tools: [script, nestedAdd] } } })
    const agent = await fx.agent("a", { runtime: "r", model: "test/model" })
    // The script's result reaches the model as text, which the script echoes as JSON.
    expect(JSON.parse(JSON.parse((await (await agent.submit("go")).result()).text))).toEqual(["nested"])
    await fx.close()
  })
})
