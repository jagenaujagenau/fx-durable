import { Context, Effect, Layer } from "effect"
import type { DurableTool } from "../tools/define-tool.js"
import type { ToolHooks } from "../tools/hooks.js"
import type { Extension } from "../tools/extension.js"
import { RuntimeConfigurationError } from "../domain/errors.js"

/**
 * Sessions cannot store executable code, so agents persist a stable runtime
 * id, and each process resolves it through its own registry.
 */

export interface RuntimeDefinition {
  readonly tools?: ReadonlyArray<DurableTool>
  readonly instructions?: string
  /** Hooks around this runtime's tool calls, e.g. permission checks. */
  readonly hooks?: ToolHooks
  /**
   * The extensions its agents get, in order, unless an agent selects others
   * (`agent.setExtensions()`). An installed extension with the same name
   * (`fx.installExtension()`) is used instead of the one listed here.
   */
  readonly extensions?: ReadonlyArray<Extension>
}

export interface RuntimeRegistryInterface {
  readonly register: (id: string, definition: RuntimeDefinition) => Effect.Effect<void>
  readonly resolve: (id: string) => Effect.Effect<RuntimeDefinition, RuntimeConfigurationError>
  readonly has: (id: string) => Effect.Effect<boolean>
  readonly ids: () => Effect.Effect<ReadonlyArray<string>>
  /** Install an extension, replacing any installed one with its name. */
  readonly install: (extension: Extension) => Effect.Effect<void>
  /** Remove the installed extension with this name; runtimes that list one by that name fall back to it. */
  readonly uninstall: (name: string) => Effect.Effect<void>
  readonly installed: (name: string) => Effect.Effect<Extension | null>
}

export class RuntimeRegistry extends Context.Service<RuntimeRegistry, RuntimeRegistryInterface>()(
  "fx-durable/RuntimeRegistry"
) {
  static readonly layer = (initial: Readonly<Record<string, RuntimeDefinition>> = {}) =>
    Layer.sync(RuntimeRegistry, () => {
      const runtimes = new Map<string, RuntimeDefinition>(Object.entries(initial))
      const extensions = new Map<string, Extension>()
      return RuntimeRegistry.of({
        install: (extension) =>
          Effect.sync(() => {
            extensions.set(extension.name, extension)
          }),
        uninstall: (name) =>
          Effect.sync(() => {
            extensions.delete(name)
          }),
        installed: (name) => Effect.sync(() => extensions.get(name) ?? null),
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
