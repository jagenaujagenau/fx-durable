import { Context, Effect, Layer, type Scope } from "effect"
import { RuntimeConfigurationError } from "../core/errors.js"
import type { McpClientSpec, RuntimeDefinition } from "../core/runtime.js"
import type { DurableAgentRecord } from "../core/schema.js"
import type { McpAdapterOptions } from "libfx/mcp"
import { defineDurableTool, type DurableTool } from "./define-tool.js"
import type { ReplayPolicy } from "./replay-policy.js"

export interface ResolvedTools {
  readonly tools: ReadonlyArray<DurableTool>
  readonly byName: ReadonlyMap<string, DurableTool>
  readonly instructions: string | undefined
}

export interface ToolRegistryInterface {
  /**
   * Resolve the executable tools for an agent from its runtime definition,
   * including MCP adapters. MCP clients are closed when the scope closes.
   */
  readonly resolve: (
    agent: DurableAgentRecord,
    runtime: RuntimeDefinition
  ) => Effect.Effect<ResolvedTools, RuntimeConfigurationError, Scope.Scope>
}

export class ToolRegistry extends Context.Service<ToolRegistry, ToolRegistryInterface>()("fx-durable/ToolRegistry") {}

const mcpPolicy = (spec: McpClientSpec, name: string): ReplayPolicy =>
  spec.replayOverrides?.[name] ?? spec.replay ?? "unsafe"

const adapterOptions = (spec: McpClientSpec): McpAdapterOptions => {
  const options: McpAdapterOptions = {}
  if (spec.prefix) options.prefix = spec.prefix
  if (spec.resources) options.resources = spec.resources
  if (spec.prompts) options.prompts = spec.prompts
  return options
}

export const layer = Layer.succeed(
  ToolRegistry,
  ToolRegistry.of({
    resolve: (agent, runtime) =>
      Effect.gen(function* () {
        const tools: Array<DurableTool> = [...(runtime.tools ?? [])]
        const instructions: Array<string> = []
        if (runtime.instructions) instructions.push(runtime.instructions)

        if (runtime.createMcpClients) {
          const specs = yield* Effect.tryPromise({
            try: () => runtime.createMcpClients!(agent),
            catch: (cause) =>
              new RuntimeConfigurationError({ runtimeId: agent.runtimeId, message: `createMcpClients failed: ${String(cause)}` })
          })
          const { createMcpAdapter } = yield* Effect.promise(() => import("libfx/mcp"))
          for (const spec of specs) {
            const adapter = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () =>
                  createMcpAdapter(spec.client, adapterOptions(spec)),
                catch: (cause) =>
                  new RuntimeConfigurationError({ runtimeId: agent.runtimeId, message: `MCP adapter failed: ${String(cause)}` })
              }),
              (adapter) =>
                Effect.promise(async () => {
                  await adapter.close().catch(() => undefined)
                  await spec.close?.().catch(() => undefined)
                })
            )
            if (adapter.instructions) instructions.push(adapter.instructions)
            for (const tool of adapter.tools) {
              tools.push(
                defineDurableTool({
                  name: tool.name,
                  description: tool.description,
                  replay: mcpPolicy(spec, tool.name),
                  inputSchema: tool.inputSchema,
                  execute: (input, context) => tool.execute(input, { signal: context.signal })
                })
              )
            }
          }
        }

        const byName = new Map<string, DurableTool>()
        for (const tool of tools) {
          if (byName.has(tool.name)) {
            return yield* new RuntimeConfigurationError({
              runtimeId: agent.runtimeId,
              message: `duplicate tool name: ${tool.name}`
            })
          }
          byName.set(tool.name, tool)
        }
        return {
          tools,
          byName,
          instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined
        }
      })
  })
)
