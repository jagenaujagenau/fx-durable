import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { DurableFx, sqlite, type DurableFxOptions } from "../src/index.js"
import { scriptedModel, type Script } from "../src/testing/index.js"
import { Storage, type StorageInterface } from "../src/core/storage.js"
import { layer as sqliteLayer } from "../src/sqlite/storage.js"
import { IdGenerator } from "../src/core/ids.js"
import { EventLog, layer as eventLogLayer } from "../src/core/events.js"

export const tempDb = (name = "fx.db") => join(mkdtempSync(join(tmpdir(), "fxd-test-")), name)

export const openFx = (db: string, script: Script, options: Partial<DurableFxOptions> = {}) =>
  DurableFx.open({
    storage: sqlite(db),
    fetch: scriptedModel(script),
    crash: "off",
    idlePollMillis: 100,
    ...options
  })

/** A raw Storage + EventLog runtime for journal-level tests (no libfx). */
export const journalRuntime = (db: string) => {
  const base = Layer.mergeAll(sqliteLayer({ path: db }), IdGenerator.layer)
  const layer = eventLogLayer.pipe(Layer.provideMerge(base))
  const runtime = ManagedRuntime.make(layer)
  return {
    runtime,
    run: <A, E>(effect: Effect.Effect<A, E, Storage | EventLog | IdGenerator>) => runtime.runPromise(effect),
    storage: () => runtime.runPromise(Effect.flatMap(Storage, (s) => Effect.succeed<StorageInterface>(s)))
  }
}

export const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}
