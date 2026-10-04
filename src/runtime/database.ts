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
}

export class Database extends Context.Service<Database, DatabaseInterface>()("fx-durable/Database") {}

const attempt = <A>(f: () => A): Effect.Effect<A, StorageError | NotFoundError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (error) {
      if (error instanceof StorageError || error instanceof NotFoundError) return Effect.fail(error)
      return Effect.die(error)
    }
  })

const attemptRead = <A>(f: () => A): Effect.Effect<A, StorageError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (error) {
      return error instanceof StorageError ? Effect.fail(error) : Effect.die(error)
    }
  })

export const makeDatabase = (journal: Journal, registry: ExecutorRegistry): DatabaseInterface => ({
  run: (f) => attempt(() => f(journal)),
  read: (f) => attemptRead(() => f(journal.reader)),
  executors: (f) => attemptRead(() => f(registry)),
  models: {
    modelStarted: (call) => journal.modelStarted(call),
    modelCompleted: (call, taskId, summary) => journal.modelCompleted(call, taskId, summary),
    modelFailed: (call, taskId, error) => journal.modelFailed(call, taskId, error),
    recordProgress: (taskId, progress) => journal.recordProgress(taskId, progress)
  },
  onCommitted: (listener) => journal.onCommitted(listener)
})

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
