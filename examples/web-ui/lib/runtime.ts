import { randomUUID } from "node:crypto"
import { cp, mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent"
import { DurableFx, sqlite, type DurableFxOptions } from "fx-durable"
import { scriptedModel } from "fx-durable/testing"
import { createFxDurableHarness } from "./fx-durable-harness"
import { live } from "./live"
import { localSandbox } from "./local-sandbox"
import { offlineScript } from "./offline-script"
import { CODING_RUNTIME, createCodingTools, EXPLORER_PROMPT, EXPLORER_RUNTIME, permissionHooks, SYSTEM_PROMPT } from "./tools"

export const DATA_DIR = join(process.cwd(), ".data")
const WORKSPACES_DIR = join(DATA_DIR, "workspaces")
const TEMPLATE_DIR = join(process.cwd(), "workspace-template")

export const OFFLINE = !process.env.AI_GATEWAY_API_KEY
export const DEFAULT_MODEL = process.env.FXD_MODEL ?? "anthropic/claude-sonnet-4.5"
export const MODELS = [
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "anthropic" },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", provider: "anthropic" },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "openai/gpt-5", name: "GPT-5", provider: "openai" },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" }
] as const

// ---------------------------------------------------------------------------
// One DurableFx + HarnessAgent per process
// ---------------------------------------------------------------------------

interface Runtime {
  readonly fx: DurableFx
  readonly agent: HarnessAgent<ReturnType<typeof createFxDurableHarness>>
  readonly sessions: Map<string, Promise<HarnessAgentSession>>
  readonly workspaces: Map<string, string>
}

const open = async (): Promise<Runtime> => {
  await mkdir(WORKSPACES_DIR, { recursive: true })
  // Before DurableFx.open(): recovered turns check permission modes.
  live.persistTo(join(DATA_DIR, "settings.json"))
  const workspaces = new Map<string, string>()
  let opened: DurableFx | undefined

  const workspaceOf = async (agentId: string) => {
    const cached = workspaces.get(agentId)
    if (cached) return cached
    const cwd = (await opened?.attach(agentId).then((a) => a.info()))?.cwd
    if (!cwd) throw new Error(`agent ${agentId} has no workspace`)
    workspaces.set(agentId, cwd)
    return cwd
  }
  const tools = createCodingTools(workspaceOf)

  const options: DurableFxOptions = {
    storage: sqlite(join(DATA_DIR, "fx.db")),
    runtimes: {
      [CODING_RUNTIME]: { tools: tools.coding, instructions: SYSTEM_PROMPT, hooks: permissionHooks },
      [EXPLORER_RUNTIME]: { tools: tools.explorer, instructions: EXPLORER_PROMPT }
    },
    // libfx streams the model's tokens itself; offline, a scripted model stands in.
    fetch: OFFLINE ? scriptedModel(offlineScript, { latencyMs: 500, chunkDelayMs: 12 }) : undefined,
    // Continue after `opened` is set: continued tool calls look up their workspace through it.
    recovery: "manual"
  }
  const fx = await DurableFx.open(options)
  opened = fx
  // Continue every request that was running when the previous process died.
  await fx.resume()

  const harness = createFxDurableHarness({
    fx,
    runtime: CODING_RUNTIME,
    tools: tools.coding,
    defaultModel: DEFAULT_MODEL,
    forkOf: (agentId) => live.forkOf(agentId)
  })
  // No `model` here: each durable agent keeps its own (switchable) model.
  const agent = new HarnessAgent({ harness, permissionMode: "allow-all" })
  return { fx, agent, sessions: new Map(), workspaces }
}

declare global {
  // Next dev reloads modules; keep one DurableFx per process.
  var fxDurableRuntime: Promise<Runtime> | undefined
}

export const runtime = (): Promise<Runtime> => (globalThis.fxDurableRuntime ??= open())

// ---------------------------------------------------------------------------
// Sessions: a durable agent + a HarnessAgent session + a workspace directory
// ---------------------------------------------------------------------------

/**
 * Fork a session from its conversation as it is now. A sample-project workspace is
 * copied, so the two sessions don't edit the same files; a directory you
 * chose is shared (it's yours).
 */
export const forkChatSession = async (sourceId: string) => {
  const { fx, workspaces } = await runtime()
  const source = await fx.attach(sourceId)
  const sourceCwd = (await source.info()).cwd
  const id = `s-${randomUUID().slice(0, 8)}`
  let cwd = sourceCwd
  if (sourceCwd?.startsWith(WORKSPACES_DIR)) {
    cwd = join(WORKSPACES_DIR, id)
    await cp(sourceCwd, cwd, { recursive: true })
  }
  // The fork's own session starts from the source's conversation; its history view shows the source's up to here.
  let cursor = 0
  for await (const line of source.events({ follow: false })) cursor = line.cursor ?? cursor
  await source.fork(id, { cwd })
  live.recordFork(id, { from: sourceId, cursor })
  live.setMode(id, live.modeOf(sourceId))
  if (cwd) workspaces.set(id, cwd)
  return { id, cwd: cwd ?? "" }
}

export const createChatSession = async (options: { readonly cwd?: string; readonly model?: string }) => {
  const { fx, workspaces } = await runtime()
  const id = `s-${randomUUID().slice(0, 8)}`
  let cwd = options.cwd?.trim()
  if (cwd) {
    if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) throw new Error(`${cwd} is not a directory`)
  } else {
    cwd = join(WORKSPACES_DIR, id)
    await cp(TEMPLATE_DIR, cwd, { recursive: true })
  }
  await fx.agent(id, { runtime: CODING_RUNTIME, model: options.model ?? DEFAULT_MODEL, cwd })
  workspaces.set(id, cwd)
  return { id, cwd }
}

export class UnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`unknown session ${sessionId}`)
  }
}

/**
 * The HarnessAgent session for a chat. The chat id is also the durable agent id.
 * Only sessions created with `createChatSession` exist: an unknown id (e.g. a
 * stale one from a browser tab) is an error, not a new agent.
 */
export const sessionFor = async (chatId: string): Promise<HarnessAgentSession> => {
  const { agent, sessions, fx } = await runtime()
  if (!sessions.has(chatId) && !(await fx.listAgents()).some((record) => record.id === chatId)) throw new UnknownSessionError(chatId)
  let session = sessions.get(chatId)
  if (!session) {
    // HarnessAgent wants a sandbox for its own bookkeeping; the project lives in the agent's cwd.
    session = agent.createSession({ sessionId: chatId, sandboxSession: localSandbox(join(DATA_DIR, "harness")) })
    sessions.set(chatId, session)
    session.catch(() => sessions.delete(chatId))
  }
  return session
}

export const setModel = async (chatId: string, model: string) => {
  const { fx } = await runtime()
  const info = await (await fx.attach(chatId)).info()
  await fx.agent(chatId, { runtime: info.runtimeId, model, cwd: info.cwd })
}
