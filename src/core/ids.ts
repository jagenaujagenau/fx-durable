import { randomUUID } from "node:crypto"
import { Clock, Context, Effect, Layer } from "effect"

export interface IdGeneratorInterface {
  readonly next: (prefix: string) => Effect.Effect<string>
}

/** Stable identifier source. Replaceable in tests for deterministic ids. */
export class IdGenerator extends Context.Service<IdGenerator, IdGeneratorInterface>()("fx-durable/IdGenerator") {
  static readonly layer = Layer.succeed(
    IdGenerator,
    IdGenerator.of({ next: (prefix) => Effect.sync(() => `${prefix}_${randomUUID().replaceAll("-", "")}`) })
  )

  static readonly sequential = (): Layer.Layer<IdGenerator> =>
    Layer.sync(IdGenerator, () => {
      let n = 0
      return IdGenerator.of({ next: (prefix) => Effect.sync(() => `${prefix}_${String(++n).padStart(6, "0")}`) })
    })
}

/** The current time as a `Date`, read through Effect's `Clock` service. */
export const now: Effect.Effect<Date> = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms))
