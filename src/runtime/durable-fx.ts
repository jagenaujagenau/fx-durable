import { dirname, join, basename } from "node:path"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Queue, Stream } from "effect"
import { memory, type Durability, type FxFetch, type FxModelCatalogEntry, type FxStreamLine } from "libfx"
import { local } from "libfx/durable-local"
import { bindTools } from "../tools/subagent.js"
import { ExtensionSelection, type Extension } from "../tools/extension.js"
import * as Executor from "./tool-executor.js"
import * as Registry from "./tool-registry.js"
import * as SessionsModule from "./sessions.js"
import type { DurabilityFor } from "./sessions.js"
import * as AgentsModule from "./agents.js"
import { Agents } from "./agents.js"
import { ToolRegistry } from "./tool-registry.js"
import { CrashInjector, type CrashPlan } from "./crash.js"
import { AgentExistsError, DurableFxFailedError, NotFoundError, SubmissionError, type StorageError } from "../domain/errors.js"
import { IdGenerator } from "./ids.js"
import { Database, databaseLayer } from "./database.js"
import type { Clock } from "../durable/clock.js"
import { RuntimeRegistry, type RuntimeDefinition } from "./runtime-registry.js"
import { SubmissionContent, decodeWith, type DurableAgentRecord, type SubmissionRecord, type SubmissionResult, type ToolCallRecord } from "../domain/schema.js"
import type { SqliteStorageConfig } from "../durable/sqlite/storage.js"
import type { Storage, StorageReader } from "../durable/storage.js"
import { usageOf, type ModelPrices, type UsageReport } from "../domain/usage.js"
import { buildTaskGraph, type TaskGraph } from "../domain/task-graph.js"
import { DocumentUpdateFailed, documentValue, type AgentDocument, type DocumentUpdate, type DurableDocument, type GlobalDocument } from "../domain/documents.js"
import { isJsonString, type JsonObject } from "../domain/json.js"

/**
 * Promise/AsyncIterable façade over the Effect-native runtime, so adopting
 * fx-durable does not require application code to use Effect.
 */

export interface DurableFxOptions {
  /**
   * fx-durable's own records: `sqlite(path)`, or any object implementing the
   * synchronous `Storage` interface. fx-durable closes it when it closes.
   */
  readonly storage: SqliteStorageConfig | Storage
  /**
   * Where libfx keeps the conversations. libfx agents that share a store
   * share its work, so fx-durable keeps one store per tool set: pass a
   * function from a store's name to its durability. Defaults to files next to
   * the SQLite database (`local({ dir: "<db>.sessions/<store>" })`), or
   * `memory()` for storage passed as an object. A single durability (such as
   * `vercel()`) can hold the sessions of one tool set.
   */
  readonly durability?: Durability | DurabilityFor
  readonly runtimes?: Readonly<Record<string, RuntimeDefinition>>
  /** AI Gateway key. Defaults to `AI_GATEWAY_API_KEY`. */
  readonly apiKey?: string
  /** Model transport override (e.g. a scripted model for tests and offline demos). */
  readonly fetch?: FxFetch
  /** The Gateway model catalog, so libfx makes no catalog request. */
  readonly modelCatalog?: ReadonlyArray<FxModelCatalogEntry>
  readonly backend?: "auto" | "native" | "wasm"
  /** `auto` (default) continues unfinished requests during `open()`; `manual` waits for `resume()`. */
  readonly recovery?: "auto" | "manual"
  /** Crash injection. Defaults to reading `FXD_CRASH_AT` from the environment (no-op when unset). */
  readonly crash?: (CrashPlan & { readonly onCrash?: (point: string) => void }) | "env" | "off"
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

export interface ResetOptions {
  /** A handoff: what the model should know in the new context. */
  readonly summary?: string
}

export interface ForkOptions {
  readonly runtime?: string
  readonly model?: string
  readonly cwd?: string | null
}

export interface EventsOptions {
  /** Deliver events after this cursor (each line's `cursor`). Default 0: everything. */
  readonly after?: number
  /**
   * Stop at the end of the agent's latest finished request instead of
   * following live (a turn still running is left out). Default true.
   */
  readonly follow?: boolean
}

export interface UsageOptions {
  /** USD per million tokens by model id. Without a model's price, its `costUsd` (and the total's) is `null`. */
  readonly prices?: ModelPrices
}

type Services = Database | IdGenerator | RuntimeRegistry | ToolRegistry | Agents | CrashInjector

const decodeContent = decodeWith(SubmissionContent, "submission content")

/** Effect-native overrides, available from `fx-durable/effect`. */
export interface DurableFxLayers {
  readonly ids?: Layer.Layer<IdGenerator>
  /** The journal's clock (defaults to the system clock). */
  readonly clock?: Clock
}

const isSqliteConfig = (storage: SqliteStorageConfig | Storage): storage is SqliteStorageConfig =>
  "_tag" in storage && storage._tag === "SqliteStorageConfig"

/** Where libfx keeps sessions unless told: beside the SQLite file (a directory per store), or in memory. */
const defaultDurability = (storage: SqliteStorageConfig | Storage): DurabilityFor => {
  if (!isSqliteConfig(storage) || storage.options.path === ":memory:") {
    const stores = new Map<string, Durability>()
    return (store) => {
      const existing = stores.get(store)
      if (existing) return existing
      const created = memory()
      stores.set(store, created)
      return created
    }
  }
  const path = storage.options.path
  return (store) => local({ dir: join(dirname(path), `${basename(path)}.sessions`, store) })
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
            onCrash:
              options.crash.onCrash ??
              ((point) => {
                throw new Error(`crash injected at ${point}`)
              })
          })
  const base = Layer.mergeAll(
    databaseLayer(options.storage, layers.clock),
    crash,
    layers.ids ?? IdGenerator.layer,
    RuntimeRegistry.layer(options.runtimes ?? {})
  )
  const tools = Registry.layer.pipe(Layer.provideMerge(base))
  const executor = Executor.layer.pipe(Layer.provideMerge(tools))
  const sessions = SessionsModule.layer({
    durability: options.durability ?? defaultDurability(options.storage),
    apiKey: options.apiKey,
    fetch: options.fetch,
    modelCatalog: options.modelCatalog,
    backend: options.backend
  }).pipe(Layer.provideMerge(executor))
  return AgentsModule.layer.pipe(Layer.provideMerge(sessions))
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

const read = <A>(fx: DurableFx, f: (storage: StorageReader) => A) => runOn(fx, Effect.flatMap(Database, (database) => database.read(f)))

const readDocument = async <T extends JsonObject>(fx: DurableFx, document: DurableDocument<T>, agentId: string | null): Promise<T> =>
  documentValue(document, await read(fx, (storage) => storage.getDocument(agentId, document.kind)))

const writeDocument = async <T extends JsonObject>(fx: DurableFx, document: DurableDocument<T>, agentId: string | null, update: DocumentUpdate<T>): Promise<T> => {
  const outcome = await runOn(
    fx,
    Effect.flatMap(Database, (database) =>
      database.run((journal) => {
        try {
          return { _tag: "written" as const, record: journal.updateDocument(document, agentId, [update]) }
        } catch (cause: unknown) {
          if (cause instanceof DocumentUpdateFailed) return { _tag: "failed" as const, cause: cause.cause }
          throw cause
        }
      })
    )
  )
  // The update's own error, as if it had been called directly.
  if (outcome._tag === "failed") throw outcome.cause
  return documentValue(document, outcome.record)
}

/** A runtime's own tools and those of the extensions it lists. */
const runtimeTools = (definition: RuntimeDefinition) => [...(definition.tools ?? []), ...(definition.extensions ?? []).flatMap((extension) => extension.tools)]

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

  // Before recovery: a continued turn may call a subagent tool.
  for (const definition of Object.values(options.runtimes ?? {})) bindTools(fx, runtimeTools(definition))
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

  /** Open fx-durable. With `recovery: "auto"` (default), unfinished requests continue now. */
  static open(options: DurableFxOptions): Promise<DurableFx> {
    return openDurableFx(options)
  }

  private run<A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> {
    return runOn(this, effect)
  }

  registerRuntime(id: string, definition: RuntimeDefinition): Promise<void> {
    bindTools(this, runtimeTools(definition))
    return this.run(Effect.flatMap(RuntimeRegistry, (registry) => registry.register(id, definition)))
  }

  /**
   * Continue every unfinished request: each is prompted again under its
   * `messageId`, and libfx continues its turn from its last step (or reports
   * how it ended). Requests whose runtime is not registered wait for the next
   * call. Resolves with the ids of the requests it continued.
   */
  resume(): Promise<ReadonlyArray<string>> {
    return this.run(Effect.flatMap(Agents, (agents) => agents.resume()))
  }

  /**
   * Get or create a stable logical agent. `agent("engineer")` refers to the
   * same durable agent across application restarts.
   */
  async agent(id: string, options: AgentOptions): Promise<DurableAgent> {
    await this.run(Effect.flatMap(Database, (database) => database.run((journal) => journal.upsertAgent(id, options))))
    return new DurableAgent(this, id)
  }

  /** Attach to an existing agent without changing it. */
  async attach(id: string): Promise<DurableAgent> {
    const agent = await read(this, (storage) => storage.getAgent(id))
    if (!agent) throw new NotFoundError({ entity: "agent", id })
    return new DurableAgent(this, id)
  }

  listAgents(): Promise<ReadonlyArray<DurableAgentRecord>> {
    return read(this, (storage) => storage.listAgents())
  }

  /** Token and cost totals across every agent, from its finished requests. */
  async usage(options: UsageOptions = {}): Promise<UsageReport> {
    return usageOf(await read(this, (storage) => storage.finishedSubmissions(null)), options.prices)
  }

  /** Running tool calls across agents, with what each runs for. */
  async taskGraph(): Promise<TaskGraph> {
    return read(this, (storage) => buildTaskGraph(storage.runningToolCalls(), storage.runningSubmissions()))
  }

  /**
   * Install an extension, replacing the installed one with the same name (a
   * reload). Agents that select it get it from their next request; a call
   * already running finishes with the code it started with.
   */
  installExtension(extension: Extension): Promise<void> {
    bindTools(this, extension.tools)
    return this.run(Effect.flatMap(RuntimeRegistry, (registry) => registry.install(extension)))
  }

  /** Remove the installed extension with this name. Runtimes that list an extension by that name fall back to theirs. */
  uninstallExtension(name: string): Promise<void> {
    return this.run(Effect.flatMap(RuntimeRegistry, (registry) => registry.uninstall(name)))
  }

  /** A global document's value (`defineDocument({ scope: "global" })`); its initial value if never written. */
  document<T extends JsonObject>(document: GlobalDocument<T>): Promise<T> {
    return readDocument(this, document, null)
  }

  /**
   * Change a global document in one transaction: edit the draft, or return a
   * new value. Resolves with the stored value; rejects with the update's
   * error, writing nothing.
   */
  updateDocument<T extends JsonObject>(document: GlobalDocument<T>, update: DocumentUpdate<T>): Promise<T> {
    return writeDocument(this, document, null, update)
  }

  /** Stop: wait for the turns this process runs, then close storage. Unfinished requests continue on the next open. */
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

  /**
   * Durably accept a request. It is recorded, then stored by libfx, before
   * this resolves; it runs after the agent's earlier requests.
   */
  async submit(content: SubmissionContent, options: SubmitOptions = {}): Promise<Submission> {
    const agentId = this.id
    const { record, created } = await runOn(
      this.fx,
      Effect.gen(function* () {
        const decoded = yield* decodeContent(content)
        return yield* Effect.flatMap(Agents, (agents) => agents.submit(agentId, decoded, options.requestId ?? null))
      })
    )
    return new Submission(this.fx, record.id, agentId, record.requestId, created)
  }

  /**
   * Add guidance to the running turn, like typing while a coding agent
   * works. It reaches the model at its next request; with no turn running,
   * it goes to the next one.
   */
  async steer(text: string): Promise<void> {
    if (text.trim().length === 0) throw new TypeError("steering text cannot be empty")
    const agentId = this.id
    await runOn(this.fx, Effect.flatMap(Agents, (agents) => agents.steer(agentId, text)))
  }

  /** Cancel the turn running now. */
  cancel(): Promise<void> {
    const agentId = this.id
    return runOn(this.fx, Effect.flatMap(Agents, (agents) => agents.cancel(agentId, null)))
  }

  /**
   * The agent's current conversation as libfx stream lines: what it has
   * produced from `after` on, then live events. Each line has a `cursor` to
   * reconnect from.
   */
  events(options: EventsOptions = {}): AsyncIterable<FxStreamLine> {
    const agentId = this.id
    return runnerOf(this.fx).stream(Stream.unwrap(Effect.map(Agents, (agents) => agents.events(agentId, options.after ?? 0, options.follow ?? true))))
  }

  /**
   * Start a new context: from the next request on, the model no longer sees
   * this conversation (it stays in its old session). With `summary`, a
   * handoff, the model sees that text in its instructions instead.
   */
  async reset(options: ResetOptions = {}): Promise<void> {
    const agentId = this.id
    await runOn(this.fx, Effect.flatMap(Database, (database) => database.run((journal) => journal.resetContext(agentId, options.summary ?? null))))
  }

  /**
   * A new agent that continues from this one's conversation as it is now,
   * with its runtime, model, and working directory unless overridden. Its
   * documents start as their fork policies say. This agent is not touched.
   * Rejects with `AgentExistsError` if `id` is taken.
   */
  async fork(id: string, options: ForkOptions = {}): Promise<DurableAgent> {
    const sourceId = this.id
    const created = await runOn(
      this.fx,
      Effect.gen(function* () {
        const checkpoint = yield* Effect.flatMap(Agents, (agents) => agents.checkpoint(sourceId))
        const database = yield* Database
        return yield* database.run((journal) => journal.forkAgent(sourceId, id, checkpoint.byteLength > 0 ? checkpoint : null, options))
      })
    )
    if (!created) throw new AgentExistsError({ agentId: id, message: `agent ${id} already exists` })
    return new DurableAgent(this.fx, id)
  }

  async info(): Promise<DurableAgentRecord> {
    const agent = await read(this.fx, (storage) => storage.getAgent(this.id))
    if (!agent) throw new NotFoundError({ entity: "agent", id: this.id })
    return agent
  }

  /** The agent's latest requests, newest first. */
  submissions(limit = 20): Promise<ReadonlyArray<SubmissionRecord>> {
    return read(this.fx, (storage) => storage.listSubmissions(this.id, limit))
  }

  /** This agent's token and cost totals, from its finished requests. */
  async usage(options: UsageOptions = {}): Promise<UsageReport> {
    return usageOf(await read(this.fx, (storage) => storage.finishedSubmissions(this.id)), options.prices)
  }

  /** The journaled tool calls under one model call: the call itself first, then its nested calls. */
  toolCalls(sessionId: string, executionId: string): Promise<ReadonlyArray<ToolCallRecord>> {
    return read(this.fx, (storage) => storage.toolCallsOf(sessionId, executionId).filter((call) => call.agentId === this.id))
  }

  /**
   * Choose this agent's extensions, in order (by object or name), or `null`
   * for its runtime's default. Stored with the agent, and copied to its
   * forks; applies from its next request. A selected extension that is not
   * installed is skipped until it is.
   */
  async setExtensions(extensions: ReadonlyArray<Extension | string> | null): Promise<void> {
    const names = extensions === null ? null : extensions.map((extension) => (isJsonString(extension) ? extension : extension.name))
    await this.updateDocument(ExtensionSelection, () => ({ names }))
  }

  /** The extensions this agent's next request runs with, in order. */
  extensions(): Promise<ReadonlyArray<string>> {
    const agentId = this.id
    return runOn(
      this.fx,
      Effect.gen(function* () {
        const database = yield* Database
        const agent = yield* database.read((storage) => storage.getAgent(agentId))
        if (!agent) return yield* new NotFoundError({ entity: "agent", id: agentId })
        const toolSet = yield* Effect.flatMap(ToolRegistry, (tools) => tools.toolSet(agent))
        return toolSet.extensions.map((extension) => extension.name)
      })
    )
  }

  /** This agent's value of a document; its initial value if never written. */
  document<T extends JsonObject>(document: AgentDocument<T>): Promise<T> {
    return readDocument(this.fx, document, this.id)
  }

  /**
   * Change this agent's document in one transaction: edit the draft, or
   * return a new value. Resolves with the stored value; rejects with the
   * update's error, writing nothing.
   */
  updateDocument<T extends JsonObject>(document: AgentDocument<T>, update: DocumentUpdate<T>): Promise<T> {
    return writeDocument(this.fx, document, this.id, update)
  }

  /**
   * The document's value now, then each new value written in this process
   * (by this agent's tools, or `updateDocument`). Values written in quick
   * succession may arrive as just the latest. Stop by breaking out of the loop.
   */
  watchDocument<T extends JsonObject>(document: AgentDocument<T>): AsyncIterable<T> {
    const agentId = this.id
    return runnerOf(this.fx).stream(
      Stream.unwrap(
        Effect.gen(function* () {
          const database = yield* Database
          const current = database.read((storage) => storage.getDocument(agentId, document.kind))
          const changes = Stream.callback<void>((queue) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                database.onCommitted((change) => {
                  if (change.type === "document.updated" && change.agentId === agentId && change.kind === document.kind) Queue.offerUnsafe(queue, undefined)
                })
              ),
              (unsubscribe) => Effect.sync(unsubscribe)
            )
          )
          return Stream.concat(Stream.make(undefined), changes).pipe(
            Stream.mapEffect(() => current),
            Stream.changesWith((a, b) => (a?.revision ?? 0) === (b?.revision ?? 0)),
            Stream.map((record) => documentValue(document, record))
          )
        })
      )
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

  async status(): Promise<SubmissionRecord> {
    const record = await read(this.fx, (storage) => storage.getSubmission(this.agentId, this.id))
    if (!record) throw new NotFoundError({ entity: "submission", id: this.id })
    return record
  }

  /** The turn's events as this process follows it, from the start of the turn. Empty when another process runs it. */
  events(): AsyncIterable<FxStreamLine> {
    const { agentId, id } = this
    return runnerOf(this.fx).stream(Stream.unwrap(Effect.map(Agents, (agents) => agents.turnEvents(agentId, id))))
  }

  /** Resolve with the result once completed; reject with `SubmissionError` if it failed or was cancelled. */
  async result(): Promise<SubmissionResult> {
    const { agentId, id } = this
    const record = await runOn(this.fx, Effect.flatMap(Agents, (agents) => agents.settled(agentId, id)))
    if (record.state === "completed" && record.result) return record.result
    throw new SubmissionError({ submissionId: id, state: record.state, message: record.error ?? record.state })
  }

  /**
   * Cancel this request's turn. Local cancellation does not prove that an
   * external unsafe effect was cancelled: such calls are recorded as
   * outcome_unknown.
   */
  cancel(): Promise<void> {
    const { agentId, id } = this
    return runOn(this.fx, Effect.flatMap(Agents, (agents) => agents.cancel(agentId, id)))
  }
}
