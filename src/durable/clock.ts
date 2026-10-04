/**
 * The journal's only source of time. Synchronous and injectable, so durable
 * behavior stays deterministic in tests without depending on Effect.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number
}

export const SystemClock: Clock = { now: () => Date.now() }

/** A clock that only moves when told to. */
export interface ManualClock extends Clock {
  readonly advance: (millis: number) => void
  readonly set: (millis: number) => void
}

export const manualClock = (start = 0): ManualClock => {
  let current = start
  return {
    now: () => current,
    advance: (millis) => {
      current += millis
    },
    set: (millis) => {
      current = millis
    }
  }
}
