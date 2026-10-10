import { Context, Effect, Layer } from "effect"
import { NotFoundError, StorageError } from "../domain/errors.js"
import type { DurableEvent } from "../domain/schema.js"
import type { Clock } from "../durable/clock.js"
import { ExecutorRegistry } from "../durable/executor-registry.js"
import { Journal } from "../durable/journal.js"
import { openSqliteStorage, type SqliteStorageConfig } from "../durable/sqlite/storage.js"
import type { Storage, StorageReader } from "../durable/storage.js"
import { IdGenerator } from "./ids.js"

/**
 * The durability boundary, seen from the Effect runtime.
 *
 * Runtime modules never hold a `Journal`. They get this service and reach
 * durable state only through it:
 * - `run(journal => …)` performs journal transitions. `StorageError` and
 *   `NotFoundError` stay typed; anything else (an invalid state transition, a
 *   checkpoint-sequence conflict) is a defect.
 * - `read(storage => …)` performs read-only queries.
 * - `executors(registry => …)` records process liveness, which is not domain
 *   state and lives outside the Journal.
 * - `models` is the narrow journal surface for libfx's transport callback,
 *   which is plain Promise code outside Effect (it throws on failure).
 *
 * A `StorageError` from any of these is fatal to the runtime: the in-memory
 * view may no longer match what is stored. The first one is reported through
 * `onFailure` (fx-durable then closes, and the next open recovers from what
 * was committed); the call that hit it still fails with it.
 *
 * This module is the only runtime module allowed to import the journal; a lint
 * rule enforces it.
 */
export type ModelJournal = Pick<Journal, "modelStarted" | "modelCompleted" | "modelFailed" | "recordProgress">

export interface DatabaseInterface {
  readonly run: <A>(f: (journal: Journal) => A) => Effect.Effect<A, StorageError | NotFoundError>
  readonly read: <A>(f: (storage: StorageReader) => A) => Effect.Effect<A, StorageError>
  /** Process liveness (not domain state): register, heartbeat, stop, and check executors. */
  readonly executors: <A>(f: (registry: ExecutorRegistry) => A) => Effect.Effect<A, StorageError>
  readonly models: ModelJournal
  /** Listen for events after their transaction commits. Returns an unsubscribe function. */
  readonly onCommitted: (listener: (event: DurableEvent) => void) => () => void
  /** Called once, with the first storage error. Called at once if one already happened. Returns an unsubscribe function. */
  readonly onFailure: (listener: (error: StorageError) => void) => () => void
}

export class Database extends Context.Service<Database, DatabaseInterface>()("fx-durable/Database") {}

/** Records the first storage error and tells the listeners about it. */
const failureSignal = () => {
  let failure: StorageError | null = null
  const listeners = new Set<(error: StorageError) => void>()
  return {
    report: (error: StorageError) => {
      if (failure) return
      failure = error
      for (const listener of listeners) listener(error)
      listeners.clear()
    },
    subscribe: (listener: (error: StorageError) => void) => {
      if (failure) {
        listener(failure)
        return () => undefined
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

export const makeDatabase = (journal: Journal, registry: ExecutorRegistry): DatabaseInterface => {
  const failures = failureSignal()

  /** Run plain journal code; a storage error is reported before it is rethrown. */
  const guarded = <A>(f: () => A): A => {
    try {
      return f()
    } catch (error) {
      if (error instanceof StorageError) failures.report(error)
      throw error
    }
  }

  const attempt = <A>(f: () => A): Effect.Effect<A, StorageError | NotFoundError> =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(guarded(f))
      } catch (error) {
        if (error instanceof StorageError || error instanceof NotFoundError) return Effect.fail(error)
        return Effect.die(error)
      }
    })

  const attemptRead = <A>(f: () => A): Effect.Effect<A, StorageError> =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(guarded(f))
      } catch (error) {
        return error instanceof StorageError ? Effect.fail(error) : Effect.die(error)
      }
    })

  return {
    run: (f) => attempt(() => f(journal)),
    read: (f) => attemptRead(() => f(journal.reader)),
    executors: (f) => attemptRead(() => f(registry)),
    models: {
      modelStarted: (call) => guarded(() => journal.modelStarted(call)),
      modelCompleted: (call, taskId, summary) => guarded(() => journal.modelCompleted(call, taskId, summary)),
      modelFailed: (call, taskId, error) => guarded(() => journal.modelFailed(call, taskId, error)),
      recordProgress: (taskId, progress) => guarded(() => journal.recordProgress(taskId, progress))
    },
    onCommitted: (listener) => journal.onCommitted(listener),
    onFailure: (listener) => failures.subscribe(listener)
  }
}

const isSqliteConfig = (storage: SqliteStorageConfig | Storage): storage is SqliteStorageConfig =>
  "_tag" in storage && storage._tag === "SqliteStorageConfig"

/** A scoped database over the configured storage; storage is closed with the scope. */
export const databaseLayer = (config: SqliteStorageConfig | Storage, clock?: Clock) =>
  Layer.effect(
    Database,
    Effect.gen(function* () {
      const ids = yield* IdGenerator
      const storage = yield* Effect.acquireRelease(
        Effect.try({
          try: () => (isSqliteConfig(config) ? openSqliteStorage(config.options) : config),
          catch: (cause) =>
            cause instanceof StorageError ? cause : new StorageError({ operation: "open", message: String(cause), cause })
        }),
        (opened) => Effect.sync(() => opened.close())
      )
      const journal = new Journal(clock ? { storage, nextId: ids.next, clock } : { storage, nextId: ids.next })
      return Database.of(makeDatabase(journal, new ExecutorRegistry(storage, clock)))
    })
  )
