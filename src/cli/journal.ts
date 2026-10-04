import { Effect, Layer, ManagedRuntime } from "effect"
import { CrashInjector } from "../core/crash.js"
import { EventLog, layer as eventLogLayer } from "../core/events.js"
import { IdGenerator } from "../core/ids.js"
import type { Storage } from "../core/storage.js"
import { TaskEngine, layer as taskEngineLayer } from "../core/task.js"
import { layer as sqliteLayer } from "../sqlite/storage.js"

/**
 * The CLI is an observer/controller of the same durable state, not a
 * separate execution model: it opens the journal services only.
 */
export const openJournal = (db: string) => {
  const base = Layer.mergeAll(sqliteLayer({ path: db }), IdGenerator.layer, CrashInjector.noop)
  const events = eventLogLayer.pipe(Layer.provideMerge(base))
  const layer = taskEngineLayer.pipe(Layer.provideMerge(events))
  const runtime = ManagedRuntime.make(layer)
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Storage | EventLog | IdGenerator | TaskEngine | CrashInjector>) =>
      runtime.runPromise(effect),
    runtime,
    close: () => runtime.dispose()
  }
}

export type Journal = ReturnType<typeof openJournal>
export { EventLog, TaskEngine }
