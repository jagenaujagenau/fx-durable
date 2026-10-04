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
import { Submission, type DurableAgent, type DurableEvent, type DurableFx, type DurableTool, type Json } from "fx-durable"

/**
 * A HarnessV1 adapter backed by fx-durable.
 *
 * `@ai-sdk/harness-fx` runs the fx CLI inside a sandbox over ACP. This adapter
 * runs the same agent kernel (libfx) in the host process instead, with
 * fx-durable's journal underneath. A harness session is a durable agent: the
 * session id is the agent id, and every prompt turn is a durable submission.
 * If the process dies mid-turn, fx-durable recovers the turn when it opens
 * again, and `doReadHistory` / `doContinueTurn` read the result from the journal.
 */

const HARNESS_ID = "fx-durable"

export interface FxDurableHarnessSettings {
  /** An open fx-durable runtime. The harness never closes it. */
  readonly fx: DurableFx
  /** Runtime id registered on `fx`. Its tools become the harness built-ins. */
  readonly runtime: string
  /** The same tools, so HarnessAgent can validate and type the tool calls. */
  readonly tools: ReadonlyArray<DurableTool>
  /** Model used when a turn does not name one. */
  readonly defaultModel: string
  /**
   * Optional live token stream: `subscribe(agentId, onDelta)` returns an
   * unsubscribe function. Without it, text arrives one model step at a time.
   */
  readonly textDeltas?: (agentId: string, onDelta: (taskId: string, delta: string) => void) => () => void
}

// ---------------------------------------------------------------------------
// Journal payloads, parsed at the boundary
// ---------------------------------------------------------------------------

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const SubmissionCreated = Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(TextBlock)]) })
const ModelCompleted = Schema.Struct({
  text: Schema.String,
  finishReason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({ inputTokens: Schema.NullOr(Schema.Number), outputTokens: Schema.NullOr(Schema.Number) })
})
const ToolEvent = Schema.Struct({
  tool: Schema.String,
  input: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number)
})
const SubmissionCompleted = Schema.Struct({
  text: Schema.String,
  stopReason: Schema.String,
  usage: Schema.NullOr(Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number }))
})
const SubmissionFailed = Schema.Struct({ error: Schema.optional(Schema.String) })
const TurnSteered = Schema.Struct({ text: Schema.String })
const TurnCursor = Schema.Struct({ agentId: Schema.String, submissionId: Schema.String, after: Schema.Number })
type TurnCursor = typeof TurnCursor.Type

const decodeSubmissionCreated = Schema.decodeUnknownSync(SubmissionCreated)
const decodeModelCompleted = Schema.decodeUnknownSync(ModelCompleted)
const decodeToolEvent = Schema.decodeUnknownSync(ToolEvent)
const decodeSubmissionCompleted = Schema.decodeUnknownSync(SubmissionCompleted)
const decodeSubmissionFailed = Schema.decodeUnknownSync(SubmissionFailed)
const decodeTurnSteered = Schema.decodeUnknownSync(TurnSteered)
const decodeTurnCursor = Schema.decodeUnknownSync(TurnCursor)
const isString = Schema.is(Schema.String)

interface TokenCounts {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
}

const NO_TOKENS: TokenCounts = { inputTokens: null, outputTokens: null }

const promptText = (prompt: HarnessV1Prompt): string => {
  if (isString(prompt)) return prompt
  if (isString(prompt.content)) return prompt.content
  return prompt.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

const contentText = (content: typeof SubmissionCreated.Type.content): string =>
  isString(content) ? content : content.map((block) => block.text).join("\n")

const usageOf = ({ inputTokens, outputTokens }: TokenCounts): LanguageModelV4Usage => ({
  inputTokens: { total: inputTokens ?? undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: outputTokens ?? undefined, text: undefined, reasoning: undefined }
})

const isUnifiedFinishReason = Schema.is(Schema.Literals(["stop", "length", "content-filter", "tool-calls", "error", "other"]))

const finishReasonOf = (raw: string | null): LanguageModelV4FinishReason => {
  const text = raw ?? "stop"
  if (isUnifiedFinishReason(text)) return { unified: text, raw: text }
  if (text === "refused") return { unified: "content-filter", raw: text }
  if (text === "max_tokens") return { unified: "length", raw: text }
  return { unified: "stop", raw: text }
}

const TERMINAL = new Set(["submission.completed", "submission.failed", "submission.cancelled"])

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
// Live translation: durable events → harness stream parts
// ---------------------------------------------------------------------------

/**
 * Translates one submission's durable events into harness stream parts.
 * Tool calls are executed by fx-durable, so they are `providerExecuted`.
 */
const createTranslator = (agent: DurableAgent, emit: (part: HarnessV1StreamPart) => void) => {
  const calls = new Set<string>()
  // Model tasks whose step has begun (from a live delta or `model.started`), and
  // those whose text was streamed live, so `model.completed` only closes it.
  const begun = new Set<string>()
  const streamed = new Set<string>()
  // A step ends when the next model call starts (or the turn ends), so the
  // tool calls a model step requested land inside that step.
  let openStep: HarnessV1StreamPart | null = null
  let lastText = ""
  // libfx starts a tool before the model step that requested it is journaled.
  // Hold those calls until the step's text is out, so text comes first.
  let modelRunning = false
  let deferred: Array<() => void> = []

  const emitText = (id: string, text: string) => {
    lastText = text
    emit({ type: "text-start", id })
    emit({ type: "text-delta", id, delta: text })
    emit({ type: "text-end", id })
  }
  const closeStep = () => {
    if (openStep) emit(openStep)
    openStep = null
  }
  const releaseDeferred = () => {
    for (const release of deferred) release()
    deferred = []
  }
  const beginStep = (taskId: string) => {
    if (begun.has(taskId)) return
    begun.add(taskId)
    releaseDeferred()
    closeStep()
    modelRunning = true
  }

  /** A live token delta for a model task of this agent. */
  const onDelta = (taskId: string, delta: string) => {
    beginStep(taskId)
    if (!streamed.has(taskId)) {
      streamed.add(taskId)
      emit({ type: "text-start", id: taskId })
    }
    lastText += delta
    emit({ type: "text-delta", id: taskId, delta })
  }

  const emitCall = (toolCallId: string, toolName: string, input: Json) => {
    if (calls.has(toolCallId)) return
    calls.add(toolCallId)
    emit({ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input), providerExecuted: true })
  }

  /** The tool's journaled output, read from the active turn's task records. */
  const outputOf = async (taskId: string): Promise<Json | null> => {
    const turn = await agent.currentTurn()
    return turn?.tasks.find((task) => task.id === taskId)?.output ?? null
  }

  const onEvent = async (event: DurableEvent): Promise<boolean> => {
    const taskId = event.taskId ?? event.id
    emit({ type: "raw", rawValue: { durableEvent: { sequence: event.sequence, type: event.type, payload: event.payload } } })

    switch (event.type) {
      case "model.started":
        beginStep(taskId)
        return false
      case "model.completed": {
        const model = decodeModelCompleted(event.payload)
        if (streamed.has(taskId)) {
          emit({ type: "text-end", id: taskId })
          lastText = model.text
        } else if (model.text.length > 0) {
          emitText(taskId, model.text)
        }
        modelRunning = false
        releaseDeferred()
        openStep = { type: "finish-step", finishReason: finishReasonOf(model.finishReason), usage: usageOf(model.usage) }
        return false
      }
      case "tool.started": {
        const call = decodeToolEvent(event.payload)
        const start = () => emitCall(taskId, call.tool, call.input ?? {})
        if (modelRunning) deferred.push(start)
        else start()
        return false
      }
      case "tool.completed":
      case "tool.reused":
      case "tool.replayed": {
        releaseDeferred()
        const call = decodeToolEvent(event.payload)
        emitCall(taskId, call.tool, call.input ?? {})
        const output = (await outputOf(taskId)) ?? { replayed: event.type !== "tool.completed" }
        emit({ type: "tool-result", toolCallId: taskId, toolName: call.tool, result: output })
        return false
      }
      case "tool.failed":
      case "tool.cancelled":
      case "tool.outcome_unknown": {
        releaseDeferred()
        const call = decodeToolEvent(event.payload)
        emitCall(taskId, call.tool, call.input ?? {})
        const result = event.type === "tool.outcome_unknown" ? "outcome unknown · not replayed" : (call.error ?? event.type)
        emit({ type: "tool-result", toolCallId: taskId, toolName: call.tool, result, isError: true })
        return false
      }
      case "submission.completed": {
        const submission = decodeSubmissionCompleted(event.payload)
        releaseDeferred()
        // The final model step can settle after the turn commits, in which
        // case its text is only on the submission result.
        if (submission.text.length > 0 && submission.text !== lastText) {
          emitText(event.id, submission.text)
          openStep ??= { type: "finish-step", finishReason: finishReasonOf(submission.stopReason), usage: usageOf(NO_TOKENS) }
        }
        closeStep()
        emit({ type: "finish", finishReason: finishReasonOf(submission.stopReason), totalUsage: usageOf(submission.usage ?? NO_TOKENS) })
        return true
      }
      case "submission.failed": {
        const failure = decodeSubmissionFailed(event.payload)
        closeStep()
        emit({ type: "error", error: new Error(failure.error ?? "submission failed") })
        emit({ type: "finish", finishReason: { unified: "error", raw: "failed" }, totalUsage: usageOf(NO_TOKENS) })
        return true
      }
      case "submission.cancelled":
        closeStep()
        emit({ type: "finish", finishReason: { unified: "other", raw: "cancelled" }, totalUsage: usageOf(NO_TOKENS) })
        return true
      default:
        return TERMINAL.has(event.type)
    }
  }

  return { onEvent, onDelta }
}

// ---------------------------------------------------------------------------
// History: the conversation, rebuilt from the agent's event log
// ---------------------------------------------------------------------------

const historyFromEvents = (events: ReadonlyArray<DurableEvent>, outputs: ReadonlyMap<string, Json>): Array<HarnessV1Message> => {
  const messages: Array<HarnessV1Message> = []
  let assistant: Array<HarnessV1AssistantMessage["content"][number]> = []
  let lastText = ""
  let stepStart = 0
  // The final model step can be journaled after its submission completed;
  // its text was already taken from the submission result.
  const settled = new Set<string>()
  const flush = () => {
    if (assistant.length > 0) messages.push({ role: "assistant", content: assistant })
    assistant = []
  }

  for (const event of events) {
    const toolCallId = event.taskId ?? event.id
    if (event.submissionId !== null && settled.has(event.submissionId)) continue
    if (event.submissionId !== null && TERMINAL.has(event.type)) settled.add(event.submissionId)

    switch (event.type) {
      case "submission.created":
        flush()
        messages.push({
          role: "user",
          content: [{ type: "text", text: contentText(decodeSubmissionCreated(event.payload).content) }],
          at: event.createdAt.toISOString()
        })
        break
      case "turn.steered":
        // Guidance typed while the turn ran: a user message in the middle of the turn.
        flush()
        messages.push({
          role: "user",
          content: [{ type: "text", text: decodeTurnSteered(event.payload).text }],
          at: event.createdAt.toISOString()
        })
        stepStart = 0
        break
      case "model.started":
        stepStart = assistant.length
        break
      case "model.completed": {
        const { text } = decodeModelCompleted(event.payload)
        if (text.length > 0) {
          // Tools of this step may already be listed; the text precedes them.
          assistant.splice(stepStart, 0, { type: "text", text })
          lastText = text
        }
        break
      }
      case "tool.started": {
        const call = decodeToolEvent(event.payload)
        assistant.push({ type: "tool-call", toolCallId, toolName: call.tool, input: call.input ?? {}, providerExecuted: true })
        break
      }
      case "tool.completed":
      case "tool.failed":
      case "tool.outcome_unknown": {
        const call = decodeToolEvent(event.payload)
        assistant.push({
          type: "tool-result",
          toolCallId,
          toolName: call.tool,
          output:
            event.type === "tool.completed"
              ? { type: "json", value: outputs.get(toolCallId) ?? { status: "completed", durationMs: call.durationMs ?? null } }
              : { type: "error-text", value: event.type === "tool.failed" ? (call.error ?? "failed") : "outcome unknown · not replayed" }
        })
        break
      }
      case "submission.completed": {
        const { text } = decodeSubmissionCompleted(event.payload)
        if (text.length > 0 && text !== lastText) assistant.push({ type: "text", text })
        flush()
        break
      }
      case "submission.failed":
      case "submission.cancelled":
        flush()
        break
    }
  }
  flush()
  return messages
}

const AgentForked = Schema.Struct({ from: Schema.String, checkpoint: Schema.NullOr(Schema.Number) })
const CheckpointCreated = Schema.Struct({ sequence: Schema.Number })
const isAgentForked = Schema.is(AgentForked)
const isCheckpointCreated = Schema.is(CheckpointCreated)

interface Conversation {
  readonly messages: Array<HarnessV1Message>
  /** The last event sequence read. */
  readonly cursor: number | null
}

/**
 * An agent's conversation from its journal. A fork's journal starts empty, so
 * its history begins with its source's, up to the checkpoint it was forked
 * from (recursively, for forks of forks). `until` cuts a source there.
 */
const conversationOf = async (fx: DurableFx, agentId: string, after: number, until: number | null, depth: number): Promise<Conversation> => {
  const agent = await fx.attach(agentId)
  const events: Array<DurableEvent> = []
  for await (const event of agent.events({ after, follow: false })) {
    events.push(event)
    if (until !== null && event.type === "checkpoint.created" && isCheckpointCreated(event.payload) && event.payload.sequence === until) break
  }

  const forked = after === 0 ? events.find((event) => event.type === "agent.forked") : undefined
  const prefix =
    forked && isAgentForked(forked.payload) && forked.payload.checkpoint !== null && depth < 10
      ? (await conversationOf(fx, forked.payload.from, 0, forked.payload.checkpoint, depth + 1).catch(() => null))?.messages ?? []
      : []

  // Tool results live in the task journal, not in the events.
  const outputs = new Map<string, Json>()
  await Promise.all(
    events
      .filter((event) => event.type === "tool.completed" && event.taskId !== null)
      .map(async (event) => {
        const task = await agent.task(event.taskId ?? "").catch(() => null)
        if (task?.output !== null && task?.output !== undefined) outputs.set(task.id, task.output)
      })
  )
  return { messages: [...prefix, ...historyFromEvents(events, outputs)], cursor: events.at(-1)?.sequence ?? null }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

interface ActiveTurn {
  readonly abort: AbortController
  cursor: TurnCursor
}

export const createFxDurableHarness = (settings: FxDurableHarnessSettings): HarnessV1 => {
  const { fx, runtime, defaultModel } = settings

  const doStart: HarnessV1["doStart"] = async (options) => {
    // The session id is the durable agent id, so a new process attaches to the
    // same journal simply by reusing the session id.
    const agentId = options.sessionId
    // An agent the host already created keeps its model and workspace;
    // otherwise create one working in the session's directory.
    const existing = (await fx.listAgents()).find((record) => record.id === agentId)
    const cwd = existing?.cwd ?? options.sessionWorkDir
    let agent = existing ? await fx.attach(agentId) : await fx.agent(agentId, { runtime, model: defaultModel, cwd })
    let active: ActiveTurn | null = null

    const withModel = async (model: string | undefined) => {
      if (model && model !== (await agent.info()).model) agent = await fx.agent(agentId, { runtime, model, cwd })
      return agent
    }

    /** Pump a submission's events into `emit` until it reaches a terminal state. */
    const drive = (cursor: TurnCursor, emit: (part: HarnessV1StreamPart) => void, abortSignal?: AbortSignal): HarnessV1PromptControl => {
      const turn: ActiveTurn = { abort: new AbortController(), cursor }
      active = turn
      // A user abort cancels the durable submission; a suspend or detach only stops listening.
      abortSignal?.addEventListener("abort", () => {
        void new Submission(fx, cursor.submissionId, agentId, null, false).cancel()
        turn.abort.abort()
      })
      const translator = createTranslator(agent, emit)
      // Journal events and live deltas go through one queue, in arrival order.
      let queue: Promise<unknown> = Promise.resolve()
      const serially = <A>(task: () => A | Promise<A>): Promise<A> => {
        const next = queue.then(task)
        queue = next.catch(() => undefined)
        return next
      }
      const unsubscribe = settings.textDeltas?.(agentId, (taskId, delta) => {
        if (!turn.abort.signal.aborted) void serially(() => translator.onDelta(taskId, delta))
      })
      const stopped = new Promise<IteratorReturnResult<undefined>>((resolve) =>
        turn.abort.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))
      )

      const done = (async () => {
        emit({ type: "stream-start", modelId: (await agent.info()).model })
        const events = agent.events({ after: cursor.after })[Symbol.asyncIterator]()
        try {
          while (!turn.abort.signal.aborted) {
            const next = await Promise.race([events.next(), stopped])
            if (next.done) break
            if (next.value.submissionId !== cursor.submissionId) continue
            turn.cursor = { ...turn.cursor, after: next.value.sequence }
            const event = next.value
            if (await serially(() => translator.onEvent(event))) break
          }
        } finally {
          unsubscribe?.()
          void events.return?.()
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
        // The turn kept running (or was recovered) inside fx-durable; re-attach
        // to its event log from the saved cursor. Nothing is recomputed.
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
        const { messages, cursor } = await conversationOf(fx, agentId, after, null, 0)
        return { messages, cursor: String(cursor ?? after) }
      },

      doCompact: async () => {
        throw new HarnessCapabilityUnsupportedError({ harnessId: HARNESS_ID, message: "fx-durable does not expose manual compaction." })
      },

      // The journal is the session: detaching, stopping, and destroying all
      // leave it in SQLite so the agent can be attached again later.
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
