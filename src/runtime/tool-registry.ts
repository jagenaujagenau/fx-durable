// oxlint-disable-next-line typescript/triple-slash-reference -- ambient `declare module "libfx"` types (libfx ships none) can only be attached by reference, not imported
/// <reference path="../types/libfx.d.ts" preserve="true" />
import { Context, Effect, Layer, type Scope } from "effect"
import { RuntimeConfigurationError, type StorageError } from "../domain/errors.js"
import { Database } from "./database.js"
import { RuntimeRegistry } from "./runtime-registry.js"
import { documentValue } from "../domain/documents.js"
import { composeHooks, ExtensionSelection, type Extension } from "../tools/extension.js"
import type { ToolHooks } from "../tools/hooks.js"
import type { McpClientSpec, RuntimeDefinition } from "./runtime-registry.js"
import type { DurableAgentRecord } from "../domain/schema.js"
import { isJsonString, type JsonObject } from "../domain/json.js"
import type { DurableDocument } from "../domain/documents.js"
import type { McpAdapterOptions } from "libfx/mcp"
import { defineDurableTool, type DurableTool } from "../tools/define-tool.js"
import type { ReplayPolicy } from "../tools/replay-policy.js"

/** What an agent runs with this turn, apart from its tools. */
export interface AgentConfiguration {
  /** Its selected extensions that are available, in order. */
  readonly extensions: ReadonlyArray<Extension>
  /** The runtime's instructions, then each extension's, rendered for this turn. */
  readonly instructions: string | undefined
  /** The runtime's hooks, then each extension's. */
  readonly hooks: ToolHooks | undefined
  /** Changes whenever the runtime definition, the extensions, or the instructions do. */
  readonly key: string
}

export interface ResolvedTools {
  readonly tools: ReadonlyArray<DurableTool>
  readonly byName: ReadonlyMap<string, DurableTool>
  readonly instructions: string | undefined
  readonly hooks: ToolHooks | undefined
}

export interface ToolRegistryInterface {
  /** The agent's extensions, instructions, and hooks, from its runtime and its extension selection. */
  readonly configure: (
    agent: DurableAgentRecord,
    runtime: RuntimeDefinition
  ) => Effect.Effect<AgentConfiguration, RuntimeConfigurationError | StorageError>
  /**
   * Resolve the executable tools for an agent from its runtime definition,
   * including MCP adapters. MCP clients are closed when the scope closes.
   */
  readonly resolve: (
    agent: DurableAgentRecord,
    runtime: RuntimeDefinition,
    /** Already computed by `configure` for this turn. */
    configuration?: AgentConfiguration
  ) => Effect.Effect<ResolvedTools, RuntimeConfigurationError | StorageError, Scope.Scope>
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

/** Stable ids for definition objects, so a configuration key changes when one is replaced. */
type Definition = RuntimeDefinition | Extension
const identities = new WeakMap<Definition, number>()
let nextIdentity = 0
const identity = (value: Definition) => {
  let id = identities.get(value)
  if (id === undefined) {
    id = ++nextIdentity
    identities.set(value, id)
  }
  return id
}

export const layer = Layer.effect(
  ToolRegistry,
  Effect.gen(function* () {
    const database = yield* Database
    const registry = yield* RuntimeRegistry

    const configure = (agent: DurableAgentRecord, runtime: RuntimeDefinition) =>
      Effect.gen(function* () {
        const selection = documentValue(
          ExtensionSelection,
          yield* database.read((storage) => storage.getDocument(agent.id, ExtensionSelection.kind))
        )
        const defaults = runtime.extensions ?? []
        const extensions: Array<Extension> = []
        for (const name of selection.names ?? defaults.map((extension) => extension.name)) {
          const extension = (yield* registry.installed(name)) ?? defaults.find((listed) => listed.name === name)
          // A selected extension that is not available is skipped until it is installed again.
          if (extension) extensions.push(extension)
        }

        const instructions: Array<string> = runtime.instructions ? [runtime.instructions] : []
        const input = {
          agentId: agent.id,
          cwd: agent.cwd,
          document: <T extends JsonObject>(document: DurableDocument<T>) =>
            Effect.runPromise(database.read((storage) => storage.getDocument(document.scope === "agent" ? agent.id : null, document.kind))).then(
              (record) => documentValue(document, record)
            )
        }
        for (const extension of extensions) {
          const render = extension.instructions
          if (render === null) continue
          const text = isJsonString(render)
            ? render
            : yield* Effect.tryPromise({
                try: async () => render(input),
                catch: (cause) =>
                  new RuntimeConfigurationError({
                    runtimeId: agent.runtimeId,
                    message: `instructions of extension ${extension.name} failed: ${cause instanceof Error ? cause.message : String(cause)}`
                  })
              })
          if (text) instructions.push(text)
        }

        const hooks = [runtime.hooks, ...extensions.map((extension) => extension.hooks)].flatMap((h) => (h ? [h] : []))
        const text = instructions.length > 0 ? instructions.join("\n\n") : undefined
        return {
          extensions,
          instructions: text,
          hooks: hooks.length === 0 ? undefined : hooks.length === 1 ? hooks[0] : composeHooks(hooks),
          key: JSON.stringify([identity(runtime), extensions.map(identity), text ?? null])
        } satisfies AgentConfiguration
      })

    const resolve = (agent: DurableAgentRecord, runtime: RuntimeDefinition, configured?: AgentConfiguration) =>
      Effect.gen(function* () {
        const configuration = configured ?? (yield* configure(agent, runtime))
        const tools: Array<DurableTool> = [...(runtime.tools ?? []), ...configuration.extensions.flatMap((extension) => extension.tools)]
        const instructions: Array<string> = configuration.instructions ? [configuration.instructions] : []

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
          instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined,
          hooks: configuration.hooks
        }
      })

    return ToolRegistry.of({ configure, resolve })
  })
)
