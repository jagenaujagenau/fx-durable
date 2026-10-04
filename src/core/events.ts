import { Context, Effect, Layer, Option, PubSub, Stream } from "effect"
import type { StorageError } from "./errors.js"
import { IdGenerator, now } from "./ids.js"
import type { JsonObject } from "./json.js"
import type { DurableEvent } from "./schema.js"
import { Storage } from "./storage.js"

/**
 * Durable event taxonomy. The database event log is authoritative; the
 * in-memory PubSub only distributes committed events to live consumers.
 */
export const EVENT_TYPES = [
  "agent.created",
  "agent.updated",
  "agent.idle",
  "agent.configuration_error",
  "agent.needs_input",
  "submission.created",
  "submission.started",
  "submission.completed",
  "submission.failed",
  "submission.cancelled",
  "submission.needs_input",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.interrupted",
  "turn.recovered",
  "model.started",
  "model.completed",
  "model.failed",
  "model.interrupted",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.cancelled",
  "tool.interrupted",
  "tool.replayed",
  "tool.reused",
  "tool.outcome_unknown",
  "tool.outcome_unknown_refused",
  "checkpoint.created",
  "recovery.started",
  "recovery.completed",
  "recovery.failed"
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export interface AppendEvent {
  readonly agentId: string
  readonly type: EventType
  readonly submissionId?: string | null
  readonly turnId?: string | null
  readonly taskId?: string | null
  readonly payload?: JsonObject
}

export interface SubscribeOptions {
  /** Deliver events with `sequence > after`. Defaults to 0 (everything). */
  readonly after?: number
  /**
   * Interval for re-reading the durable log. Covers events committed by other
   * processes (e.g. a CLI follower) and slow consumers that fell behind the
   * bounded live channel. Defaults to 500ms.
   */
  readonly pollInterval?: number
}

export interface EventLogInterface {
  /** Append an event. Must run inside the transaction of the state change it describes. */
  readonly append: (event: AppendEvent) => Effect.Effect<DurableEvent, StorageError>
  /** Persisted events after the cursor, then live events, with no gaps and no duplicates. */
  readonly subscribe: (agentId: string, options?: SubscribeOptions) => Stream.Stream<DurableEvent, StorageError>
  readonly history: (agentId: string, after?: number) => Effect.Effect<ReadonlyArray<DurableEvent>, StorageError>
}

export class EventLog extends Context.Service<EventLog, EventLogInterface>()("fx-durable/EventLog") {}

const PAGE = 500
const LIVE_CAPACITY = 1024

export const layer = Layer.effect(
  EventLog,
  Effect.gen(function* () {
    const storage = yield* Storage
    const ids = yield* IdGenerator
    // Sliding: a lagging subscriber loses live messages, never blocks
    // publishers, and catches up from the durable log by detecting the gap.
    const live = yield* Effect.acquireRelease(PubSub.sliding<DurableEvent>(LIVE_CAPACITY), PubSub.shutdown)

    const append = Effect.fn("EventLog.append")(function* (event: AppendEvent) {
      const id = yield* ids.next("evt")
      const createdAt = yield* now
      const persisted = yield* storage.appendEvent({
        id,
        agentId: event.agentId,
        submissionId: event.submissionId ?? null,
        turnId: event.turnId ?? null,
        taskId: event.taskId ?? null,
        type: event.type,
        payload: event.payload ?? {},
        createdAt
      })
      yield* storage.afterCommit(PubSub.publish(live, persisted).pipe(Effect.asVoid))
      return persisted
    })

    const history = (agentId: string, after = 0) =>
      Effect.gen(function* () {
        const out: Array<DurableEvent> = []
        let cursor = after
        while (true) {
          const page = yield* storage.eventsAfter(agentId, cursor, PAGE)
          out.push(...page)
          if (page.length < PAGE) return out
          cursor = page[page.length - 1]!.sequence
        }
      })

    const subscribe = (agentId: string, options?: SubscribeOptions): Stream.Stream<DurableEvent, StorageError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe to the live channel BEFORE reading the log, so any event
          // committed after the read is guaranteed to arrive live.
          const subscription = yield* PubSub.subscribe(live)
          let cursor = options?.after ?? 0

          const catchUp = Effect.gen(function* () {
            const events = yield* history(agentId, cursor)
            if (events.length > 0) cursor = events[events.length - 1]!.sequence
            return events
          })

          const onLive = (event: DurableEvent) =>
            Effect.gen(function* () {
              const none: ReadonlyArray<DurableEvent> = []
              if (event.agentId !== agentId || event.sequence <= cursor) return none
              if (event.sequence === cursor + 1) {
                cursor = event.sequence
                return [event]
              }
              // Gap: we dropped live messages or another process wrote. The log decides.
              return yield* catchUp
            })

          type Wake = { readonly _tag: "live"; readonly event: DurableEvent } | { readonly _tag: "tick" }
          const liveWakes: Stream.Stream<Wake> = Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(Stream.map((event): Wake => ({ _tag: "live", event })))
          const ticks: Stream.Stream<Wake> = Stream.tick(options?.pollInterval ?? 500).pipe(Stream.map((): Wake => ({ _tag: "tick" })))

          const tail = Stream.merge(liveWakes, ticks).pipe(
            Stream.mapEffect((wake) => (wake._tag === "live" ? onLive(wake.event) : catchUp)),
            Stream.flatMap((events) => Stream.fromIterable(events))
          )
          return Stream.concat(
            Stream.fromEffect(catchUp).pipe(Stream.flatMap((events) => Stream.fromIterable(events))),
            tail
          )
        })
      )

    return EventLog.of({ append, subscribe, history })
  })
)

export const lastSequence = (events: ReadonlyArray<DurableEvent>): Option.Option<number> =>
  events.length === 0 ? Option.none() : Option.some(events[events.length - 1]!.sequence)
