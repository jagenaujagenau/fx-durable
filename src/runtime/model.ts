import { Option, Schema } from "effect"
import type { CrashInjectorInterface } from "./crash.js"
import type { Transport, TransportContext } from "../domain/transport.js"
import type { ModelJournal } from "./database.js"
import type { TurnContext } from "./turn-context.js"

/**
 * Model calls are journaled by wrapping the transport libfx uses. Each model
 * request becomes a `model` task: intent is committed before the request is
 * sent, and the result (usage, text) once the stream's `finish` part arrives,
 * before libfx sees it. (libfx may stop reading after `finish`, so waiting for
 * the body to drain would let the turn complete before its last model call.)
 *
 * Model requests are replay-safe: an interrupted model task is simply redone
 * by the recovered turn. Parsing of the response stream is best-effort
 * observability only. The bytes are forwarded to libfx unchanged, except that
 * multi-line tool-call inputs are made single-line (see `normalizeLine`).
 */

const MODEL_ENDPOINT = /\/ai\/language-model$/

/** How often a running task's streamed progress is journaled. */
export const PROGRESS_MS = 100

interface StreamSummary {
  finished: boolean
  text: string
  toolCalls: Array<string>
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
}

// The gateway stream parts fx-durable summarizes. Other part types are ignored.
const TokenCount = Schema.Struct({ total: Schema.optional(Schema.Number) })
const GatewayPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text-delta"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool-call"), toolName: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("finish"),
    finishReason: Schema.optional(Schema.Struct({ unified: Schema.optional(Schema.String) })),
    usage: Schema.optional(
      Schema.Struct({ inputTokens: Schema.optional(TokenCount), outputTokens: Schema.optional(TokenCount) })
    )
  })
])
const decodePart = Schema.decodeUnknownOption(Schema.fromJsonString(GatewayPart))

// libfx (0.0.12) fails to parse a `tool-call` whose `input` JSON contains line
// breaks, which models emit when they pretty-print arrays of objects. The input
// is re-serialized compactly before libfx sees it; its meaning is unchanged.
const ToolCallPart = Schema.Struct({ type: Schema.Literal("tool-call"), input: Schema.String })
const decodeToolCall = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCallPart))
const decodeJsonRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** One SSE line, with a multi-line tool-call input made single-line. Other lines pass through. */
const normalizeLine = (line: string): string => {
  if (!line.startsWith("data:") || !line.includes("tool-call")) return line
  const raw = line.slice(5).trim()
  const call = decodeToolCall(raw)
  if (Option.isNone(call) || !call.value.input.includes("\n")) return line
  const part = decodeJsonRecord(raw)
  const input = decodeJson(call.value.input)
  if (Option.isNone(part) || Option.isNone(input)) return line
  return `data: ${JSON.stringify({ ...part.value, input: JSON.stringify(input.value) })}`
}

/** Line-buffered rewrite of an SSE byte stream with `normalizeLine`. */
const lineRewriter = () => {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  return {
    push(chunk: Uint8Array): Uint8Array {
      buffer += decoder.decode(chunk, { stream: true })
      const end = buffer.lastIndexOf("\n")
      if (end < 0) return new Uint8Array()
      const complete = buffer.slice(0, end + 1)
      buffer = buffer.slice(end + 1)
      return encoder.encode(complete.split("\n").map(normalizeLine).join("\n"))
    },
    end(): Uint8Array {
      const rest = buffer + decoder.decode()
      buffer = ""
      return encoder.encode(normalizeLine(rest))
    }
  }
}

/** Metadata persisted on completed `model` tasks. */
export const ModelTaskMetadata = Schema.Struct({
  durationMs: Schema.Number,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number)
})
export const decodeModelTaskMetadata = Schema.decodeUnknownOption(ModelTaskMetadata)

const observeSse = () => {
  const decoder = new TextDecoder()
  let buffer = ""
  const summary: StreamSummary = { finished: false, text: "", toolCalls: [], finishReason: null, inputTokens: null, outputTokens: null }
  const line = (raw: string) => {
    if (!raw.startsWith("data:")) return
    const part = decodePart(raw.slice(5).trim())
    if (Option.isNone(part)) return
    const value = part.value
    switch (value.type) {
      case "text-delta":
        summary.text += value.delta
        break
      case "tool-call":
        summary.toolCalls.push(value.toolName)
        break
      case "finish":
        summary.finished = true
        summary.finishReason = value.finishReason?.unified ?? null
        summary.inputTokens = value.usage?.inputTokens?.total ?? null
        summary.outputTokens = value.usage?.outputTokens?.total ?? null
        break
    }
  }
  return {
    summary,
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, index).replace(/\r$/, ""))
        buffer = buffer.slice(index + 1)
      }
    },
    end() {
      if (buffer) line(buffer)
      buffer = ""
    }
  }
}

export interface ModelTransportHolder {
  /** The attempt currently using this session, or null when idle. */
  current: TurnContext | null
}

/**
 * Build the journaling transport handed to libfx for one agent session.
 * Plain code: it runs inside libfx's fetch callback and writes to the
 * synchronous journal directly.
 */
export const makeDurableFetch = (
  holder: ModelTransportHolder,
  transport: Transport,
  models: ModelJournal,
  crash: CrashInjectorInterface
): Transport => {
  const callOf = (ctx: TurnContext) => ({
    agentId: ctx.agentId,
    submissionId: ctx.submissionId,
    turnId: ctx.turnId,
    attempt: ctx.attempt,
    model: ctx.model
  })

  const begin = (ctx: TurnContext): string => {
    const taskId = models.modelStarted(callOf(ctx))
    crash.hitSync("model.before-request", { name: ctx.model })
    return taskId
  }

  const complete = (ctx: TurnContext, taskId: string, summary: StreamSummary, startedAt: number): void => {
    models.modelCompleted(callOf(ctx), taskId, { ...summary, durationMs: Date.now() - startedAt })
    crash.hitSync("model.after-response", { name: ctx.model })
  }

  const fail = (ctx: TurnContext, taskId: string, error: string): void => {
    models.modelFailed(callOf(ctx), taskId, error)
  }

  const durableFetch: Transport = async (input, init) => {
    const ctx = holder.current
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    if (!ctx || !MODEL_ENDPOINT.test(new URL(url).pathname)) return transport(input, init)

    // Journal writes are synchronous: each is committed before the next step.
    const taskId = begin(ctx)
    const startedAt = Date.now()

    const context: TransportContext = {
      agentId: ctx.agentId,
      submissionId: ctx.submissionId,
      turnId: ctx.turnId,
      taskId,
      model: ctx.model
    }
    let response: Response
    try {
      response = await transport(input, init, context)
    } catch (error) {
      fail(ctx, taskId, error instanceof Error ? error.message : String(error))
      throw error
    }
    if (!response.ok || !response.body) {
      fail(ctx, taskId, `HTTP ${response.status}`)
      return response
    }

    const observer = observeSse()
    const rewriter = lineRewriter()
    let first = true
    // Partial text for viewers that attach mid-response, at most every PROGRESS_MS.
    let progressAt = 0
    let progressText = ""
    let completed = false
    const completeOnce = () => {
      if (completed) return
      completed = true
      complete(ctx, taskId, observer.summary, startedAt)
    }
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (first) {
            first = false
            crash.hitSync("model.during-stream", { name: ctx.model })
          }
          observer.push(chunk)
          const now = Date.now()
          if (!completed && now - progressAt >= PROGRESS_MS && observer.summary.text !== progressText) {
            progressAt = now
            progressText = observer.summary.text
            models.recordProgress(taskId, progressText)
          }
          if (observer.summary.finished) completeOnce()
          const rewritten = rewriter.push(chunk)
          if (rewritten.byteLength > 0) controller.enqueue(rewritten)
        },
        flush(controller) {
          observer.end()
          completeOnce()
          const rest = rewriter.end()
          if (rest.byteLength > 0) controller.enqueue(rest)
        }
      })
    )
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  return durableFetch
}

