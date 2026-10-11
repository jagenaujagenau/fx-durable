import type { JsonObject } from "../domain/json.js"
import { defineDocument, type DurableDocument } from "../domain/documents.js"
import type { DurableTool } from "./define-tool.js"
import type { BeforeToolDecision, ToolHooks } from "./hooks.js"

/**
 * Extensions: named bundles of tools, instructions, and hooks that agents
 * select. A runtime lists the ones its agents get by default; an agent can
 * select others (`agent.setExtensions()`). Installing an extension with the
 * same name as another replaces it, which is how code is reloaded. Nothing
 * of an extension is stored but its name, so a change applies from each
 * agent's next turn.
 */

/** What dynamic instructions can look at. */
export interface InstructionsInput {
  readonly agentId: string
  readonly cwd: string | null
  /** A document's committed value: the agent's own, or a global one. */
  readonly document: <T extends JsonObject>(document: DurableDocument<T>) => Promise<T>
}

/**
 * Text for the model's instructions: fixed, or rendered before each turn
 * (for example from the extension's documents). Return nothing to add none.
 * Text that changes rebuilds the agent's session for its next turn, which
 * also restarts the provider's prompt cache, so keep it stable when you can.
 */
export type ExtensionInstructions = string | ((input: InstructionsInput) => string | undefined | Promise<string | undefined>)

export interface ExtensionDefinition {
  /** Identifies the extension: agents store this name, and installing another with it replaces this one. */
  readonly name: string
  readonly tools?: ReadonlyArray<DurableTool>
  readonly instructions?: ExtensionInstructions
  /** Hooks around the agent's tool calls, after the runtime's own and those of extensions selected before it. */
  readonly hooks?: ToolHooks
}

export interface Extension {
  readonly _tag: "Extension"
  readonly name: string
  readonly tools: ReadonlyArray<DurableTool>
  readonly instructions: ExtensionInstructions | null
  readonly hooks: ToolHooks | null
}

const NAME = /^[a-zA-Z0-9_.:-]{1,64}$/

export const defineExtension = (definition: ExtensionDefinition): Extension => {
  if (!NAME.test(definition.name)) throw new TypeError(`invalid extension name: ${definition.name}`)
  const names = new Set<string>()
  for (const tool of definition.tools ?? []) {
    if (names.has(tool.name)) throw new TypeError(`extension ${definition.name}: duplicate tool ${tool.name}`)
    names.add(tool.name)
  }
  return {
    _tag: "Extension",
    name: definition.name,
    tools: definition.tools ?? [],
    instructions: definition.instructions ?? null,
    hooks: definition.hooks ?? null
  }
}

/** An agent's extension selection: names in order, or null for its runtime's default. */
export const ExtensionSelection = defineDocument<{ names: Array<string> | null }>({
  kind: "fx-durable.extensions",
  version: 1,
  scope: "agent",
  initial: () => ({ names: null })
})

/**
 * Hooks run in order. `beforeTool`: each sees the input the previous one
 * settled on, and the first `{ block }` stops the call. `afterTool`: each may
 * replace the result the previous one returned.
 */
export const composeHooks = (all: ReadonlyArray<ToolHooks>): ToolHooks => {
  const before = all.flatMap((hooks) => (hooks.beforeTool ? [hooks.beforeTool] : []))
  const after = all.flatMap((hooks) => (hooks.afterTool ? [hooks.afterTool] : []))
  return {
    beforeTool: async (call, context): Promise<BeforeToolDecision> => {
      let input = call.input
      let changed = false
      for (const hook of before) {
        const decision = await hook({ ...call, input }, context)
        if (!decision) continue
        if ("block" in decision) return decision
        input = decision.input
        changed = true
      }
      return changed ? { input } : undefined
    },
    afterTool: async (call, output, context) => {
      let current = output
      let replaced = false
      for (const hook of after) {
        const next = await hook(call, current, context)
        if (next === undefined) continue
        current = next
        replaced = true
      }
      return replaced ? current : undefined
    }
  }
}
