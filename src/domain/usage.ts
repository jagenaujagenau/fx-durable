import type { SubmissionRecord } from "./schema.js"

/**
 * Token and cost totals, folded from the usage libfx reports for each
 * finished turn. Nothing extra is stored, so totals can be recomputed at any
 * time, with any price table.
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
  /** Turns that reported usage. */
  readonly turns: number
  /** Includes cache reads and writes. */
  readonly inputTokens: number
  /** Includes reasoning tokens. */
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  /** `null` when no price was given for a model that has usage. */
  readonly costUsd: number | null
}

export interface UsageReport {
  readonly total: UsageTotals
  readonly byModel: ReadonlyMap<string, UsageTotals>
}

interface Tally {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

const emptyTally = (): Tally => ({ turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })

const isPriceMap = (prices: ModelPrices): prices is ReadonlyMap<string, ModelPrice> => prices instanceof Map

const priceTable = (prices: ModelPrices | undefined): ReadonlyMap<string, ModelPrice> =>
  prices === undefined ? new Map() : isPriceMap(prices) ? prices : new Map(Object.entries(prices))

const costOf = (tally: Tally, price: ModelPrice | undefined): number | null => {
  if (tally.turns === 0) return 0
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

/** Totals per model and overall for finished requests (one agent's or several). */
export const usageOf = (submissions: Iterable<SubmissionRecord>, prices?: ModelPrices): UsageReport => {
  const tallies = new Map<string, Tally>()
  for (const submission of submissions) {
    const usage = submission.result?.usage
    if (!usage) continue
    const tally = tallies.get(submission.model) ?? emptyTally()
    tallies.set(submission.model, tally)
    tally.turns += 1
    tally.inputTokens += usage.inputTokens ?? 0
    tally.outputTokens += usage.outputTokens ?? 0
    tally.cacheReadTokens += usage.cacheReadTokens ?? 0
    tally.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    tally.reasoningTokens += usage.reasoningTokens ?? 0
  }

  const table = priceTable(prices)
  const byModel = new Map<string, UsageTotals>()
  const total = emptyTally()
  let totalCost: number | null = 0
  for (const [model, tally] of tallies) {
    const costUsd = costOf(tally, table.get(model))
    byModel.set(model, { ...tally, costUsd })
    total.turns += tally.turns
    total.inputTokens += tally.inputTokens
    total.outputTokens += tally.outputTokens
    total.cacheReadTokens += tally.cacheReadTokens
    total.cacheWriteTokens += tally.cacheWriteTokens
    total.reasoningTokens += tally.reasoningTokens
    totalCost = totalCost === null || costUsd === null ? null : totalCost + costUsd
  }
  return { total: { ...total, costUsd: totalCost }, byModel }
}
