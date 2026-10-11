import { bindTools } from "../tools/subagent.js"
import type { ForkSpec } from "../durable/journal.js"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Stream } from "effect"
import type * as Sqlite from "../durable/sqlite/storage.js"
import * as Executor from "./tool-executor.js"
import * as Registry from "./tool-registry.js"
import { AgentSupervisor, layer as supervisorLayer } from "./supervisor.js"
import { CrashInjector, type CrashPlan } from "./crash.js"
import { AgentBusyError, AgentExistsError, DurableFxFailedError, NotFoundError, SubmissionError, type StorageError } from "../domain/errors.js"
import { EventLog, layer as eventLogLayer } from "./events.js"
import { IdGenerator } from "./ids.js"
import { Database, databaseLayer } from "./database.js"
import type { Clock } from "../durable/clock.js"
import * as LibFxModule from "./libfx.js"
import { RecoveryManager, layer as recoveryLayer, type RecoveryReport } from "./recovery.js"
import { RuntimeRegistry, type RuntimeDefinition } from "./runtime-registry.js"
import {
  SubmissionContent,
  decodeWith,
  type DurableAgentRecord,
  type DurableEvent,
  type SubmissionKind,
  type SubmissionRecord,
  type SubmissionResult,
  type TaskRecord,
  type TurnRecord
} from "../domain/schema.js"
import type { Storage } from "../durable/storage.js"
import type { Transport } from "../domain/transport.js"
import { usageOf, type ModelPrices, type UsageReport } from "../domain/usage.js"
import { buildTaskGraph, type TaskGraph } from "../domain/task-graph.js"

/**
 * Promise/AsyncIterable façade over the Effect-native runtime, so adopting
 * fx-durable does not require application code to use Effect.
 */

export interface DurableFxOptions {
  /**
   * `sqlite(path)`, or any object implementing the synchronous `Storage`
   * interface. fx-durable closes the storage when it closes.
   */
  readonly storage: Sqlite.SqliteStorageConfig | Storage
  readonly runtimes?: Readonly<Record<string, RuntimeDefinition>>
  /** AI Gateway key. Defaults to `AI_GATEWAY_API_KEY`. */
  readonly apiKey?: string
  /** Model transport override (e.g. a scripted model for tests and offline demos). */
  readonly fetch?: Transport
  readonly backend?: "auto" | "native" | "wasm"
  /** `auto` (default) recovers interrupted work during `open()`; `manual` waits for `resume()`. */
  readonly recovery?: "auto" | "manual"
  readonly maxRecoveryAttempts?: number
  /** Crash injection. Defaults to reading `FXD_CRASH_AT` from the environment (no-op when unset). */
  readonly crash?: (CrashPlan & { readonly onCrash?: (point: string) => void }) | "env" | "off"
  readonly heartbeatMillis?: number
  readonly idlePollMillis?: number
}

export interface AgentOptions {
  readonly runtime: string
  readonly model: string
  readonly cwd?: string | null
}

export interface SubmitOptions {
  /** External idempotency key: repeated submissions resolve to the same logical submission. */
  readonly requestId?: string
  /**
   * When the agent is already working: `"queue"` (default) runs this request
   * after the current ones; `"reject"` submits nothing and rejects with
   * `AgentBusyError`. To join the work in progress, use `agent.steer()`.
   */
  readonly whenBusy?: "queue" | "reject"
}

export interface ResetOptions {
  /** A handoff: what the model should know in the new context. */
  readonly summary?: string
  readonly requestId?: string
}

export interface CompactOptions {
  /** Extra guidance for the summary, e.g. "keep the list of failing tests". */
  readonly instructions?: string
  readonly requestId?: string
}

export interface EventsOptions {
  readonly after?: number
  /** Stop after replaying persisted events instead of following live. */
  readonly follow?: boolean
  readonly pollInterval?: number
}

export interface UsageOptions {
  /** USD per million tokens by model id. Without a model's price, its `costUsd` (and the total's) is `null`. */
  readonly prices?: ModelPrices
}

/** How many of an agent's latest submissions `taskGraph()` looks through for queued ones. */
const QUEUED_LIMIT = 500

/** libfx's limit for one steering message. */
const MAX_STEERING_BYTES = 64 * 1024

const TERMINAL_EVENTS = new Set(["submission.completed", "submission.failed", "submission.cancelled"])

type Services = Database | EventLog | IdGenerator | RuntimeRegistry | AgentSupervisor | RecoveryManager | CrashInjector

const decodeContent = decodeWith(SubmissionContent, "submission content")

/** Effect-native overrides, available from `fx-durable/effect`. */
export interface DurableFxLayers {
  readonly ids?: Layer.Layer<IdGenerator>
  /** The journal's clock (defaults to the system clock). */
  readonly clock?: Clock
}

/** The complete fx-durable service graph as one Effect `Layer`. */
export const buildLayer = (options: DurableFxOptions, layers: DurableFxLayers = {}) => {
  const crash =
    options.crash === "off"
      ? CrashInjector.noop
      : options.crash === undefined || options.crash === "env"
        ? CrashInjector.fromEnv()
        : CrashInjector.make({
            ...options.crash,
            onCrash: options.crash.onCrash ?? ((point) => {
              throw new Error(`crash injected at ${point}`)
            })
          })
  const ids = layers.ids ?? IdGenerator.layer
  const base = Layer.mergeAll(
    databaseLayer(options.storage, layers.clock).pipe(Layer.provideMerge(ids)),
    crash,
    RuntimeRegistry.layer(options.runtimes ?? {}),
    Registry.layer,
    LibFxModule.layer({ apiKey: options.apiKey, fetch: options.fetch, backend: options.backend })
  )
  const events = eventLogLayer.pipe(Layer.provideMerge(base))
  const journal = Executor.layer.pipe(Layer.provideMerge(events))
  const supervisor = supervisorLayer({
    heartbeatMillis: options.heartbeatMillis,
    idlePollMillis: options.idlePollMillis
  }).pipe(Layer.provideMerge(journal))
  return recoveryLayer({ maxAttempts: options.maxRecoveryAttempts }).pipe(Layer.provideMerge(supervisor))
}

/** Why a `DurableFx` closed: `close()` was called, or a storage error closed it. */
export type CloseReason = { readonly reason: "closed" } | { readonly reason: "failed"; readonly error: StorageError }

interface Runner {
  readonly run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>
  readonly stream: <A, E>(stream: Stream.Stream<A, E, Services>) => AsyncIterable<A>
  /** Shut down (once) and dispose the runtime; later calls reject. */
  readonly close: () => Promise<void>
  readonly closed: Promise<CloseReason>
}

// The Effect runtime behind each façade object. Module-private, so the
// public classes expose no Effect types.
const runners = new WeakMap<DurableFx, Runner>()

const notOpen = () => new Error("DurableFx is not open")

const failedError = (cause: StorageError) =>
  new DurableFxFailedError({ message: `fx-durable closed after a storage error: ${cause.message}`, cause })

const runnerOf = (fx: DurableFx): Runner => {
  const runner = runners.get(fx)
  if (!runner) throw notOpen()
  return runner
}

/** Run on an open façade; a closed, failed, or never-opened one rejects instead of throwing. */
const runOn = <A, E>(fx: DurableFx, effect: Effect.Effect<A, E, Services>): Promise<A> => {
  const runner = runners.get(fx)
  return runner ? runner.run(effect) : Promise.reject(notOpen())
}

/** Open with Effect-native layer overrides (see `fx-durable/effect`). */
export const openDurableFx = async (options: DurableFxOptions, layers: DurableFxLayers = {}): Promise<DurableFx> => {
  const runtime = ManagedRuntime.make(buildLayer(options, layers))
  const context = await runtime.context()
  const fx = new DurableFx()

  let failure: StorageError | null = null
  let closing: Promise<void> | null = null
  let settle: (reason: CloseReason) => void = () => undefined
  const closed = new Promise<CloseReason>((resolve) => {
    settle = resolve
  })
  const shutdown = (reason: CloseReason) => {
    closing ??= (async () => {
      await runtime.runPromise(Effect.flatMap(AgentSupervisor, (s) => s.shutdown())).catch(() => undefined)
      await runtime.dispose().catch(() => undefined)
      settle(reason)
    })()
    return closing
  }

  runners.set(fx, {
    run: async (effect) => {
      if (failure) throw failedError(failure)
      if (closing) throw notOpen()
      const exit = await runtime.runPromiseExit(effect)
      if (Exit.isSuccess(exit)) return exit.value
      const error = Cause.squash(exit.cause)
      // The call that hit the storage error rejects with it; the others with DurableFxFailedError.
      if (failure && error !== failure) throw failedError(failure)
      throw error
    },
    stream: (stream) => Stream.toAsyncIterableWith(stream, context),
    close: () => shutdown({ reason: "closed" }),
    closed
  })

  await runtime.runPromise(
    Effect.map(Database, (database) =>
      database.onFailure((error) => {
        failure = error
        // Not from inside the failing call: it runs on the runtime being disposed.
        setTimeout(() => void shutdown({ reason: "failed", error }), 0)
      })
    )
  )

  // Before recovery: a recovered turn may call a subagent tool.
  for (const definition of Object.values(options.runtimes ?? {})) bindTools(fx, definition.tools ?? [])
  if ((options.recovery ?? "auto") === "auto") {
    try {
      await fx.resume()
    } catch (error) {
      await shutdown(failure ? { reason: "failed", error: failure } : { reason: "closed" })
      throw error
    }
  }
  return fx
}

export class DurableFx {
  /** Use `DurableFx.open()`; an instance created directly is not open. */

  /** Open the durable runtime. With `recovery: "auto"` (default), interrupted work resumes now. */
  static open(options: DurableFxOptions): Promise<DurableFx> {
    return openDurableFx(options)
  }

  private run<A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> {
    return runOn(this, effect)
  }

  registerRuntime(id: string, definition: RuntimeDefinition): Promise<void> {
    bindTools(this, definition.tools ?? [])
    return this.run(
      Effect.gen(function* () {
        const registry = yield* RuntimeRegistry
        yield* registry.register(id, definition)
      })
    )
  }

  /** Recover interrupted turns whose executor is gone, then start workers for pending work. */
  resume(): Promise<RecoveryReport> {
    return this.run(Effect.flatMap(RecoveryManager, (recovery) => recovery.resume()))
  }

  /**
   * Get or create a stable logical agent. `agent("engineer")` refers to the
   * same durable agent across application restarts.
   */
  async agent(id: string, options: AgentOptions): Promise<DurableAgent> {
    await this.run(
      Effect.gen(function* () {
        const database = yield* Database
        const registry = yield* RuntimeRegistry
        const supervisor = yield* AgentSupervisor
        yield* registry.resolve(options.runtime)
        yield* database.run((journal) => journal.upsertAgent(id, options))
        yield* supervisor.ensureWorker(id)
      })
    )
    return new DurableAgent(this, id)
  }

  /** Attach to an existing agent without changing it. Clients attach; they do not own execution. */
  async attach(id: string): Promise<DurableAgent> {
    await this.run(
      Effect.gen(function* () {
        const database = yield* Database
        const agent = yield* database.read((storage) => storage.getAgent(id))
        if (!agent) return yield* new NotFoundError({ entity: "agent", id })
      })
    )
    return new DurableAgent(this, id)
  }

  /** Token and cost totals across every agent, from the journaled model requests. */
  usage(options: UsageOptions = {}): Promise<UsageReport> {
    return this.run(
      Effect.gen(function* () {
        const database = yield* Database
        const log = yield* EventLog
        const agents = yield* database.read((storage) => storage.listAgents())
        const events: Array<DurableEvent> = []
        for (const agent of agents) events.push(...(yield* log.history(agent.id)))
        return usageOf(events, options.prices)
      })
    )
  }

  /**
   * Running work across every agent as one graph: turns, model and tool
   * calls, nested calls under their callers, and subagent turns under the
   * tool calls that started them; plus queued requests. A snapshot of what is
   * committed; re-read it on events to keep a view current.
   */
  taskGraph(): Promise<TaskGraph> {
    return this.run(
      Effect.flatMap(Database, (database) =>
        database.read((storage) => {
          const queued = storage
            .listAgents()
            .flatMap((agent) => storage.listSubmissions(agent.id, QUEUED_LIMIT).filter((s) => s.state === "queued").reverse())
          return buildTaskGraph(storage.unfinishedTasks(), queued)
        })
      )
    )
  }

  listAgents(): Promise<ReadonlyArray<DurableAgentRecord>> {
    return this.run(Effect.flatMap(Database, (database) => database.read((storage) => storage.listAgents())))
  }

  /** Stop executing. In-flight turns are left interrupted and recover on the next open. */
  async close(): Promise<void> {
    await runners.get(this)?.close()
  }

  /**
   * Settles once this instance has closed: `{ reason: "closed" }` after
   * `close()`, or `{ reason: "failed", error }` after a storage error closed
   * it. Everything committed before the error is kept; open again to recover.
   * Calls made after a failure reject with `DurableFxFailedError`.
   */
  get closed(): Promise<CloseReason> {
    return runnerOf(this).closed
  }
}

export class DurableAgent {
  constructor(
    private readonly fx: DurableFx,
    readonly id: string
  ) {}

  /** Durably accept a request. The submission is committed before this resolves. */
  submit(content: SubmissionContent, options: SubmitOptions = {}): Promise<Submission> {
    return this.admit("input", content, options)
  }

  /**
   * Start a new context: from the next request on, the model no longer sees
   * this conversation (it stays in the journal and in older checkpoints, so
   * forks can still start from it). With `summary`, a handoff, the model sees
   * that text in its instructions instead. Queued like a request: it runs
   * after the work already queued, and its submission resolves once it has.
   */
  reset(options: ResetOptions = {}): Promise<Submission> {
    return this.admit("reset", options.summary ?? "", { requestId: options.requestId })
  }

  /**
   * Replace the context with a summary the model writes of it: a reset whose
   * handoff is a compaction. The summary is one model request, journaled and
   * counted in `usage()` like any other; the submission's result is the
   * summary. Queued like a request. Runtimes can also compact automatically
   * (`RuntimeDefinition.compaction`).
   */
  compact(options: CompactOptions = {}): Promise<Submission> {
    return this.admit("compaction", options.instructions ?? "", { requestId: options.requestId })
  }

  private async admit(kind: SubmissionKind, content: SubmissionContent, options: SubmitOptions): Promise<Submission> {
    const agentId = this.id
    const requestId = options.requestId ?? null
    const reject = options.whenBusy === "reject"
    const { record, created } = await runOn(
      this.fx,
      Effect.gen(function* () {
        const database = yield* Database
        const supervisor = yield* AgentSupervisor
        const crash = yield* CrashInjector
        const decoded = yield* decodeContent(content)
        const admitted = yield* database.run((journal) =>
          reject ? journal.submitIfIdle(agentId, requestId, decoded) : journal.submit(agentId, requestId, decoded, kind)
        )
        if (admitted === null) return yield* new AgentBusyError({ agentId, message: `agent ${agentId} is busy` })
        const result = admitted
        yield* crash.hit("submission.after-persist")
        yield* supervisor.ensureWorker(agentId)
        yield* supervisor.wake(agentId)
        return result
      })
    )
    return new Submission(this.fx, record.id, agentId, record.requestId, created)
  }

  /**
   * Start a new agent from this one's conversation at a turn boundary: by
   * default its latest checkpoint, or the one written when submission `after`
   * completed, or checkpoint sequence `checkpoint`. The fork keeps the
   * runtime, model and working directory unless overridden, then continues
   * on its own; this agent is not touched. Rejects with `AgentExistsError` if
   * `id` is taken.
   */
  async fork(id: string, options: ForkSpec = {}): Promise<DurableAgent> {
    const sourceId = this.id
    const created = await runOn(
      this.fx,
      Effect.flatMap(Database, (database) => database.run((journal) => journal.forkAgent(sourceId, id, options)))
    )
    if (!created) throw new AgentExistsError({ agentId: id, message: `agent ${id} already exists` })
    return new DurableAgent(this.fx, id)
  }

  /**
   * Add guidance to the turn that is running now, like typing while a coding
   * agent works. It is journaled first and reaches the model at its next safe
   * boundary; if the process dies, the recovered attempt receives it too.
   * When no turn is running, or the turn finishes before the guidance reaches
   * it, the text is submitted as a new request instead. Resolves with the
   * submission that will act on it.
   */
  async steer(text: string): Promise<Submission> {
    if (text.trim().length === 0) throw new TypeError("steering text cannot be empty")
    if (Buffer.byteLength(text) > MAX_STEERING_BYTES) throw new RangeError(`steering text exceeds ${MAX_STEERING_BYTES} bytes`)
    const agentId = this.id
    const outcome = await runOn(this.fx, Effect.flatMap(AgentSupervisor, (supervisor) => supervisor.steer(agentId, text)))
    if (outcome.kind === "idle" || outcome.kind === "missed") return this.submit(text)
    return new Submission(this.fx, outcome.submissionId, agentId, null, false)
  }

  /** Persisted events after the cursor, then live events, without gaps. */
  events(options: EventsOptions = {}): AsyncIterable<DurableEvent> {
    const agentId = this.id
    return runnerOf(this.fx).stream(
      Stream.unwrap(
        Effect.gen(function* () {
          const log = yield* EventLog
          if (options.follow === false) {
            return Stream.fromIterable(yield* log.history(agentId, options.after ?? 0))
          }
          return log.subscribe(agentId, { after: options.after, pollInterval: options.pollInterval })
        })
      )
    )
  }

  /** This agent's token and cost totals, from its journaled model requests. A fork counts only its own. */
  usage(options: UsageOptions = {}): Promise<UsageReport> {
    const agentId = this.id
    return runOn(this.fx, Effect.map(Effect.flatMap(EventLog, (log) => log.history(agentId)), (events) => usageOf(events, options.prices)))
  }

  info(): Promise<DurableAgentRecord> {
    const id = this.id
    return runOn(
      this.fx,
      Effect.gen(function* () {
        const database = yield* Database
        const agent = yield* database.read((storage) => storage.getAgent(id))
        if (!agent) return yield* new NotFoundError({ entity: "agent", id })
        return agent
      })
    )
  }

  submissions(limit = 20): Promise<ReadonlyArray<SubmissionRecord>> {
    return runOn(this.fx, Effect.flatMap(Database, (database) => database.read((storage) => storage.listSubmissions(this.id, limit))))
  }

  /** The submission made with `requestId`, or null if there is none. */
  async submission(requestId: string): Promise<Submission | null> {
    const agentId = this.id
    const record = await runOn(
      this.fx,
      Effect.flatMap(Database, (database) => database.read((storage) => storage.findSubmissionByRequest(agentId, requestId)))
    )
    return record ? new Submission(this.fx, record.id, agentId, record.requestId, false) : null
  }

  /** One journaled task (a tool or model call) of this agent, with its input and output. */
  task(taskId: string): Promise<TaskRecord> {
    const agentId = this.id
    return runOn(
      this.fx,
      Effect.gen(function* () {
        const database = yield* Database
        const task = yield* database.read((storage) => storage.getTask(taskId))
        if (!task || task.agentId !== agentId) return yield* new NotFoundError({ entity: "task", id: taskId })
        return task
      })
    )
  }

  /** Current turn and its task journal, if any. */
  currentTurn(): Promise<{ readonly turn: TurnRecord; readonly tasks: ReadonlyArray<TaskRecord> } | null> {
    const id = this.id
    return runOn(
      this.fx,
      Effect.gen(function* () {
        const database = yield* Database
        const turn = yield* database.read((storage) => storage.activeTurn(id))
        if (!turn) return null
        return { turn, tasks: yield* database.read((storage) => storage.tasksForTurn(turn.id)) }
      })
    )
  }
}

export class Submission {
  constructor(
    private readonly fx: DurableFx,
    readonly id: string,
    readonly agentId: string,
    readonly requestId: string | null,
    /** False when this call resolved to an existing submission with the same requestId. */
    readonly created: boolean
  ) {}

  status(): Promise<SubmissionRecord> {
    const id = this.id
    return runOn(
      this.fx,
      Effect.gen(function* () {
        const database = yield* Database
        const record = yield* database.read((storage) => storage.getSubmission(id))
        if (!record) return yield* new NotFoundError({ entity: "submission", id })
        return record
      })
    )
  }

  /** This submission's durable events, ending once it reaches a terminal state. */
  events(options: { readonly after?: number } = {}): AsyncIterable<DurableEvent> {
    const id = this.id
    const agentId = this.agentId
    return runnerOf(this.fx).stream(
      Stream.unwrap(
        Effect.gen(function* () {
          const log = yield* EventLog
          return log.subscribe(agentId, { after: options.after }).pipe(
            Stream.filter((event) => event.submissionId === id),
            Stream.takeUntil((event) => TERMINAL_EVENTS.has(event.type))
          )
        })
      )
    )
  }

  /** Resolve with the result once completed; reject with `SubmissionError` if it failed or was cancelled. */
  result(): Promise<SubmissionResult> {
    const id = this.id
    const agentId = this.agentId
    return runOn(
      this.fx,
      Effect.gen(function* () {
        const database = yield* Database
        const log = yield* EventLog
        const settled = (record: SubmissionRecord | null) =>
          record !== null && (record.state === "completed" || record.state === "failed" || record.state === "cancelled")
        let record = yield* database.read((storage) => storage.getSubmission(id))
        if (!record) return yield* new NotFoundError({ entity: "submission", id })
        if (!settled(record)) {
          yield* log.subscribe(agentId).pipe(
            Stream.filter((event) => event.submissionId === id && TERMINAL_EVENTS.has(event.type)),
            Stream.runHead,
            Effect.map(Option.getOrUndefined)
          )
          record = yield* database.read((storage) => storage.getSubmission(id))
        }
        if (record?.state === "completed" && record.result) return record.result
        return yield* new SubmissionError({
          submissionId: id,
          state: record?.state ?? "unknown",
          message: record?.error ?? `submission ${record?.state ?? "missing"}`
        })
      })
    )
  }

  /**
   * Request cancellation. Local cancellation does not prove that an external
   * unsafe effect was cancelled: such tasks are recorded as outcome_unknown.
   */
  cancel(): Promise<void> {
    const id = this.id
    return runOn(this.fx, Effect.flatMap(AgentSupervisor, (s) => s.cancel(id)))
  }
}
