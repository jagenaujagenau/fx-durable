import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Stream } from "effect"
import * as Sqlite from "../sqlite/storage.js"
import * as Executor from "../tools/executor.js"
import * as Registry from "../tools/registry.js"
import { AgentSupervisor, layer as supervisorLayer } from "./agent.js"
import { CrashInjector, type CrashPlan } from "./crash.js"
import { NotFoundError, SubmissionError } from "./errors.js"
import { EventLog, layer as eventLogLayer } from "./events.js"
import { IdGenerator } from "./ids.js"
import { JournalService, db, journalLayer, read } from "./journal-service.js"
import * as LibFxModule from "./libfx.js"
import { RecoveryManager, layer as recoveryLayer, type RecoveryReport } from "./recovery.js"
import { RuntimeRegistry, type RuntimeDefinition } from "./runtime.js"
import {
  SubmissionContent,
  decodeWith,
  type DurableAgentRecord,
  type DurableEvent,
  type SubmissionRecord,
  type SubmissionResult,
  type TaskRecord,
  type TurnRecord
} from "./schema.js"
import type { Storage } from "./storage.js"
import type { Transport } from "./transport.js"

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
}

export interface EventsOptions {
  readonly after?: number
  /** Stop after replaying persisted events instead of following live. */
  readonly follow?: boolean
  readonly pollInterval?: number
}

const TERMINAL_EVENTS = new Set(["submission.completed", "submission.failed", "submission.cancelled"])

type Services = JournalService | EventLog | IdGenerator | RuntimeRegistry | AgentSupervisor | RecoveryManager | CrashInjector

const decodeContent = decodeWith(SubmissionContent, "submission content")

/** Effect-native overrides, available from `fx-durable/effect`. */
export interface DurableFxLayers {
  readonly ids?: Layer.Layer<IdGenerator>
}

const isSqliteConfig = (storage: Sqlite.SqliteStorageConfig | Storage): storage is Sqlite.SqliteStorageConfig =>
  "_tag" in storage && storage._tag === "SqliteStorageConfig"

/** The complete fx-durable service graph as one Effect `Layer`. */
export const buildLayer = (options: DurableFxOptions, layers: DurableFxLayers = {}) => {
  const configured = options.storage
  const openStorage = isSqliteConfig(configured) ? () => Sqlite.openSqliteStorage(configured.options) : () => configured
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
    journalLayer(openStorage).pipe(Layer.provideMerge(ids)),
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
        const journal = yield* JournalService
        const storage = journal.storage
        const registry = yield* RuntimeRegistry
        const supervisor = yield* AgentSupervisor
        yield* registry.resolve(options.runtime)
        yield* db(() =>
          journal.transaction(() => {
            const existing = storage.getAgent(id)
            const at = journal.now()
            if (!existing) {
              storage.insertAgent({
                id,
                runtimeId: options.runtime,
                model: options.model,
                cwd: options.cwd ?? null,
                state: "idle",
                stateReason: null,
                createdAt: at,
                updatedAt: at
              })
              journal.appendEvent({
                agentId: id,
                type: "agent.created",
                payload: { runtime: options.runtime, model: options.model, cwd: options.cwd ?? null }
              })
              return
            }
            const cwd = options.cwd === undefined ? existing.cwd : options.cwd
            if (existing.runtimeId !== options.runtime || existing.model !== options.model || existing.cwd !== cwd) {
              storage.updateAgent(id, { runtimeId: options.runtime, model: options.model, cwd }, at)
              journal.appendEvent({
                agentId: id,
                type: "agent.updated",
                payload: { runtime: options.runtime, model: options.model, cwd }
              })
            }
          })
        )
        yield* supervisor.ensureWorker(id)
      })
    )
    return new DurableAgent(this, id)
  }

  /** Attach to an existing agent without changing it. Clients attach; they do not own execution. */
  async attach(id: string): Promise<DurableAgent> {
    await this.run(
      Effect.gen(function* () {
        const storage = (yield* JournalService).storage
        const agent = yield* db(() => storage.getAgent(id))
        if (!agent) return yield* new NotFoundError({ entity: "agent", id })
      })
    )
    return new DurableAgent(this, id)
  }

  listAgents(): Promise<ReadonlyArray<DurableAgentRecord>> {
    return this.run(Effect.flatMap(JournalService, (journal) => read(() => journal.storage.listAgents())))
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
    const { record, created } = await runOn(
      this.fx,
      Effect.gen(function* () {
        const journal = yield* JournalService
        const storage = journal.storage
        const supervisor = yield* AgentSupervisor
        const crash = yield* CrashInjector
        const decoded = yield* decodeContent(content)
        const insert = () =>
          journal.transaction(() => {
            if (requestId !== null) {
              const existing = storage.findSubmissionByRequest(agentId, requestId)
              if (existing) return { record: existing, created: false }
            }
            const at = journal.now()
            const record: SubmissionRecord = {
              id: journal.nextId("sub"),
              agentId,
              requestId,
              content: decoded,
              state: "queued",
              result: null,
              error: null,
              cancelRequested: false,
              createdAt: at,
              updatedAt: at
            }
            storage.insertSubmission(record)
            journal.appendEvent({
              agentId,
              submissionId: record.id,
              type: "submission.created",
              payload: { requestId, content: decoded }
            })
            return { record, created: true }
          })
        const result = yield* db(insert).pipe(
          // Another process may have won the UNIQUE(agent_id, request_id) race.
          Effect.catchTag("StorageError", (error) =>
            requestId !== null && /UNIQUE/i.test(error.message)
              ? Effect.flatMap(db(() => storage.findSubmissionByRequest(agentId, requestId)), (existing) =>
                  existing ? Effect.succeed({ record: existing, created: false }) : Effect.fail(error)
                )
              : Effect.fail(error)
          )
        )
        yield* crash.hit("submission.after-persist")
        yield* supervisor.ensureWorker(agentId)
        yield* supervisor.wake(agentId)
        return result
      })
    )
    return new Submission(this.fx, record.id, agentId, record.requestId, created)
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
        const storage = (yield* JournalService).storage
        const agent = yield* db(() => storage.getAgent(id))
        if (!agent) return yield* new NotFoundError({ entity: "agent", id })
        return agent
      })
    )
  }

  submissions(limit = 20): Promise<ReadonlyArray<SubmissionRecord>> {
    return runOn(this.fx, Effect.flatMap(JournalService, (journal) => read(() => journal.storage.listSubmissions(this.id, limit))))
  }

  /** Current turn and its task journal, if any. */
  currentTurn(): Promise<{ readonly turn: TurnRecord; readonly tasks: ReadonlyArray<TaskRecord> } | null> {
    const id = this.id
    return runOn(
      this.fx,
      Effect.gen(function* () {
        const storage = (yield* JournalService).storage
        const turn = yield* db(() => storage.activeTurn(id))
        if (!turn) return null
        return { turn, tasks: yield* db(() => storage.tasksForTurn(turn.id)) }
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
        const storage = (yield* JournalService).storage
        const record = yield* db(() => storage.getSubmission(id))
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
        const storage = (yield* JournalService).storage
        const log = yield* EventLog
        const settled = (record: SubmissionRecord | null) =>
          record !== null && (record.state === "completed" || record.state === "failed" || record.state === "cancelled")
        let record = yield* db(() => storage.getSubmission(id))
        if (!record) return yield* new NotFoundError({ entity: "submission", id })
        if (!settled(record)) {
          yield* log.subscribe(agentId).pipe(
            Stream.filter((event) => event.submissionId === id && TERMINAL_EVENTS.has(event.type)),
            Stream.runHead,
            Effect.map(Option.getOrUndefined)
          )
          record = yield* db(() => storage.getSubmission(id))
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
