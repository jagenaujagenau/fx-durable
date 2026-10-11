import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1,
  type HarnessV1AssistantMessage,
  type HarnessV1BuiltinTool,
  type HarnessV1ContinueTurnState,
  type HarnessV1Message,
  type HarnessV1Prompt,
  type HarnessV1PromptControl,
  type HarnessV1ResumeSessionState,
  type HarnessV1StreamPart
} from "@ai-sdk/harness"
import type { JSONSchema7, LanguageModelV4FinishReason, LanguageModelV4Usage } from "@ai-sdk/provider"
import { jsonSchema, tool } from "@ai-sdk/provider-utils"
import { Schema } from "effect"
import { Submission, type DurableAgent, type DurableFx, type DurableTool, type FxStreamLine, type Json } from "fx-durable"

/**
 * A HarnessV1 adapter backed by fx-durable.
 *
 * `@ai-sdk/harness-fx` runs the fx CLI inside a sandbox over ACP. This adapter
 * runs the same agent kernel (libfx) in the host process instead, with
 * fx-durable around it. A harness session is a durable agent: the session id
 * is the agent id, and every prompt turn is a durable request. libfx keeps the
 * conversation as a durable session, so if the process dies mid-turn the turn
 * continues when fx-durable opens again, and `doReadHistory` /
 * `doContinueTurn` read it back from the session's stream.
 */

const HARNESS_ID = "fx-durable"

/** Where a fork came from: its source agent, and the source's last stream cursor at the fork. */
export interface ForkOrigin {
  readonly from: string
  readonly cursor: number
}

export interface FxDurableHarnessSettings {
  /** An open fx-durable runtime. The harness never closes it. */
  readonly fx: DurableFx
  /** Runtime id registered on `fx`. Its tools become the harness built-ins. */
  readonly runtime: string
  /** The same tools, so HarnessAgent can validate and type the tool calls. */
  readonly tools: ReadonlyArray<DurableTool>
  /** Model used when a turn does not name one. */
  readonly defaultModel: string
  /** A fork's session starts empty; its history begins with its source's, up to the fork. */
  readonly forkOf?: (agentId: string) => ForkOrigin | null
}

const TurnCursor = Schema.Struct({ agentId: Schema.String, submissionId: Schema.String, after: Schema.Number })
type TurnCursor = typeof TurnCursor.Type
const decodeTurnCursor = Schema.decodeUnknownSync(TurnCursor)
const isString = Schema.is(Schema.String)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const promptText = (prompt: HarnessV1Prompt): string => {
  if (isString(prompt)) return prompt
  if (isString(prompt.content)) return prompt.content
  return prompt.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

/** A tool's result from a stream line's `content`, which libfx cuts to a short preview. */
const previewOf = (content: string | undefined): Json => {
  if (content === undefined) return null
  const parsed = decodeJson(content)
  return parsed._tag === "Some" ? parsed.value : content
}

/**
 * A tool call's full result: from fx-durable's journal of the agent's tool
 * calls (keyed by the session and the call's id), or the line's preview.
 */
const resultOf = async (agent: DurableAgent, line: { readonly id: string; readonly content?: string | undefined }): Promise<Json> => {
  const { sessionId } = await agent.info()
  const [call] = sessionId ? await agent.toolCalls(sessionId, line.id) : []
  return call?.state === "completed" ? call.output : previewOf(line.content)
}

interface TurnUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly reasoningTokens?: number
}

const usageOf = (usage: TurnUsage | undefined): LanguageModelV4Usage => ({
  inputTokens: { total: usage?.inputTokens, noCache: undefined, cacheRead: usage?.cacheReadTokens, cacheWrite: undefined },
  outputTokens: { total: usage?.outputTokens, text: undefined, reasoning: usage?.reasoningTokens }
})

const finishReasonOf = (stopReason: string): LanguageModelV4FinishReason => {
  switch (stopReason) {
    case "end_turn":
      return { unified: "stop", raw: stopReason }
    case "max_output_tokens":
    case "max_model_turns":
      return { unified: "length", raw: stopReason }
    case "refused":
      return { unified: "content-filter", raw: stopReason }
    case "error":
      return { unified: "error", raw: stopReason }
    default:
      return { unified: "other", raw: stopReason }
  }
}

/** The durable tools, as the `ToolSet` HarnessAgent validates built-in tool calls against. */
const builtinToolsOf = (tools: ReadonlyArray<DurableTool>): Record<string, HarnessV1BuiltinTool> =>
  Object.fromEntries(
    tools.map((durable): [string, HarnessV1BuiltinTool] => [
      durable.name,
      tool({
        description: durable.description,
        // SAFETY: defineDurableTool derives `jsonSchema` from the tool's input schema, so it is a JSON Schema document.
        inputSchema: jsonSchema<unknown>(durable.jsonSchema as JSONSchema7),
        // fx-durable executes the tool and journals its JSON result.
        outputSchema: jsonSchema<unknown>({})
      })
    ])
  )

// ---------------------------------------------------------------------------
// Live translation: libfx stream lines → harness stream parts
// ---------------------------------------------------------------------------

/**
 * Translates one turn's stream lines into harness stream parts. Tool calls
 * are executed by fx-durable, so they are `providerExecuted`. A model step
 * ends when its tool results are in and the model speaks or calls again.
 */
const createTranslator = (agent: DurableAgent, emit: (part: HarnessV1StreamPart) => void) => {
  let textId: string | null = null
  let texts = 0
  let stepHasTools = false

  const closeText = () => {
    if (textId) emit({ type: "text-end", id: textId })
    textId = null
  }
  /** The model speaks or calls again after its tools ran: the previous step is over. */
  const nextStep = () => {
    if (!stepHasTools) return
    stepHasTools = false
    emit({ type: "finish-step", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: usageOf(undefined) })
  }

  /** Returns true when the turn ended. */
  const onLine = async (line: FxStreamLine): Promise<boolean> => {
    switch (line.type) {
      case "text_delta":
        nextStep()
        if (!textId) {
          textId = `text-${++texts}`
          emit({ type: "text-start", id: textId })
        }
        emit({ type: "text-delta", id: textId, delta: line.delta })
        return false
      case "tool_start":
        closeText()
        emit({ type: "tool-call", toolCallId: line.id, toolName: line.name, input: JSON.stringify(line.input ?? {}), providerExecuted: true })
        stepHasTools = true
        return false
      case "tool_end":
        // A tool that returned nothing has a null result; the stream part needs a value.
        emit({ type: "tool-result", toolCallId: line.id, toolName: line.name, result: line.isError ? (line.content ?? "") : ((await resultOf(agent, line)) ?? ""), isError: line.isError })
        return false
      case "turn_end": {
        closeText()
        emit({ type: "finish-step", finishReason: finishReasonOf(line.stopReason), usage: usageOf(line.usage) })
        if (line.stopReason === "error") emit({ type: "error", error: new Error(line.error?.message ?? "the turn failed") })
        emit({ type: "finish", finishReason: finishReasonOf(line.stopReason), totalUsage: usageOf(line.usage) })
        return true
      }
      default:
        return false
    }
  }

  return { onLine }
}

// ---------------------------------------------------------------------------
// History: the conversation, read back from the agent's session
// ---------------------------------------------------------------------------

const historyFromLines = async (agent: DurableAgent, lines: ReadonlyArray<FxStreamLine>): Promise<Array<HarnessV1Message>> => {
  const messages: Array<HarnessV1Message> = []
  let assistant: Array<HarnessV1AssistantMessage["content"][number]> = []
  let text = ""
  // Tool calls without a result yet, and guidance that arrived while they ran.
  const running = new Set<string>()
  const steering: Array<string> = []
  const flushText = () => {
    if (text.length > 0) assistant.push({ type: "text", text })
    text = ""
  }
  const flush = () => {
    flushText()
    if (assistant.length > 0) messages.push({ role: "assistant", content: assistant })
    assistant = []
  }

  for (const line of lines) {
    switch (line.type) {
      case "turn_start":
        flush()
        if (line.input) messages.push({ role: "user", content: [{ type: "text", text: line.input }] })
        break
      case "user_message":
        // Guidance typed while the turn ran: a user message in the middle of the turn, once
        // the tool calls running when it arrived have their results (they share a message).
        if (running.size === 0) {
          flush()
          messages.push({ role: "user", content: [{ type: "text", text: line.text }] })
        } else steering.push(line.text)
        break
      case "text_delta":
        text += line.delta
        break
      case "tool_start":
        flushText()
        running.add(line.id)
        assistant.push({ type: "tool-call", toolCallId: line.id, toolName: line.name, input: line.input ?? {}, providerExecuted: true })
        break
      case "tool_end":
        running.delete(line.id)
        assistant.push({
          type: "tool-result",
          toolCallId: line.id,
          toolName: line.name,
          output: line.isError ? { type: "error-text", value: line.content ?? "failed" } : { type: "json", value: await resultOf(agent, line) }
        })
        if (running.size === 0 && steering.length > 0) {
          flush()
          for (const text of steering.splice(0)) messages.push({ role: "user", content: [{ type: "text", text }] })
        }
        break
      case "turn_end":
        flush()
        break
    }
  }
  flush()
  return messages
}

interface Conversation {
  readonly messages: Array<HarnessV1Message>
  /** The last cursor read. */
  readonly cursor: number | null
}

export const createFxDurableHarness = (settings: FxDurableHarnessSettings): HarnessV1 => {
  const { fx, runtime, defaultModel } = settings

  /** An agent's conversation; a fork's begins with its source's (recursively), up to the fork. */
  const conversationOf = async (agentId: string, after: number, until: number | null, depth: number): Promise<Conversation> => {
    const agent = await fx.attach(agentId)
    const lines: Array<FxStreamLine> = []
    for await (const line of agent.events({ after, follow: false })) {
      if (until !== null && (line.cursor ?? 0) > until) break
      lines.push(line)
    }
    const origin = after === 0 && depth < 10 ? (settings.forkOf?.(agentId) ?? null) : null
    const prefix = origin ? ((await conversationOf(origin.from, 0, origin.cursor, depth + 1).catch(() => null))?.messages ?? []) : []
    return { messages: [...prefix, ...(await historyFromLines(agent, lines))], cursor: lines.at(-1)?.cursor ?? null }
  }

  const doStart: HarnessV1["doStart"] = async (options) => {
    // The session id is the durable agent id, so a new process attaches to the
    // same agent simply by reusing the session id.
    const agentId = options.sessionId
    // An agent the host already created keeps its model and workspace;
    // otherwise create one working in the session's directory.
    const existing = (await fx.listAgents()).find((record) => record.id === agentId)
    const cwd = existing?.cwd ?? options.sessionWorkDir
    let agent = existing ? await fx.attach(agentId) : await fx.agent(agentId, { runtime, model: defaultModel, cwd })
    let active: { readonly abort: AbortController; cursor: TurnCursor } | null = null

    const withModel = async (model: string | undefined) => {
      if (model && model !== (await agent.info()).model) agent = await fx.agent(agentId, { runtime, model, cwd })
      return agent
    }

    /** Pump a request's stream lines into `emit` until its turn ends. */
    const drive = (cursor: TurnCursor, emit: (part: HarnessV1StreamPart) => void, abortSignal?: AbortSignal): HarnessV1PromptControl => {
      const turn = { abort: new AbortController(), cursor }
      active = turn
      // A user abort cancels the durable request; a suspend or detach only stops listening.
      abortSignal?.addEventListener("abort", () => {
        void new Submission(fx, cursor.submissionId, agentId, null, false).cancel()
        turn.abort.abort()
      })
      const translator = createTranslator(agent, emit)
      const stopped = new Promise<IteratorReturnResult<undefined>>((resolve) =>
        turn.abort.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))
      )

      const done = (async () => {
        emit({ type: "stream-start", modelId: (await agent.info()).model })
        const lines = agent.events({ after: cursor.after })[Symbol.asyncIterator]()
        try {
          while (!turn.abort.signal.aborted) {
            const next = await Promise.race([lines.next(), stopped])
            if (next.done) break
            const line = next.value
            if (!("messageId" in line) || line.messageId !== cursor.submissionId) continue
            turn.cursor = { ...turn.cursor, after: line.cursor ?? turn.cursor.after }
            if (await translator.onLine(line)) break
          }
        } finally {
          void lines.return?.()
          if (active === turn) active = null
        }
      })()

      return {
        submitToolResult: () => {
          throw new HarnessCapabilityUnsupportedError({
            harnessId: HARNESS_ID,
            message: "fx-durable executes its own tools; host-executed tools are not supported."
          })
        },
        done
      }
    }

    const resumeState = (): HarnessV1ResumeSessionState => ({
      type: "resume-session",
      harnessId: HARNESS_ID,
      specificationVersion: "harness-v1",
      data: { agentId }
    })

    const continueFrom = options.continueFrom ?? options.resumeFrom?.continueFrom
    const suspended = continueFrom ? decodeTurnCursor(continueFrom.data) : null

    return {
      sessionId: options.sessionId,
      isResume: options.resumeFrom !== undefined || options.continueFrom !== undefined,

      async doPromptTurn(turn) {
        if (turn.tools.length > 0) {
          turn.emit({ type: "stream-start", warnings: [{ type: "other", message: "fx-durable ignores host-executed tools." }] })
        }
        const durable = await withModel(turn.model)
        const submission = await durable.submit(promptText(turn.prompt), { requestId: crypto.randomUUID() })
        return drive({ agentId, submissionId: submission.id, after: 0 }, turn.emit, turn.abortSignal)
      },

      async doContinueTurn(turn) {
        // The turn kept running (or continued after a crash) inside libfx;
        // re-attach to its session stream from the saved cursor.
        const cursor = active?.cursor ?? suspended
        if (!cursor) throw new Error("fx-durable: no suspended turn to continue")
        return drive(cursor, turn.emit, turn.abortSignal)
      },

      async doSuspendTurn(): Promise<HarnessV1ContinueTurnState> {
        const turn = active
        if (!turn) throw new Error("fx-durable: no active turn to suspend")
        turn.abort.abort()
        return { type: "continue-turn", harnessId: HARNESS_ID, specificationVersion: "harness-v1", data: { ...turn.cursor } }
      },

      async doReadHistory({ since } = {}) {
        const after = since ? Number(since) : 0
        const { messages, cursor } = await conversationOf(agentId, after, null, 0)
        return { messages, cursor: String(cursor ?? after) }
      },

      doCompact: async () => {
        throw new HarnessCapabilityUnsupportedError({ harnessId: HARNESS_ID, message: "libfx manages the context; there is no manual compaction." })
      },

      // The session is durable: detaching, stopping, and destroying all leave
      // it in libfx's store so the agent can be attached again later.
      doDetach: async () => {
        active?.abort.abort()
        return resumeState()
      },
      doStop: async () => {
        active?.abort.abort()
        return resumeState()
      },
      doDestroy: async () => {
        active?.abort.abort()
      }
    }
  }

  return {
    specificationVersion: "harness-v1",
    harnessId: HARNESS_ID,
    builtinTools: builtinToolsOf(settings.tools),
    doStart
  }
}
