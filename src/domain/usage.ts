import { Option, Schema } from "effect"
import type { DurableEvent } from "./schema.js"

/**
 * Token and cost totals, folded from the journaled `model.*` events. Nothing
 * extra is stored: the event log already holds every model request, so totals
 * can be recomputed at any time, with any price table.
 */

/** USD per million tokens. Cache prices default to the input price. */
export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** Prices by model id, as passed to `agent({ model })`, e.g. `"anthropic/claude-sonnet-4.5"`. */
export type ModelPrices = ReadonlyMap<string, ModelPrice> | Readonly<Record<string, ModelPrice>>

export interface UsageTotals {
  /** Model requests that completed. */
  readonly requests: number
  /** Model requests that failed or were interrupted. Their tokens are unknown, but may have been billed. */
  readonly failedRequests: number
  /** Includes cache reads and writes. */
  readonly inputTokens: number
  /** Includes reasoning tokens. */
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  /** `null` when no price was given for a model that made completed requests. */
  readonly costUsd: number | null
}

export interface UsageReport {
  readonly total: UsageTotals
  readonly byModel: ReadonlyMap<string, UsageTotals>
}

const Count = Schema.optional(Schema.NullOr(Schema.Number))
const ModelEvent = Schema.Struct({
  model: Schema.String,
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Count,
      outputTokens: Count,
      cacheReadTokens: Count,
      cacheWriteTokens: Count,
      reasoningTokens: Count
    })
  )
})
const decodeModelEvent = Schema.decodeUnknownOption(ModelEvent)

interface Tally {
  requests: number
  failedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

const emptyTally = (): Tally => ({
  requests: 0,
  failedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0
})

const priceTable = (prices: ModelPrices | undefined): ReadonlyMap<string, ModelPrice> =>
  prices === undefined ? new Map() : isPriceMap(prices) ? prices : new Map(Object.entries(prices))

const isPriceMap = (prices: ModelPrices): prices is ReadonlyMap<string, ModelPrice> => prices instanceof Map

const costOf = (tally: Tally, price: ModelPrice | undefined): number | null => {
  if (tally.requests === 0) return 0
  if (!price) return null
  const uncached = tally.inputTokens - tally.cacheReadTokens - tally.cacheWriteTokens
  return (
    (uncached * price.input +
      tally.cacheReadTokens * (price.cacheRead ?? price.input) +
      tally.cacheWriteTokens * (price.cacheWrite ?? price.input) +
      tally.outputTokens * price.output) /
    1_000_000
  )
}

/** Add one event to the tallies; events other than `model.completed/failed/interrupted` are ignored. */
const record = (tallies: Map<string, Tally>, event: DurableEvent) => {
  if (event.type !== "model.completed" && event.type !== "model.failed" && event.type !== "model.interrupted") return
  const decoded = decodeModelEvent(event.payload)
  if (Option.isNone(decoded)) return
  const { model, usage } = decoded.value
  const tally = tallies.get(model) ?? emptyTally()
  tallies.set(model, tally)
  if (event.type !== "model.completed") {
    tally.failedRequests += 1
    return
  }
  tally.requests += 1
  tally.inputTokens += usage?.inputTokens ?? 0
  tally.outputTokens += usage?.outputTokens ?? 0
  tally.cacheReadTokens += usage?.cacheReadTokens ?? 0
  tally.cacheWriteTokens += usage?.cacheWriteTokens ?? 0
  tally.reasoningTokens += usage?.reasoningTokens ?? 0
}

/** Totals per model and overall for a sequence of journaled events (one agent's or several). */
export const usageOf = (events: Iterable<DurableEvent>, prices?: ModelPrices): UsageReport => {
  const tallies = new Map<string, Tally>()
  for (const event of events) record(tallies, event)

  const table = priceTable(prices)
  const byModel = new Map<string, UsageTotals>()
  const total = emptyTally()
  let totalCost: number | null = 0
  for (const [model, tally] of tallies) {
    const costUsd = costOf(tally, table.get(model))
    byModel.set(model, { ...tally, costUsd })
    total.requests += tally.requests
    total.failedRequests += tally.failedRequests
    total.inputTokens += tally.inputTokens
    total.outputTokens += tally.outputTokens
    total.cacheReadTokens += tally.cacheReadTokens
    total.cacheWriteTokens += tally.cacheWriteTokens
    total.reasoningTokens += tally.reasoningTokens
    totalCost = totalCost === null || costUsd === null ? null : totalCost + costUsd
  }
  return { total: { ...total, costUsd: totalCost }, byModel }
}
