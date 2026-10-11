import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { RuntimeConfigurationError, type StorageError } from "../domain/errors.js"
import { Database } from "./database.js"
import { RuntimeRegistry, type RuntimeDefinition } from "./runtime-registry.js"
import { documentValue, type DurableDocument } from "../domain/documents.js"
import { instructionsWithSummary } from "../domain/context.js"
import { composeHooks, ExtensionSelection, type Extension } from "../tools/extension.js"
import type { DurableAgentRecord } from "../domain/schema.js"
import { canonicalJson, isJsonString, type JsonObject } from "../domain/json.js"
import type { DurableTool } from "../tools/define-tool.js"
import { policyName } from "../tools/replay-policy.js"
import type { ToolSet } from "./tool-executor.js"

/** The tools an agent runs with now: its runtime's, then its selected extensions'. */
export interface AgentToolSet extends ToolSet {
  /** Its selected extensions that are available, in order. */
  readonly extensions: ReadonlyArray<Extension>
  /** The tools the model is offered, as libfx gets them. */
  readonly offered: ReadonlyArray<DurableTool>
  /**
   * Names what the model is offered (names, descriptions, schemas, flags),
   * the same in every process. Agents with the same key share a session
   * store; code behind the tools may differ per agent.
   */
  readonly key: string
}

export interface ToolRegistryInterface {
  readonly toolSet: (agent: DurableAgentRecord) => Effect.Effect<AgentToolSet, RuntimeConfigurationError | StorageError>
  /** The runtime's instructions, each extension's (rendered now), then a handoff summary. */
  readonly instructions: (agent: DurableAgentRecord, extensions: ReadonlyArray<Extension>) => Effect.Effect<string | undefined, RuntimeConfigurationError>
}

export class ToolRegistry extends Context.Service<ToolRegistry, ToolRegistryInterface>()("fx-durable/ToolRegistry") {}

/** A stable name for the tools the model is offered. */
export const toolSetKey = (offered: ReadonlyArray<DurableTool>): string => {
  const descriptors = [...offered]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.jsonSchema,
      unsafe: policyName(tool.replay) === "unsafe",
      writes: tool.writes
    }))
  return `t${createHash("sha256").update(canonicalJson(descriptors)).digest("hex").slice(0, 20)}`
}

export const layer = Layer.effect(
  ToolRegistry,
  Effect.gen(function* () {
    const database = yield* Database
    const registry = yield* RuntimeRegistry

    const runtimeOf = (agent: DurableAgentRecord) => registry.resolve(agent.runtimeId)

    const toolSet = (agent: DurableAgentRecord) =>
      Effect.gen(function* () {
        const runtime: RuntimeDefinition = yield* runtimeOf(agent)
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

        const tools: Array<DurableTool> = [...(runtime.tools ?? []), ...extensions.flatMap((extension) => extension.tools)]
        const byName = new Map<string, DurableTool>()
        for (const tool of tools) {
          if (byName.has(tool.name)) {
            return yield* new RuntimeConfigurationError({ runtimeId: agent.runtimeId, message: `duplicate tool name: ${tool.name}` })
          }
          byName.set(tool.name, tool)
        }
        const hooks = [runtime.hooks, ...extensions.map((extension) => extension.hooks)].flatMap((h) => (h ? [h] : []))
        const offered = tools.filter((tool) => tool.callers !== "tools")
        return {
          extensions,
          byName,
          hooks: hooks.length === 0 ? undefined : hooks.length === 1 ? hooks[0] : composeHooks(hooks),
          offered,
          key: toolSetKey(offered)
        } satisfies AgentToolSet
      })

    const instructions = (agent: DurableAgentRecord, extensions: ReadonlyArray<Extension>) =>
      Effect.gen(function* () {
        const runtime = yield* runtimeOf(agent)
        const parts: Array<string> = runtime.instructions ? [runtime.instructions] : []
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
          if (text) parts.push(text)
        }
        return instructionsWithSummary(parts.length > 0 ? parts.join("\n\n") : undefined, agent.summary)
      })

    return ToolRegistry.of({ toolSet, instructions })
  })
)
