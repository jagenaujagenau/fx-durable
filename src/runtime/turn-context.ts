import { createHash } from "node:crypto"
import { canonicalJson, type Json } from "../domain/json.js"

/**
 * Ephemeral, in-process bookkeeping for one attempt of a turn. Everything
 * recovery needs is in SQLite; this only exists while the attempt runs.
 */
export interface TurnContext {
  readonly agentId: string
  readonly submissionId: string
  readonly turnId: string
  readonly attempt: number
  readonly model: string
  /** Per (tool, input) call counters, used to map calls onto journaled slots. */
  readonly ordinals: Map<string, number>
  /** Tool/model operations still settling their durable state. */
  readonly inflight: Set<Promise<unknown>>
  /** Why this attempt is being interrupted, if it is. */
  interruptReason: "cancelled" | "executor_lost" | null
}

export const makeTurnContext = (fields: {
  readonly agentId: string
  readonly submissionId: string
  readonly turnId: string
  readonly attempt: number
  readonly model: string
}): TurnContext => ({ ...fields, ordinals: new Map(), inflight: new Set(), interruptReason: null })

export const hashInput = (tool: string, input: Json): string =>
  createHash("sha256").update(tool).update("\0").update(canonicalJson(input)).digest("hex")
