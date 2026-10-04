import { Context, Effect, Layer } from "effect"
import { NotFoundError, StorageError } from "./errors.js"
import { IdGenerator } from "./ids.js"
import { Journal } from "./journal.js"
import type { Storage } from "./storage.js"

/**
 * The bridge between the Effect execution core and the plain synchronous
 * journal. Effect code reaches storage only through `db(() => …)`, which runs
 * the synchronous call and maps its failures into Effect's error channel:
 * `StorageError` and `NotFoundError` stay typed; anything else (e.g. an
 * invalid state transition) is a defect.
 */
export class JournalService extends Context.Service<JournalService, Journal>()("fx-durable/Journal") {}

export const db = <A>(f: () => A): Effect.Effect<A, StorageError | NotFoundError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (error) {
      if (error instanceof StorageError || error instanceof NotFoundError) return Effect.fail(error)
      return Effect.die(error)
    }
  })

/** A scoped journal over storage opened by `open`; storage is closed with the scope. */
export const journalLayer = (open: () => Storage) =>
  Layer.effect(
    JournalService,
    Effect.gen(function* () {
      const ids = yield* IdGenerator
      const storage = yield* Effect.acquireRelease(
        Effect.try({
          try: open,
          catch: (cause) =>
            cause instanceof StorageError ? cause : new StorageError({ operation: "open", message: String(cause), cause })
        }),
        (opened) => Effect.sync(() => opened.close())
      )
      return new Journal({ storage, nextId: ids.next })
    })
  )

/** `db` for read-only storage calls, which can only fail with `StorageError`. */
export const read = <A>(f: () => A): Effect.Effect<A, StorageError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (error) {
      return error instanceof StorageError ? Effect.fail(error) : Effect.die(error)
    }
  })
