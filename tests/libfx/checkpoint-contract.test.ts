/**
 * What fx-durable assumes about libfx checkpoints, checked against the real
 * libfx kernel. If a libfx upgrade breaks one of these, extensions (changing
 * tools and instructions between turns) and compaction need rethinking.
 * Findings recorded against libfx 0.0.12, identical on both backends.
 */
import { createHash } from "node:crypto"
import { createFxAgent, type FxAgent, type FxTool } from "libfx"
import { describe, expect, it } from "vitest"
import { isJsonString, type Json } from "../../src/domain/json.js"
import { scriptedModel, type ScriptedRequest } from "../../src/testing/index.js"

const backends = ["native", "wasm"] as const
type Backend = (typeof backends)[number]

const tool = (name: string, description = `tool ${name}`, executed: Array<string> = []): FxTool => ({
  name,
  description,
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
  execute: async () => {
    executed.push(name)
    return { ok: name }
  }
})

/** "call <tool>" makes the model call that tool once, then answer. */
const recording = () => {
  const requests: Array<ScriptedRequest> = []
  const fetch = scriptedModel((request) => {
    requests.push(request)
    const call = /call (\w+)/.exec(request.userText)
    if (call?.[1] && request.step === 0) return { toolCalls: [{ name: call[1], input: { x: "1" } }] }
    return { text: `answer to: ${request.userText}` }
  })
  return { requests, fetch }
}

const runTurn = async (agent: FxAgent, prompt: string) => {
  const turn = agent.prompt(prompt)
  const toolEnds: Array<{ name: string; isError: boolean }> = []
  for await (const event of turn) if (event.type === "tool_end") toolEnds.push({ name: event.name, isError: event.isError ?? false })
  await turn.result
  return toolEnds
}

const systemOf = (request: ScriptedRequest) =>
  request.messages.filter((m) => m.role === "system").map((m) => (isJsonString(m.content) ? m.content : ""))

const transcriptOf = (request: ScriptedRequest) =>
  request.messages
    .filter((m) => m.role !== "system")
    .map((m) => (isJsonString(m.content) ? m.content : m.content.map((p) => p.text ?? p.toolName ?? p.type).join("|")))

/** A first agent that ran one tool-using turn, checkpointed. */
const firstCheckpoint = async (backend: Backend) => {
  const { fetch } = recording()
  const agent = await createFxAgent({
    apiKey: "test",
    backend,
    fetch,
    model: "test/model-a",
    instructions: "INSTRUCTIONS-A",
    tools: [tool("alpha"), tool("beta")]
  })
  await runTurn(agent, "please call alpha")
  const checkpoint = await agent.checkpoint()
  await agent.close()
  return checkpoint
}

const restore = async (backend: Backend, checkpoint: Uint8Array, options: { model?: string; instructions?: string; tools?: Array<FxTool> }) => {
  const { requests, fetch } = recording()
  const agent = await createFxAgent({ apiKey: "test", backend, fetch, checkpoint, ...options })
  return { agent, requests }
}

const PRIOR_TRANSCRIPT = ["please call alpha", "alpha", "alpha", "answer to: please call alpha"]

describe.each(backends)("libfx checkpoint contract (%s)", (backend) => {
  it("stores the transcript but not instructions, tool definitions, or the model", async () => {
    const text = Buffer.from(await firstCheckpoint(backend)).toString("latin1")
    expect(text).toContain("please call alpha")
    expect(text).not.toContain("INSTRUCTIONS-A")
    expect(text).not.toContain("tool alpha")
    expect(text).not.toContain("model-a")
  })

  it("restores with new instructions, tools, and model, keeping the transcript", async () => {
    const checkpoint = await firstCheckpoint(backend)
    const executed: Array<string> = []
    const { agent, requests } = await restore(backend, checkpoint, {
      model: "test/model-b",
      instructions: "INSTRUCTIONS-B",
      tools: [tool("beta", "BETA-V2", executed), tool("gamma", "tool gamma", executed)]
    })
    await runTurn(agent, "please call gamma")
    await agent.close()

    const first = requests[0]!
    expect(first.model).toBe("test/model-b")
    expect(systemOf(first)).toEqual(["INSTRUCTIONS-B"])
    expect(first.tools).toEqual(["beta", "gamma"])
    expect(transcriptOf(first)).toEqual([...PRIOR_TRANSCRIPT, "please call gamma"])
    expect(executed).toEqual(["gamma"])
  })

  it("sends no system message when restored without instructions", async () => {
    const { agent, requests } = await restore(backend, await firstCheckpoint(backend), { model: "test/model-a" })
    await runTurn(agent, "hello again")
    await agent.close()
    expect(systemOf(requests[0]!)).toEqual([])
    expect(requests[0]!.tools).toEqual([])
  })

  it("answers a call to a tool that is no longer registered with an error result", async () => {
    const { agent } = await restore(backend, await firstCheckpoint(backend), { model: "test/model-a", tools: [tool("beta")] })
    const toolEnds = await runTurn(agent, "please call alpha")
    await agent.close()
    expect(toolEnds).toEqual([{ name: "alpha", isError: true }])
  })

  it("falls back to libfx's default model when restored without one (fx-durable must always pass it)", async () => {
    const { agent, requests } = await restore(backend, await firstCheckpoint(backend), {})
    await runTurn(agent, "hello again")
    await agent.close()
    expect(requests[0]!.model).not.toBe("test/model-a")
  })

  it("restores a checkpoint written by the other backend", async () => {
    const other: Backend = backend === "native" ? "wasm" : "native"
    const { agent, requests } = await restore(other, await firstCheckpoint(backend), { model: "test/model-a" })
    await runTurn(agent, "hello again")
    await agent.close()
    expect(transcriptOf(requests[0]!)).toEqual([...PRIOR_TRANSCRIPT, "hello again"])
  })
})

/**
 * Checkpoint format v1: "FXCP", u32le version, u32le JSON length, SHA-256 of
 * the JSON, then UTF-8 JSON `{ history, usage }`. Undocumented; compaction
 * that edits history must check the version and fall back if this changes.
 */
interface CheckpointBody {
  readonly history: Array<{ user: { text: string }; assistant: string; execution: { tool_steps: Array<Json> } }>
  readonly usage: Json
}

describe("libfx checkpoint format v1", () => {
  const HEADER = 44

  const decode = (checkpoint: Uint8Array) => {
    const bytes = Buffer.from(checkpoint)
    const json = bytes.subarray(HEADER)
    return {
      magic: bytes.subarray(0, 4).toString("latin1"),
      version: bytes.readUInt32LE(4),
      length: bytes.readUInt32LE(8),
      hash: bytes.subarray(12, HEADER),
      json,
      // SAFETY: test-only parse of the checkpoint body; the assertions below check its shape.
      body: JSON.parse(json.toString("utf8")) as CheckpointBody
    }
  }

  const encode = (body: CheckpointBody, hash?: Buffer) => {
    const json = Buffer.from(JSON.stringify(body))
    const header = Buffer.alloc(HEADER)
    header.write("FXCP", 0, "latin1")
    header.writeUInt32LE(1, 4)
    header.writeUInt32LE(json.length, 8)
    ;(hash ?? createHash("sha256").update(json).digest()).copy(header, 12)
    return new Uint8Array(Buffer.concat([header, json]))
  }

  it("has the expected header and body", async () => {
    const decoded = decode(await firstCheckpoint("native"))
    expect(decoded.magic).toBe("FXCP")
    expect(decoded.version).toBe(1)
    expect(decoded.length).toBe(decoded.json.length)
    expect(decoded.hash.equals(createHash("sha256").update(decoded.json).digest())).toBe(true)
    expect(decoded.body.history).toHaveLength(1)
    expect(decoded.body.history[0]!.user.text).toBe("please call alpha")
  })

  it.each(backends)("accepts an edited history with a recomputed hash (%s)", async (backend) => {
    const decoded = decode(await firstCheckpoint(backend))
    const summary = structuredClone(decoded.body.history[0]!)
    summary.user.text = "[summary] earlier work"
    summary.assistant = "Noted."
    summary.execution.tool_steps = []
    const { agent, requests } = await restore(backend, encode({ ...decoded.body, history: [summary] }), { model: "test/model-a" })
    await runTurn(agent, "next")
    await agent.close()
    expect(transcriptOf(requests[0]!)).toEqual(["[summary] earlier work", "Noted.", "next"])
  })

  it("rejects an edited history with a stale hash", async () => {
    const decoded = decode(await firstCheckpoint("native"))
    const stale = encode({ ...decoded.body, history: [] }, Buffer.from(decoded.hash))
    await expect(restore("native", stale, { model: "test/model-a" })).rejects.toThrow(/checkpoint/i)
  })
})
