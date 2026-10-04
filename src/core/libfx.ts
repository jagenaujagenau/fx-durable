import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { createFxAgent, type CreateFxAgentOptions, type FxTool, type FxTurnResult } from "libfx"
import { CheckpointError, ModelError } from "./errors.js"
import type { DurableAgentRecord, SubmissionContent, TurnUsage } from "./schema.js"

/**
 * The only module that talks to libfx. libfx owns the agent loop, model
 * interaction, conversation state, and opaque checkpoints; fx-durable never
 * inspects checkpoint bytes.
 */

/** The HTTP transport libfx uses for model requests. */
export type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type LibfxTool = FxTool

export interface FxSessionOptions {
  readonly agent: DurableAgentRecord
  readonly checkpoint: Uint8Array | null
  readonly instructions: string | undefined
  readonly tools: ReadonlyArray<LibfxTool>
  /** Transport used by libfx for model requests (fx-durable wraps it to journal model tasks). */
  readonly fetch: Transport
}

export interface PromptResult {
  readonly text: string
  readonly stopReason: string
  readonly usage: TurnUsage | null
}

export interface FxSession {
  readonly prompt: (content: SubmissionContent) => Effect.Effect<PromptResult, ModelError>
  readonly checkpoint: () => Effect.Effect<Uint8Array, CheckpointError>
  readonly close: () => Effect.Effect<void>
}

export interface LibFxInterface {
  readonly create: (options: FxSessionOptions) => Effect.Effect<FxSession, ModelError | CheckpointError>
  /** The underlying transport (global fetch, or an override such as a scripted model). */
  readonly transport: Transport
}

export class LibFx extends Context.Service<LibFx, LibFxInterface>()("fx-durable/LibFx") {}

export interface LibFxOptions {
  readonly apiKey?: string
  readonly fetch?: Transport
  readonly backend?: "auto" | "native" | "wasm"
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const usageOf = (result: FxTurnResult): TurnUsage | null => {
  const usage = result.usage
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return null
  if (usage.reasoningTokens === undefined) {
    return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens }
}

export const layer = (options: LibFxOptions = {}) =>
  Layer.effect(
    LibFx,
    Effect.gen(function* () {
      const configured = yield* Config.option(Config.Redacted("AI_GATEWAY_API_KEY"))
      const apiKey =
        options.apiKey ??
        Option.match(configured, { onNone: () => undefined, onSome: (key) => Redacted.value(key) }) ??
        (options.fetch ? "fx-durable-local" : undefined)
      const transport: Transport = options.fetch ?? ((input, init) => globalThis.fetch(input, init))

      const create = Effect.fn("LibFx.create")(function* (session: FxSessionOptions) {
        if (!apiKey) {
          return yield* new ModelError({
            agentId: session.agent.id,
            message: "AI_GATEWAY_API_KEY is not set and no model transport override was provided"
          })
        }
        const createOptions: CreateFxAgentOptions = {
          apiKey,
          model: session.agent.model,
          backend: options.backend ?? "auto",
          fetch: session.fetch
        }
        if (session.instructions) createOptions.instructions = session.instructions
        if (session.tools.length > 0) createOptions.tools = session.tools
        if (session.checkpoint) createOptions.checkpoint = session.checkpoint

        const agent = yield* Effect.tryPromise({
          try: () => createFxAgent(createOptions),
          catch: (cause) =>
            session.checkpoint
              ? new CheckpointError({
                  agentId: session.agent.id,
                  message: `failed to restore libfx agent: ${message(cause)}`,
                  cause
                })
              : new ModelError({ agentId: session.agent.id, message: `failed to create libfx agent: ${message(cause)}`, cause })
        })

        const prompt = (content: SubmissionContent) =>
          Effect.tryPromise({
            try: async (signal) => {
              const turn = agent.prompt(content, { signal })
              let text = ""
              for await (const event of turn) {
                if (event.type === "text_delta") text += event.delta
                // The result is the final answer: text after the last tool call.
                if (event.type === "tool_start") text = ""
              }
              const result = await turn.result
              return { text, stopReason: result.stopReason, usage: usageOf(result) }
            },
            catch: (cause) => new ModelError({ agentId: session.agent.id, message: message(cause), cause })
          })

        const checkpoint = () =>
          Effect.tryPromise({
            try: () => agent.checkpoint(),
            catch: (cause) => new CheckpointError({ agentId: session.agent.id, message: message(cause), cause })
          })

        const close = () => Effect.promise(() => agent.close().catch(() => undefined))

        return { prompt, checkpoint, close } satisfies FxSession
      })

      return LibFx.of({ create, transport })
    })
  )
