import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Layer, Queue, Stream } from "effect"
import type { FxStreamLine, FxTurn, FxTurnResult } from "libfx"
import { Database } from "./database.js"
import { CrashInjector } from "./crash.js"
import { RuntimeRegistry } from "./runtime-registry.js"
import { Sessions } from "./sessions.js"
import { ToolRegistry, type AgentToolSet } from "./tool-registry.js"
import { ModelError, NotFoundError, type RuntimeConfigurationError, type StorageError } from "../domain/errors.js"
import type { DurableAgentRecord, SubmissionContent, SubmissionRecord, SubmissionResult, TurnUsage } from "../domain/schema.js"
import type { CallContext } from "./tool-executor.js"

/**
 * Requests to agents, carried by libfx sessions.
 *
 * A request is recorded first (intent precedes effect), then prompted into
 * the agent's session under a `messageId` derived from it. libfx stores the
 * prompt, queues it behind the session's running turn, and runs it; this
 * process follows the turn to record its answer and outcome. After a crash,
 * `resume()` prompts every unfinished request again under the same
 * `messageId`: libfx continues the turn from its last step, or reports the
 * outcome it already reached.
 */

export interface AgentsInterface {
  /** Record a request and prompt it; resolves once libfx has stored the prompt. */
  readonly submit: (
    agentId: string,
    content: SubmissionContent,
    requestId: string | null
  ) => Effect.Effect<{ readonly record: SubmissionRecord; readonly created: boolean }, AgentsError>
  /** Prompt every unfinished request again, so its turn continues. Returns their ids. */
  readonly resume: () => Effect.Effect<ReadonlyArray<string>, AgentsError>
  /** Wait for a request to finish. */
  readonly settled: (agentId: string, id: string) => Effect.Effect<SubmissionRecord, AgentsError>
  /** Live events of a request this process follows, from now on. */
  readonly turnEvents: (agentId: string, id: string) => Stream.Stream<FxStreamLine, AgentsError>
  readonly steer: (agentId: string, text: string) => Effect.Effect<void, AgentsError>
  /** Cancel a request's turn (or the session's running one). */
  readonly cancel: (agentId: string, id: string | null) => Effect.Effect<void, AgentsError>
  /** Everything the agent's current session has produced from `after` on, then live. */
  readonly events: (agentId: string, after: number, follow: boolean) => Stream.Stream<FxStreamLine, AgentsError>
  /** The agent's conversation as libfx checkpoint bytes (empty when it has no session yet). */
  readonly checkpoint: (agentId: string) => Effect.Effect<Uint8Array, AgentsError>
}

export type AgentsError = StorageError | NotFoundError | RuntimeConfigurationError | ModelError

export class Agents extends Context.Service<Agents, AgentsInterface>()("fx-durable/Agents") {}

/** libfx ids: 1 to 255 letters, digits, `.`, `_`, or `-`. */
const LIBFX_ID = /^[A-Za-z0-9._-]{1,255}$/

/** The `messageId` for a request: its `requestId` when libfx accepts it as one, otherwise derived from it. */
export const messageIdFor = (requestId: string | null): string => {
  if (requestId === null) return `msg_${randomUUID().replaceAll("-", "")}`
  return LIBFX_ID.test(requestId) ? requestId : `req_${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const usageOf = (usage: FxTurnResult["usage"]): TurnUsage | null => (usage ? { ...usage } : null)

/** How a libfx turn ended, as the request's outcome. */
const outcomeOf = (result: FxTurnResult, text: string) => {
  const usage = usageOf(result.usage)
  switch (result.stopReason) {
    case "cancelled":
      return { state: "cancelled" as const, result: null, error: "cancelled" }
    case "error":
      return { state: "failed" as const, result: null, error: result.error?.message ?? "the turn failed" }
    case "unknown":
      return { state: "failed" as const, result: null, error: "the process running the turn stopped before recording how it ended" }
    default:
      return { state: "completed" as const, result: { text, stopReason: result.stopReason, usage } satisfies SubmissionResult, error: null }
  }
}

/** Parse an NDJSON stream of libfx lines. */
const lines = (readable: ReadableStream<Uint8Array>): Stream.Stream<FxStreamLine, ModelError> =>
  Stream.fromReadableStream({ evaluate: () => readable, onError: (cause) => new ModelError({ agentId: "", message: message(cause), cause }) }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim().length > 0),
    // SAFETY: libfx writes each line as one JSON-encoded FxStreamLine.
    Stream.map((line) => JSON.parse(line) as FxStreamLine)
  )

/** The final answer of a turn: the text after its last tool call. */
const answerOf = (events: Iterable<FxStreamLine>, messageId: string): string => {
  let text = ""
  for (const event of events) {
    if ("messageId" in event && event.messageId !== messageId) continue
    if (event.type === "text_delta") text += event.delta
    if (event.type === "tool_start") text = ""
  }
  return text
}

interface Followed {
  readonly turn: FxTurn
  readonly abort: AbortController
  readonly events: Array<FxStreamLine>
  readonly listeners: Set<(event: FxStreamLine | null) => void>
}

export const layer = Layer.effect(
  Agents,
  Effect.gen(function* () {
    const database = yield* Database
    const crash = yield* CrashInjector
    const registry = yield* RuntimeRegistry
    const tools = yield* ToolRegistry
    const sessions = yield* Sessions
    const followed = new Map<string, Followed>()
    const keyOf = (agentId: string, id: string) => `${agentId}\u0000${id}`

    const requireAgent = (agentId: string) =>
      Effect.flatMap(database.read((storage) => storage.getAgent(agentId)), (agent) =>
        agent ? Effect.succeed(agent) : Effect.fail(new NotFoundError({ entity: "agent", id: agentId }))
      )

    /** Where a session lives: its store, and its id (null until libfx accepts the first prompt of one started from a checkpoint). */
    interface Placement {
      readonly store: string
      readonly sessionId: string | null
    }

    /** Does a store hold sessions of this tool set? (A store started from a checkpoint is named after its tool set.) */
    const holds = (store: string, key: string) => store === key || store.startsWith(`${key}.`)

    const hasRunning = (agentId: string) =>
      Effect.map(database.read((storage) => storage.runningSubmissions()), (running) => running.some((record) => record.agentId === agentId))

    const failure = (agentId: string, what: string) => (cause: unknown) => new ModelError({ agentId, message: `${what}: ${message(cause)}`, cause })

    /**
     * Where the agent's next request goes. An agent without a session gets one
     * in its tool set's store. One whose tools changed since its session
     * started (and has nothing running) continues its conversation in a store
     * for the new tools, from a checkpoint.
     */
    const place = (given: DurableAgentRecord) =>
      Effect.gen(function* () {
        const toolSet = yield* tools.toolSet(given)
        let agent = given
        if (agent.sessionId && agent.sessionStore && !holds(agent.sessionStore, toolSet.key) && !(yield* hasRunning(agent.id))) {
          const old = yield* sessions.agentFor(agent.sessionStore, toolSet.offered)
          const sessionId = agent.sessionId
          const conversation = yield* Effect.tryPromise({ try: () => old.session(sessionId).checkpoint(), catch: failure(agent.id, "could not read the session") })
          yield* database.run((journal) => journal.moveSession(given.id, conversation))
          agent = yield* requireAgent(given.id)
        }
        if (agent.sessionId && agent.sessionStore) return { agent, toolSet, placement: { store: agent.sessionStore, sessionId: agent.sessionId } satisfies Placement }
        // A session started from a checkpoint gets a store of its own (see Sessions).
        if (agent.startCheckpoint) {
          return { agent, toolSet, placement: { store: `${toolSet.key}.${randomUUID().replaceAll("-", "").slice(0, 12)}`, sessionId: null } satisfies Placement }
        }
        const fx = yield* sessions.agentFor(toolSet.key, toolSet.offered)
        const sessionId = yield* Effect.tryPromise({ try: () => fx.newSessionId(), catch: failure(agent.id, "could not create a session") })
        yield* database.run((journal) => journal.setSession(given.id, sessionId, toolSet.key))
        return { agent: { ...agent, sessionId, sessionStore: toolSet.key }, toolSet, placement: { store: toolSet.key, sessionId } satisfies Placement }
      })

    /** Open a placed session with the settings of a turn: the agent's model, rendered instructions, and who calls tools. */
    const open = (agent: DurableAgentRecord, toolSet: AgentToolSet, placement: Placement, submissionId: string | null) =>
      Effect.gen(function* () {
        const checkpoint = placement.sessionId === null ? (agent.startCheckpoint ?? undefined) : undefined
        const fx = yield* sessions.agentFor(placement.store, toolSet.offered, checkpoint)
        const instructions = yield* tools.instructions(agent, toolSet.extensions)
        const context: CallContext = { agentId: agent.id, submissionId, cwd: agent.cwd }
        const options = instructions === undefined ? { model: agent.model, context } : { model: agent.model, context, instructions }
        // Without an id, libfx starts a new session from the store's checkpoint.
        return placement.sessionId === null ? fx.session(undefined, options) : fx.session(placement.sessionId, options)
      })

    const placementOf = (record: SubmissionRecord): Placement => ({ store: record.sessionStore, sessionId: record.sessionId === "" ? null : record.sessionId })

    /** The agent's current session, opened for steering, cancelling, or reading; null when it has none. */
    const sessionOf = (agentId: string) =>
      Effect.gen(function* () {
        const agent = yield* requireAgent(agentId)
        if (!agent.sessionId || !agent.sessionStore) return null
        const toolSet = yield* tools.toolSet(agent)
        return yield* open(agent, toolSet, { store: agent.sessionStore, sessionId: agent.sessionId }, null)
      })

    /** Follow a prompted turn in the background: collect its answer, record its outcome. */
    const follow = (record: SubmissionRecord, turn: FxTurn, abort: AbortController) => {
      const key = keyOf(record.agentId, record.id)
      const entry: Followed = { turn, abort, events: [], listeners: new Set() }
      followed.set(key, entry)
      const emit = (event: FxStreamLine | null) => {
        for (const listener of entry.listeners) listener(event)
      }
      void (async () => {
        for await (const event of turn) {
          const line: FxStreamLine = { ...event, messageId: record.id }
          entry.events.push(line)
          emit(line)
        }
        const result = await turn.result
        let text = answerOf(entry.events, record.id)
        // A turn that ended elsewhere replays nothing here: read its answer from the session.
        if (result.repeated && text === "") text = await Effect.runPromise(answerFromSession(record))
        const outcome = outcomeOf(result, text)
        database.runSync((journal) => journal.finishSubmission(record.agentId, record.id, outcome))
      })()
        .catch((cause: unknown) => {
          try {
            database.runSync((journal) => journal.finishSubmission(record.agentId, record.id, { state: "failed", result: null, error: message(cause) }))
          } catch {
            // Storage failed: fx-durable is closing; resume() finishes the request.
          }
        })
        .finally(() => {
          followed.delete(key)
          emit(null)
        })
    }

    /** Read a finished turn's answer back from its session's stream. */
    const answerFromSession = (record: SubmissionRecord) =>
      Effect.gen(function* () {
        const agent = yield* requireAgent(record.agentId)
        const session = yield* open(agent, yield* tools.toolSet(agent), placementOf(record), record.id)
        const seen: Array<FxStreamLine> = []
        yield* lines(session.stream(0)).pipe(
          Stream.takeUntil((line) => line.type === "turn_end" && line.messageId === record.id),
          Stream.runForEach((line) => Effect.sync(() => seen.push(line)))
        )
        return answerOf(seen, record.id)
      }).pipe(Effect.orElseSucceed(() => ""))

    /** Prompt a recorded request into its session (again, after a crash) and follow its turn. */
    const prompt = (agent: DurableAgentRecord, record: SubmissionRecord) =>
      Effect.gen(function* () {
        if (followed.has(keyOf(record.agentId, record.id))) return
        const placement = placementOf(record)
        const session = yield* open(agent, yield* tools.toolSet(agent), placement, record.id)
        const abort = new AbortController()
        const turn = session.prompt(record.content, { messageId: record.id, signal: abort.signal })
        const accepted = yield* Effect.tryPromise({
          try: () => turn.accepted,
          catch: (cause) => new ModelError({ agentId: agent.id, message: `the request was not accepted: ${message(cause)}`, cause })
        })
        if (placement.sessionId === null) yield* database.run((journal) => journal.assignSession(agent.id, record.id, accepted.sessionId, placement.store))
        follow(record, turn, abort)
        yield* crash.hit("submission.after-accept")
      })

    const submit = Effect.fn("Agents.submit")(function* (agentId: string, content: SubmissionContent, requestId: string | null) {
      const agent = yield* requireAgent(agentId)
      const id = messageIdFor(requestId)
      const known = yield* database.read((storage) => storage.getSubmission(agentId, id))
      if (known) {
        if (known.state === "running") yield* prompt(agent, known)
        return { record: known, created: false }
      }
      // The session is chosen (and created) before the request is recorded; one started from a
      // checkpoint gets its id when libfx accepts the request.
      const placed = yield* place(agent)
      const admitted = yield* database.run((journal) =>
        journal.admitSubmission({
          agentId,
          id,
          requestId,
          sessionId: placed.placement.sessionId ?? "",
          sessionStore: placed.placement.store,
          model: agent.model,
          content
        })
      )
      yield* crash.hit("submission.after-persist")
      if (admitted.record.state === "running") yield* prompt(placed.agent, admitted.record)
      return admitted
    })

    const resume = Effect.fn("Agents.resume")(function* () {
      const resumed: Array<string> = []
      for (const record of yield* database.read((storage) => storage.runningSubmissions())) {
        const agent = yield* database.read((storage) => storage.getAgent(record.agentId))
        if (!agent || !(yield* registry.has(agent.runtimeId))) continue // its runtime is registered later; resume() again then
        yield* prompt(agent, record)
        resumed.push(record.id)
      }
      return resumed
    })

    const settled = (agentId: string, id: string): Effect.Effect<SubmissionRecord, AgentsError> =>
      Effect.gen(function* () {
        const current = yield* database.read((storage) => storage.getSubmission(agentId, id))
        if (!current) return yield* new NotFoundError({ entity: "submission", id })
        if (current.state !== "running") return current
        // Finished here (a commit notification) or by another process (seen when polling).
        yield* Effect.callback<void>((resume) => {
          // The cleanup returned below runs only on interruption; a normal wake-up cleans up itself.
          const wake = () => {
            unsubscribe()
            clearInterval(poll)
            resume(Effect.void)
          }
          const unsubscribe = database.onCommitted((change) => {
            if (change.type === "submission.finished" && change.agentId === agentId && change.id === id) wake()
          })
          const poll = setInterval(wake, 500)
          return Effect.sync(() => {
            unsubscribe()
            clearInterval(poll)
          })
        })
        return yield* settled(agentId, id)
      })

    const turnEvents = (agentId: string, id: string): Stream.Stream<FxStreamLine, AgentsError> =>
      Stream.callback<FxStreamLine>((queue) =>
        Effect.sync(() => {
          const entry = followed.get(keyOf(agentId, id))
          if (!entry) {
            Queue.endUnsafe(queue)
            return
          }
          for (const event of entry.events) Queue.offerUnsafe(queue, event)
          entry.listeners.add((event) => {
            if (event === null) Queue.endUnsafe(queue)
            else Queue.offerUnsafe(queue, event)
          })
        })
      )

    const steer = Effect.fn("Agents.steer")(function* (agentId: string, text: string) {
      const session = yield* sessionOf(agentId)
      if (!session) return yield* new NotFoundError({ entity: "session of agent", id: agentId })
      yield* Effect.tryPromise({ try: () => session.steer(text), catch: (cause) => new ModelError({ agentId, message: message(cause), cause }) })
    })

    const cancel = Effect.fn("Agents.cancel")(function* (agentId: string, id: string | null) {
      const entry = id === null ? undefined : followed.get(keyOf(agentId, id))
      if (entry) {
        entry.abort.abort()
        return
      }
      const session = yield* sessionOf(agentId)
      if (!session) return
      yield* Effect.tryPromise({ try: () => session.cancel(), catch: (cause) => new ModelError({ agentId, message: message(cause), cause }) })
    })

    const events = (agentId: string, after: number, follow: boolean): Stream.Stream<FxStreamLine, AgentsError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const session = yield* sessionOf(agentId)
          if (!session) return Stream.empty
          const all = lines(session.stream(after))
          if (follow) return all
          // Without following, stop at the end of the latest request in this session (a session
          // that is already idle writes no line saying so).
          const agent = yield* requireAgent(agentId)
          const [latest] = yield* database.read((storage) => storage.listSubmissions(agentId, 1))
          if (!latest || latest.sessionId !== agent.sessionId) return Stream.empty
          return all.pipe(Stream.takeUntil((line) => line.type === "turn_end" && line.messageId === latest.id))
        })
      )

    const checkpoint = (agentId: string) =>
      Effect.flatMap(sessionOf(agentId), (session) =>
        session
          ? Effect.tryPromise({ try: () => session.checkpoint(), catch: (cause) => new ModelError({ agentId, message: message(cause), cause }) })
          : Effect.succeed(new Uint8Array())
      )

    return Agents.of({ submit, resume, settled, turnEvents, steer, cancel, events, checkpoint })
  })
)
