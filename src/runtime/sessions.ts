import { Context, Effect, Layer } from "effect"
import { createFxAgent, type Durability, type FxAgent, type FxFetch, type FxModelCatalogEntry, type FxNodeAgentOptions } from "libfx"
import { RuntimeConfigurationError } from "../domain/errors.js"
import type { DurableTool } from "../tools/define-tool.js"
import { repairedFetch } from "./transport.js"
import { ToolExecutor } from "./tool-executor.js"

/**
 * The only module that creates libfx agents. libfx keeps every conversation
 * as a durable session: it stores each step, continues a turn a crash cut
 * off, queues requests, and replays events from any point.
 *
 * A libfx agent's tools are fixed when it is created, and the libfx agents
 * that share a session store also share its work: any of them may run a
 * session's turn. So each session store has exactly one libfx agent, with
 * the tools of one tool set. fx-durable keeps a store per tool set (named by
 * its key), and a store of its own for each session started from a
 * checkpoint (a fork, or an agent whose tools changed).
 */

/** Where libfx keeps the sessions of one store (`store` names it; it is safe in a path). */
export type DurabilityFor = (store: string) => Durability

export interface SessionsOptions {
  /** One durability for every store (then all agents must share one tool set), or one per store. */
  readonly durability: Durability | DurabilityFor
  readonly apiKey?: string
  readonly fetch?: FxFetch
  readonly modelCatalog?: ReadonlyArray<FxModelCatalogEntry>
  readonly backend?: "auto" | "native" | "wasm"
}

export interface SessionsInterface {
  /**
   * The libfx agent of a session store, created on first use with `offered`
   * as its tools. A store created with `checkpoint` starts its new sessions
   * from it.
   */
  readonly agentFor: (
    store: string,
    offered: ReadonlyArray<DurableTool>,
    checkpoint?: Uint8Array
  ) => Effect.Effect<FxAgent, RuntimeConfigurationError>
  /** Wait for the turns this process runs, then let their sessions go. */
  readonly close: () => Promise<void>
}

export class Sessions extends Context.Service<Sessions, SessionsInterface>()("fx-durable/Sessions") {}

const isDurabilityFor = (durability: Durability | DurabilityFor): durability is DurabilityFor => durability instanceof Function

export const layer = (options: SessionsOptions) =>
  Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const executor = yield* ToolExecutor
      const agents = new Map<string, FxAgent>()
      const fetch = repairedFetch(options.fetch)
      // A transport override (such as the scripted model) needs no real credential.
      const apiKey = options.apiKey ?? (options.fetch && !process.env.AI_GATEWAY_API_KEY ? "fx-durable-local" : undefined)

      const agentFor = (store: string, offered: ReadonlyArray<DurableTool>, checkpoint?: Uint8Array) =>
        Effect.suspend(() => {
          const existing = agents.get(store)
          if (existing) return Effect.succeed(existing)
          if (!isDurabilityFor(options.durability) && agents.size > 0) {
            return Effect.fail(
              new RuntimeConfigurationError({
                runtimeId: store,
                message: "a single `durability` holds one tool set's sessions; pass `durability: (store) => …` to give each its own"
              })
            )
          }
          const durability = isDurabilityFor(options.durability) ? options.durability(store) : options.durability
          const created: FxNodeAgentOptions = { tools: [...executor.hostTools(offered)], durability, fetch }
          if (apiKey !== undefined) created.apiKey = apiKey
          if (options.modelCatalog !== undefined) created.modelCatalog = options.modelCatalog
          if (options.backend !== undefined) created.backend = options.backend
          if (checkpoint !== undefined) created.checkpoint = checkpoint
          const agent = createFxAgent(created)
          agents.set(store, agent)
          return Effect.succeed(agent)
        })

      const close = async () => {
        const all = [...agents.values()]
        agents.clear()
        await Promise.allSettled(all.map((agent) => agent.close()))
      }

      yield* Effect.addFinalizer(() => Effect.promise(close))
      return Sessions.of({ agentFor, close })
    })
  )
