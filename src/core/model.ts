import { Effect, Exit, Option, Schema } from "effect"
import { CrashInjector } from "./crash.js"
import { InterruptedError } from "./errors.js"
import type { Transport } from "./transport.js"
import { Storage } from "./storage.js"
import { TaskEngine } from "./task.js"
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

type Services = Storage | TaskEngine | CrashInjector

/** Build the journaling transport handed to libfx for one agent session. */
export const makeDurableFetch = Effect.fnUntraced(function* (
  holder: ModelTransportHolder,
  transport: Transport
) {
  const context = yield* Effect.context<Services>()
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromiseWith(context)(effect)
  const runSync = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runSyncWith(context)(effect)

  const begin = (ctx: TurnContext) =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const engine = yield* TaskEngine
      const crash = yield* CrashInjector
      const submission = yield* storage.getSubmission(ctx.submissionId)
      if (submission?.cancelRequested) {
        return yield* new InterruptedError({ message: "submission cancellation requested" })
      }
      const task = yield* engine.startTask({
        turnId: ctx.turnId,
        agentId: ctx.agentId,
        type: "model",
        name: ctx.model,
        attempt: ctx.attempt,
        replayPolicy: "safe",
        event: { type: "model.started", submissionId: ctx.submissionId, payload: { model: ctx.model } }
      })
      yield* crash.hit("model.before-request", { name: ctx.model })
      return task.id
    })

  const complete = (ctx: TurnContext, taskId: string, summary: StreamSummary, startedAt: number) =>
    Effect.gen(function* () {
      const engine = yield* TaskEngine
      const crash = yield* CrashInjector
      const durationMs = Date.now() - startedAt
      yield* engine.transitionTask(
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
      yield* crash.hit("model.after-response", { name: ctx.model })
    })

  const fail = (ctx: TurnContext, taskId: string, error: string) =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const engine = yield* TaskEngine
      const task = yield* storage.getTask(taskId)
      if (!task || task.state !== "running") return
      yield* engine.transitionTask(
        taskId,
        "failed",
        { error },
        { type: "model.failed", submissionId: ctx.submissionId, payload: { model: ctx.model, error } }
      )
    })

  const durableFetch: Transport = async (input, init) => {
    const ctx = holder.current
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    if (!ctx || !MODEL_ENDPOINT.test(new URL(url).pathname)) return transport(input, init)

    const begun = await Effect.runPromiseExitWith(context)(begin(ctx))
    if (Exit.isFailure(begun)) throw new Error("model request refused: turn is being cancelled")
    const taskId = begun.value
    const startedAt = Date.now()
    const track = <A>(p: Promise<A>) => {
      ctx.inflight.add(p)
      p.finally(() => ctx.inflight.delete(p)).catch(() => undefined)
      return p
    }

    let response: Response
    try {
      response = await transport(input, init)
    } catch (error) {
      await track(run(fail(ctx, taskId, error instanceof Error ? error.message : String(error))))
      throw error
    }
    if (!response.ok || !response.body) {
      await track(run(fail(ctx, taskId, `HTTP ${response.status}`)))
      return response
    }

    const observer = observeSse()
    let first = true
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (first) {
            first = false
            runSync(Effect.flatMap(CrashInjector, (crash) => crash.hit("model.during-stream", { name: ctx.model })))
          }
          observer.push(chunk)
          controller.enqueue(chunk)
        },
        async flush() {
          observer.end()
          await track(run(complete(ctx, taskId, observer.summary, startedAt)))
        }
      })
    )
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  return durableFetch
})

