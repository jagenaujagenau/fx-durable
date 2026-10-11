import { describe, expect, it } from "vitest"
import { defineDurableTool, defineSubagent } from "../../src/index.js"
import { deferred, openFx, tempDb, waitFor } from "../helpers.js"

describe("fx.taskGraph()", () => {
  it("shows running work with its owners: turns, tool calls, subagents, nested calls; and queued requests", async () => {
    const gate = deferred()
    const slow = defineDurableTool({ name: "slow", replay: "safe", callers: "tools", execute: () => gate.promise.then(() => "done") })
    const script = defineDurableTool({ name: "script", replay: "safe", execute: (_i, { executeTool }) => executeTool("slow", {}) })
    const helper = defineSubagent({ name: "helper", description: "Helps", runtime: "child" })
    const fx = await openFx(
      tempDb(),
      (req) => {
        if (req.step > 0) return { text: "ok" }
        return req.tools.includes("helper") ? { toolCalls: [{ name: "helper", input: { task: "help" } }] } : { toolCalls: [{ name: "script", input: {} }] }
      },
      { runtimes: { parent: { tools: [helper] }, child: { tools: [script, slow] } } }
    )
    const agent = await fx.agent("a", { runtime: "parent", model: "test/model" })
    const first = await agent.submit("go")
    const second = await agent.submit("later")

    await waitFor(async () => (await fx.taskGraph()).nodes.some((n) => n.name === "slow"))
    const graph = await fx.taskGraph()
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const chain = (name: string) => {
      const names: Array<string> = []
      for (let node = graph.nodes.find((n) => n.name === name); node; node = node.owner ? byId.get(node.owner) : undefined) {
        names.push(`${node.agentId}:${node.type}${node.name ? `:${node.name}` : ""}`)
      }
      return names
    }
    const child = graph.nodes.find((n) => n.name === "slow")?.agentId ?? ""
    expect(chain("slow")).toEqual([`${child}:tool:slow`, `${child}:tool:script`, `${child}:turn`, "a:tool:helper", "a:turn"])
    // Owners come before what they own.
    const position = new Map(graph.nodes.map((n, i) => [n.id, i]))
    for (const node of graph.nodes) if (node.owner) expect(position.get(node.owner)).toBeLessThan(position.get(node.id) ?? -1)
    expect(graph.queued).toEqual([{ agentId: "a", submissionId: second.id, kind: "input" }])

    gate.resolve()
    await first.result()
    await second.result()
    expect(await fx.taskGraph()).toEqual({ nodes: [], queued: [] })
    await fx.close()
  })
})
