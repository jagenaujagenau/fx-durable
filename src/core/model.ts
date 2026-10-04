import { Option, Schema } from "effect"
import type { CrashInjectorInterface } from "./crash.js"
import { InterruptedError } from "./errors.js"
import type { Transport } from "./transport.js"
import type { Journal } from "./journal.js"
import type { TurnContext } from "./turn-context.js"

/**
 * Model calls are journaled by wrapping the transport libfx uses. Each model
 * request becomes a `model` task: intent is committed before the request is
 * sent, and the result (usage, text) after the response body has drained.
 *
 * Model requests are replay-safe: an interrupted model task is simply redone
 * by the recovered turn. Parsing of the response stream is best-effort
 * observability only — the bytes are always forwarded to libfx untouched.
 */

const MODEL_ENDPOINT = /\/ai\/language-model$/

interface StreamSummary {
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
  const summary: StreamSummary = { text: "", toolCalls: [], finishReason: null, inputTokens: null, outputTokens: null }
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
  journal: Journal,
  crash: CrashInjectorInterface
): Transport => {
  const begin = (ctx: TurnContext): string => {
    if (journal.storage.getSubmission(ctx.submissionId)?.cancelRequested) {
      throw new InterruptedError({ message: "model request refused: submission cancellation requested" })
    }
    const task = journal.startTask({
      turnId: ctx.turnId,
      agentId: ctx.agentId,
      type: "model",
      name: ctx.model,
      attempt: ctx.attempt,
      replayPolicy: "safe",
      event: { type: "model.started", submissionId: ctx.submissionId, payload: { model: ctx.model } }
    })
    crash.hitSync("model.before-request", { name: ctx.model })
    return task.id
  }

  const complete = (ctx: TurnContext, taskId: string, summary: StreamSummary, startedAt: number): void => {
    const durationMs = Date.now() - startedAt
    journal.transitionTask(
      taskId,
      "completed",
      {
        output: { text: summary.text, toolCalls: summary.toolCalls, finishReason: summary.finishReason },
        metadata: { durationMs, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens }
      },
      {
        type: "model.completed",
        submissionId: ctx.submissionId,
        payload: {
          model: ctx.model,
          durationMs,
          text: summary.text,
          toolCalls: summary.toolCalls,
          finishReason: summary.finishReason,
          usage: { inputTokens: summary.inputTokens, outputTokens: summary.outputTokens }
        }
      }
    )
    crash.hitSync("model.after-response", { name: ctx.model })
  }

  const fail = (ctx: TurnContext, taskId: string, error: string): void => {
    const task = journal.storage.getTask(taskId)
    if (!task || task.state !== "running") return
    journal.transitionTask(
      taskId,
      "failed",
      { error },
      { type: "model.failed", submissionId: ctx.submissionId, payload: { model: ctx.model, error } }
    )
  }

  const durableFetch: Transport = async (input, init) => {
    const ctx = holder.current
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    if (!ctx || !MODEL_ENDPOINT.test(new URL(url).pathname)) return transport(input, init)

    // Journal writes are synchronous: each is committed before the next step.
    const taskId = begin(ctx)
    const startedAt = Date.now()

    let response: Response
    try {
      response = await transport(input, init)
    } catch (error) {
      fail(ctx, taskId, error instanceof Error ? error.message : String(error))
      throw error
    }
    if (!response.ok || !response.body) {
      fail(ctx, taskId, `HTTP ${response.status}`)
      return response
    }

    const observer = observeSse()
    let first = true
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (first) {
            first = false
            crash.hitSync("model.during-stream", { name: ctx.model })
          }
          observer.push(chunk)
          controller.enqueue(chunk)
        },
        flush() {
          observer.end()
          complete(ctx, taskId, observer.summary, startedAt)
        }
      })
    )
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  return durableFetch
}

