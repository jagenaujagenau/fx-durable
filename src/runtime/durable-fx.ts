import { bindTools } from "../tools/subagent.js"
import type { ForkSpec } from "../durable/journal.js"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Stream } from "effect"
import type * as Sqlite from "../durable/sqlite/storage.js"
import * as Executor from "./tool-executor.js"
import * as Registry from "./tool-registry.js"
import { AgentSupervisor, layer as supervisorLayer } from "./supervisor.js"
import { CrashInjector, type CrashPlan } from "./crash.js"
import { AgentBusyError, AgentExistsError, NotFoundError, SubmissionError } from "../domain/errors.js"
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
  type SubmissionRecord,
  type SubmissionResult,
  type TaskRecord,
  type TurnRecord
} from "../domain/schema.js"
import type { Storage } from "../durable/storage.js"
import type { Transport } from "../domain/transport.js"

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

export interface EventsOptions {
  readonly after?: number
  /** Stop after replaying persisted events instead of following live. */
  readonly follow?: boolean
  readonly pollInterval?: number
}

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

interface Runner {
  readonly run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>
  readonly stream: <A, E>(stream: Stream.Stream<A, E, Services>) => AsyncIterable<A>
  readonly dispose: () => Promise<void>
}

// The Effect runtime behind each façade object. Module-private, so the
// public classes expose no Effect types.
const runners = new WeakMap<DurableFx, Runner>()

const notOpen = () => new Error("DurableFx is not open")

const runnerOf = (fx: DurableFx): Runner => {
  const runner = runners.get(fx)
  if (!runner) throw notOpen()
  return runner
}

/** Run on an open façade; a closed or never-opened one rejects instead of throwing. */
const runOn = <A, E>(fx: DurableFx, effect: Effect.Effect<A, E, Services>): Promise<A> => {
  const runner = runners.get(fx)
  return runner ? runner.run(effect) : Promise.reject(notOpen())
}

/** Open with Effect-native layer overrides (see `fx-durable/effect`). */
export const openDurableFx = async (options: DurableFxOptions, layers: DurableFxLayers = {}): Promise<DurableFx> => {
  const runtime = ManagedRuntime.make(buildLayer(options, layers))
  const context = await runtime.context()
  const fx = new DurableFx()
  runners.set(fx, {
    run: (effect) =>
      runtime.runPromiseExit(effect).then((exit) => {
        if (Exit.isSuccess(exit)) return exit.value
        throw Cause.squash(exit.cause)
      }),
    stream: (stream) => Stream.toAsyncIterableWith(stream, context),
    dispose: () => runtime.dispose()
  })
  // Before recovery: a recovered turn may call a subagent tool.
  for (const definition of Object.values(options.runtimes ?? {})) bindTools(fx, definition.tools ?? [])
  if ((options.recovery ?? "auto") === "auto") await fx.resume()
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

  listAgents(): Promise<ReadonlyArray<DurableAgentRecord>> {
    return this.run(Effect.flatMap(Database, (database) => database.read((storage) => storage.listAgents())))
  }

  /** Stop executing. In-flight turns are left interrupted and recover on the next open. */
  async close(): Promise<void> {
    await this.run(Effect.flatMap(AgentSupervisor, (s) => s.shutdown())).catch(() => undefined)
    await runnerOf(this).dispose()
    runners.delete(this)
  }
}

export class DurableAgent {
  constructor(
    private readonly fx: DurableFx,
    readonly id: string
  ) {}

  /** Durably accept a request. The submission is committed before this resolves. */
  async submit(content: SubmissionContent, options: SubmitOptions = {}): Promise<Submission> {
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
        const admitted = yield* database
          .run((journal) => (reject ? journal.submitIfIdle(agentId, requestId, decoded) : journal.submit(agentId, requestId, decoded)))
          .pipe(
            // Another process may have won the UNIQUE(agent_id, request_id) race.
            Effect.catchTag("StorageError", (error) =>
              requestId !== null && /UNIQUE/i.test(error.message)
                ? Effect.flatMap(database.read((storage) => storage.findSubmissionByRequest(agentId, requestId)), (existing) =>
                    existing ? Effect.succeed({ record: existing, created: false }) : Effect.fail(error)
                  )
                : Effect.fail(error)
            )
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
