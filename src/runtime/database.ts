import { Context, Effect, Layer } from "effect"
import { NotFoundError, StorageError } from "../domain/errors.js"
import type { Clock } from "../durable/clock.js"
import { Journal, type CommittedChange } from "../durable/journal.js"
import { openSqliteStorage, type SqliteStorageConfig } from "../durable/sqlite/storage.js"
import type { Storage, StorageReader } from "../durable/storage.js"

/**
 * The durability boundary, seen from the Effect runtime.
 *
 * Runtime modules never hold a `Journal`. They get this service and reach
 * durable state only through it:
 * - `run(journal => …)` performs journal transitions. `StorageError` and
 *   `NotFoundError` stay typed; anything else (an invalid state transition, a
 *   checkpoint-sequence conflict) is a defect.
 * - `read(storage => …)` performs read-only queries.
 *
 * A `StorageError` from any of these is fatal to the runtime: the in-memory
 * view may no longer match what is stored. The first one is reported through
 * `onFailure` (fx-durable then closes, and the next open recovers from what
 * was committed); the call that hit it still fails with it.
 *
 * This module is the only runtime module allowed to import the journal; a lint
 * rule enforces it.
 */
export interface DatabaseInterface {
  readonly run: <A>(f: (journal: Journal) => A) => Effect.Effect<A, StorageError | NotFoundError>
  readonly read: <A>(f: (storage: StorageReader) => A) => Effect.Effect<A, StorageError>
  /** Plain synchronous journal access, for libfx callbacks that are not Effect code. Throws on failure. */
  readonly runSync: <A>(f: (journal: Journal) => A) => A
  /** Listen for events after their transaction commits. Returns an unsubscribe function. */
  readonly onCommitted: (listener: (change: CommittedChange) => void) => () => void
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

export const makeDatabase = (journal: Journal): DatabaseInterface => {
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
    runSync: (f) => guarded(() => f(journal)),
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
      const storage = yield* Effect.acquireRelease(
        Effect.try({
          try: () => (isSqliteConfig(config) ? openSqliteStorage(config.options) : config),
          catch: (cause) =>
            cause instanceof StorageError ? cause : new StorageError({ operation: "open", message: String(cause), cause })
        }),
        (opened) => Effect.sync(() => opened.close())
      )
      return Database.of(makeDatabase(new Journal(clock ? { storage, clock } : { storage })))
    })
  )
