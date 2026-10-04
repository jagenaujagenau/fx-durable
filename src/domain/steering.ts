import { Schema } from "effect"
import type { StorageReader } from "../durable/storage.js"

const isString = Schema.is(Schema.String)

/** The guidance journaled for a turn (`turn.steered` events), oldest first. */
export const steeringFor = (storage: StorageReader, agentId: string, turnId: string): Array<string> => {
  const texts: Array<string> = []
  let after = 0
  for (;;) {
    const page = storage.eventsAfter(agentId, after, 500)
    for (const event of page) {
      const text = event.payload.text
      if (event.type === "turn.steered" && event.turnId === turnId && isString(text)) texts.push(text)
    }
    const last = page.at(-1)
    if (!last) return texts
    after = last.sequence
  }
}
