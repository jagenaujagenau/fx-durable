import { Context, Effect, Layer } from "effect"
import type { McpClient } from "libfx/mcp"
import type { DurableTool } from "../tools/define-tool.js"
import type { ReplayPolicy } from "../tools/replay-policy.js"
import { RuntimeConfigurationError } from "./errors.js"
import type { DurableAgentRecord } from "./schema.js"

/**
 * A checkpoint cannot serialize executable TypeScript, so agents persist a
 * stable runtime id and recovery resolves it through the current registry.
 */

export interface McpClientSpec {
  /** A host-owned MCP client (MCP TypeScript SDK v1 `Client`). */
  readonly client: McpClient
  readonly prefix?: string
  readonly resources?: ReadonlyArray<string>
  readonly prompts?: ReadonlyArray<string>
  /** Replay policy for this server's tools. MCP tools default to `unsafe`. */
  readonly replay?: ReplayPolicy
  /** Per-tool replay policies, keyed by tool name; these win over `replay`. */
  readonly replayOverrides?: Readonly<Record<string, ReplayPolicy>>
  readonly close?: () => Promise<void>
}

export interface RuntimeDefinition {
  readonly tools?: ReadonlyArray<DurableTool>
  readonly instructions?: string
  readonly createMcpClients?: (agent: DurableAgentRecord) => Promise<ReadonlyArray<McpClientSpec>>
}

export interface RuntimeRegistryInterface {
  readonly register: (id: string, definition: RuntimeDefinition) => Effect.Effect<void>
  readonly resolve: (id: string) => Effect.Effect<RuntimeDefinition, RuntimeConfigurationError>
  readonly has: (id: string) => Effect.Effect<boolean>
  readonly ids: () => Effect.Effect<ReadonlyArray<string>>
}

export class RuntimeRegistry extends Context.Service<RuntimeRegistry, RuntimeRegistryInterface>()(
  "fx-durable/RuntimeRegistry"
) {
  static readonly layer = (initial: Readonly<Record<string, RuntimeDefinition>> = {}) =>
    Layer.sync(RuntimeRegistry, () => {
      const runtimes = new Map<string, RuntimeDefinition>(Object.entries(initial))
      return RuntimeRegistry.of({
        register: (id, definition) =>
          Effect.sync(() => {
            const names = new Set<string>()
            for (const tool of definition.tools ?? []) {
              if (names.has(tool.name)) throw new TypeError(`runtime ${id}: duplicate tool ${tool.name}`)
              names.add(tool.name)
            }
            runtimes.set(id, definition)
          }),
        resolve: (id) =>
          Effect.suspend(() => {
            const definition = runtimes.get(id)
            return definition
              ? Effect.succeed(definition)
              : Effect.fail(
                  new RuntimeConfigurationError({
                    runtimeId: id,
                    message: `runtime "${id}" is not registered in this application`
                  })
                )
          }),
        has: (id) => Effect.sync(() => runtimes.has(id)),
        ids: () => Effect.sync(() => [...runtimes.keys()])
      })
    })
}
