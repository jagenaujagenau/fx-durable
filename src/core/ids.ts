import { randomUUID } from "node:crypto"
import { Context, Layer } from "effect"

export interface IdGeneratorInterface {
  readonly next: (prefix: string) => string
}

/** Stable identifier source. Synchronous so the journal can use it inside transactions. */
export class IdGenerator extends Context.Service<IdGenerator, IdGeneratorInterface>()("fx-durable/IdGenerator") {
  static readonly layer = Layer.succeed(
    IdGenerator,
    IdGenerator.of({ next: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}` })
  )

  static readonly sequential = (): Layer.Layer<IdGenerator> =>
    Layer.sync(IdGenerator, () => {
      let n = 0
      return IdGenerator.of({ next: (prefix) => `${prefix}_${String(++n).padStart(6, "0")}` })
    })
}
