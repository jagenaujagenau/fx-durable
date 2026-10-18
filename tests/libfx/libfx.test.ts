/**
 * What fx-durable assumes about libfx, checked against libfx alone (with the
 * scripted model). An upgrade that changes one of these fails here first.
 */
import { describe, expect, it } from "vitest"
import { createFxAgent, memory, type FxAgentHostTool, type FxToolContext } from "libfx"
import { scriptedModel, type Script, type ScriptedRequest } from "../../src/testing/index.js"
import { isJsonString } from "../../src/domain/json.js"

const users = (req: ScriptedRequest) =>
  req.messages
    .filter((m) => m.role === "user")
    .map((m) => (isJsonString(m.content) ? m.content : m.content.map((p) => p.text ?? "").join("")))
    .join(" | ")

const agentWith = (script: Script, tools: ReadonlyArray<FxAgentHostTool> = [], checkpoint?: Uint8Array) => {
  const options = { apiKey: "k", model: "test/model", fetch: scriptedModel(script), modelCatalog: [], tools: [...tools], durability: memory() }
  return createFxAgent(checkpoint ? { ...options, checkpoint } : options)
}

const tool = (name: string, execute: FxAgentHostTool["execute"]): FxAgentHostTool => ({ name, description: name, idempotent: true, inputSchema: { type: "object", properties: {} }, execute })

describe("libfx assumptions", () => {
  it("a tool call gets the model's call id as its executionId, its session id, and the turn's context", async () => {
    const seen: Array<FxToolContext> = []
    const ids: Array<string> = []
    const agent = agentWith(
      (req) => (req.step === 0 ? { toolCalls: [{ name: "probe", input: {} }] } : { text: "ok" }),
      [tool("probe", (_input, context) => (seen.push(context), "probed"))]
    )
    const session = agent.session(undefined, { context: { agentId: "a" } })
    const turn = session.prompt("go")
    for await (const event of turn) if (event.type === "tool_start") ids.push(event.id)
    await turn.result
    expect(seen[0]).toMatchObject({ executionId: ids[0], sessionId: session.id, context: { agentId: "a" } })
    await agent.close()
  })

  it("a checkpoint starts only the sessions opened without an id (fx-durable opens a fork's first one that way)", async () => {
    const base = agentWith((req) => ({ text: users(req) }))
    const session = base.session()
    await session.prompt("one").result
    const checkpoint = await session.checkpoint()
    const forked = agentWith((req) => ({ text: users(req) }), [], checkpoint)
    const answer = async (turn: ReturnType<typeof session.prompt>) => {
      let text = ""
      for await (const event of turn) if (event.type === "text_delta") text += event.delta
      return text
    }
    expect(await answer(forked.session().prompt("two"))).toBe("one | two")
    const id = await forked.newSessionId()
    expect(await answer(forked.session(id).prompt("three"))).toBe("three")
    await base.close()
    await forked.close()
  })
})
