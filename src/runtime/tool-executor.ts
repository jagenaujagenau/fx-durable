import { Cause, Context, Effect, Exit, Layer } from "effect"
import { CrashInjector } from "./crash.js"
import { PROGRESS_MS } from "./model.js"
import {
  InterruptedError,
  ToolBlockedError,
  ToolExecutionError,
  UnknownOutcomeError,
  type NotFoundError,
  type StorageError
} from "../domain/errors.js"
import { IdGenerator } from "./ids.js"
import { Database } from "./database.js"
import type { TaskRecord, UnknownOutcomeReason } from "../domain/schema.js"
import { effectiveTask, unknownOutcomeNotice } from "../domain/tool-outcomes.js"
import type { Json, JsonObject } from "../domain/json.js"
import { applyUpdate, DocumentUpdateFailed, documentValue, ownValue, type DurableDocument } from "../domain/documents.js"
import { hashInput, type TurnContext } from "./turn-context.js"
import { OutcomeUnknown, type DocumentAccess, type DurableTool } from "../tools/define-tool.js"
import type { ToolCall, ToolHookContext, ToolHooks } from "../tools/hooks.js"
import { idempotencyKeyFor, policyName } from "../tools/replay-policy.js"

/**
 * Write-ahead tool execution:
 *
 *   persist intent (running) → commit → execute effect → persist result → commit
 *
 * If the process dies between the external effect and the result commit,
 * recovery finds a running task and classifies it by its persisted policy.
 */

export type ToolCallError = ToolExecutionError | ToolBlockedError | UnknownOutcomeError | InterruptedError | StorageError | NotFoundError

/** The agent's tools and hooks, which tools reach through `context.executeTool`. */
export interface ToolSet {
  readonly byName: ReadonlyMap<string, DurableTool>
  readonly hooks: ToolHooks | undefined
}

export interface ToolExecutorInterface {
  /** Execute a model-requested tool call within a turn attempt. */
  readonly execute: (ctx: TurnContext, tool: DurableTool, input: Json, tools: ToolSet) => Effect.Effect<Json, ToolCallError>
  /** Recovery: replay an interrupted replay-safe/idempotent task as a child task. */
  readonly replay: (task: TaskRecord, tool: DurableTool, tools: ToolSet, submissionId: string) => Effect.Effect<TaskRecord, StorageError | NotFoundError>
}

/** Where a call runs: its turn, and what nested calls can reach. */
interface CallScope extends ToolSet {
  readonly agentId: string
  readonly submissionId: string
  readonly turnId: string
  readonly attempt: number
  readonly interruptReason: () => UnknownOutcomeReason
}

/** A nested call's origin: the tool task that made it, and its key among that task's calls. */
interface Caller {
  readonly task: TaskRecord
  readonly key: string
}

export class ToolExecutor extends Context.Service<ToolExecutor, ToolExecutorInterface>()("fx-durable/ToolExecutor") {}

/** Tool progress keeps its last 64 KiB (as characters). */
const MAX_PROGRESS_CHARS = 64 * 1024

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export { effectiveTask, unknownOutcomeNotice }

export const layer = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    const database = yield* Database
    const ids = yield* IdGenerator
    const crash = yield* CrashInjector

    /** Run the tool body for a task that is already durably `running`. */
    const runTask = (
      task: TaskRecord,
      tool: DurableTool,
      input: Json,
      scope: CallScope,
      options: {
        readonly replay: boolean
        /** Replace a successful result before it is journaled (the `afterTool` hook). */
        readonly afterTool?: (output: Json) => Promise<Json | undefined>
      }
    ): Effect.Effect<Json, ToolExecutionError | UnknownOutcomeError | StorageError | NotFoundError> =>
      Effect.gen(function* () {
        const startedAt = new Date()
        const controller = new AbortController()
        const settled = { done: false }

        // Nested calls: each runs as its own durable task, owned by this one.
        // Calls still running when this one settles are aborted.
        const nestedAbort = new AbortController()
        const nestedRunning = new Set<Promise<Json>>()
        let nestedOrdinal = 0
        const executeTool = (name: string, nestedInput: Json, callOptions: { readonly key?: string } = {}): Promise<Json> => {
          if (settled.done) return Promise.reject(new Error(`${tool.name} has returned; it can no longer call ${name}`))
          const caller: Caller = { task, key: callOptions.key ?? String(nestedOrdinal++) }
          const signal = AbortSignal.any([controller.signal, nestedAbort.signal])
          const promise = Effect.runPromiseExit(callNested(caller, name, nestedInput, scope), { signal }).then((exit) => {
            if (Exit.isSuccess(exit)) return exit.value
            const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
            if (failure && failure._tag === "Fail") throw failure.error
            if (Cause.hasInterruptsOnly(exit.cause)) throw new Error(`nested call ${name} was cancelled`)
            throw Cause.squash(exit.cause)
          })
          nestedRunning.add(promise)
          promise.finally(() => nestedRunning.delete(promise)).catch(() => undefined)
          return promise
        }
        const settleNested = Effect.promise(() => {
          nestedAbort.abort()
          return Promise.allSettled(nestedRunning)
        })

        // Document writes, staged in call order and committed with the result.
        type Step = (value: JsonObject) => JsonObject
        const staged = new Map<string, { readonly document: DurableDocument<JsonObject>; readonly steps: Array<Step> }>()
        const ownerOf = (document: DurableDocument<JsonObject>) => (document.scope === "agent" ? task.agentId : null)
        const readDocument = async <T extends JsonObject>(document: DurableDocument<T>): Promise<T> => {
          const record = await Effect.runPromise(database.read((storage) => storage.getDocument(ownerOf(document), document.kind)))
          const steps = staged.get(`${document.scope}:${document.kind}`)?.steps ?? []
          return ownValue(document, steps.reduce<JsonObject>((value, step) => step(value), documentValue(document, record)))
        }
        const documents: DocumentAccess = {
          get: (document) => readDocument(document),
          update: async (document, update) => {
            if (settled.done) throw new Error(`${tool.name} has returned; it can no longer update ${document.kind}`)
            // Fail here, in the tool, rather than at commit.
            const value = applyUpdate(document, await readDocument(document), update)
            const key = `${document.scope}:${document.kind}`
            const entry = staged.get(key) ?? { document, steps: [] }
            entry.steps.push((current) => applyUpdate(document, ownValue(document, current), update))
            staged.set(key, entry)
            return value
          }
        }

        // Tool output reported while it runs, journaled at most every PROGRESS_MS.
        let progress = ""
        let pending: ReturnType<typeof setTimeout> | null = null
        const flushProgress = () => {
          pending = null
          Effect.runFork(database.run((journal) => journal.recordProgress(task.id, progress)).pipe(Effect.ignore))
        }
        const reportProgress = (chunk: string) => {
          if (settled.done || chunk.length === 0) return
          progress = (progress + chunk).slice(-MAX_PROGRESS_CHARS)
          pending ??= setTimeout(flushProgress, PROGRESS_MS)
        }

        const body = Effect.gen(function* () {
          const agent = yield* database.read((storage) => storage.getAgent(task.agentId))
          // Start the external effect, then hit the "during" crash point while it is in flight.
          const promise = yield* Effect.sync(() =>
            tool.run(input, {
              agentId: task.agentId,
              turnId: task.turnId,
              taskId: task.id,
              cwd: agent?.cwd ?? null,
              idempotencyKey: task.idempotencyKey,
              signal: controller.signal,
              replay: options.replay,
              progress: reportProgress,
              executeTool,
              documents
            })
          )
          promise.catch(() => undefined)
          yield* crash.hit("tool.during-execute", { name: tool.name })
          return yield* Effect.tryPromise({ try: () => promise, catch: (cause) => cause }).pipe(Effect.exit)
        })

        const exit = yield* body.pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (settled.done) return
              controller.abort(scope.interruptReason())
              yield* settleNested
              const current = yield* database.read((storage) => storage.getTask(task.id))
              if (!current || current.state !== "running") return
              // Local cancellation does not prove an external unsafe effect was cancelled.
              if (task.replayPolicy === "safe") {
                yield* database.run((journal) => journal.transitionTask(task.id, "cancelled", { error: "cancelled" }, { type: "tool.cancelled", payload: { tool: tool.name } }))
              } else if (task.replayPolicy === "idempotent") {
                // As after a crash: a retry with the same key resumes the work (or the call is abandoned).
                const reason = scope.interruptReason()
                yield* database.run((journal) => journal.transitionTask(task.id, "interrupted", { error: reason }, {
                  type: "tool.interrupted",
                  payload: { tool: tool.name, input, replay: task.replayPolicy, action: "retry_with_same_key", reason }
                }))
              } else {
                const reason = scope.interruptReason()
                yield* database.run((journal) => journal.transitionTask(
                  task.id,
                  "outcome_unknown",
                  { error: `interrupted: ${reason}` },
                  {
                    type: "tool.outcome_unknown",
                    payload: { tool: tool.name, input, startedAt: startedAt.toISOString(), reason }
                  }
                ))
              }
            }).pipe(Effect.orDie)
          )
        )
        settled.done = true
        if (pending) clearTimeout(pending)
        yield* settleNested

        if (Exit.isSuccess(exit)) {
          yield* crash.hit("tool.after-execute", { name: tool.name })
          const afterTool = options.afterTool
          // A failing afterTool keeps the original result: the effect already happened.
          const replaced = afterTool
            ? yield* Effect.promise(() => afterTool(exit.value).catch(() => undefined))
            : undefined
          const output = replaced ?? exit.value
          const durationMs = Date.now() - startedAt.getTime()
          // The result and the call's document writes commit together. Updates run again here, on the current values.
          const rejected = yield* database.run((journal) => {
            try {
              journal.transaction(() => {
                const origin = { agentId: task.agentId, turnId: task.turnId, taskId: task.id }
                for (const { document, steps } of staged.values()) {
                  journal.updateDocument(document, ownerOf(document), [(draft) => steps.reduce<JsonObject>((value, step) => step(value), draft)], origin)
                }
                journal.transitionTask(
                  task.id,
                  "completed",
                  { output, metadata: { durationMs, replay: options.replay } },
                  { type: "tool.completed", payload: { tool: tool.name, input, durationMs, replay: options.replay } }
                )
              })
              return null
            } catch (cause: unknown) {
              if (cause instanceof DocumentUpdateFailed) return cause.message
              throw cause
            }
          })
          if (rejected !== null) return yield* failTask(task, tool, rejected)
          yield* crash.hit("tool.after-result-persist", { name: tool.name })
          return output
        }

        const cause = exit.cause
        const failure = cause.reasons.find((r) => r._tag === "Fail")
        const error = failure && failure._tag === "Fail" ? failure.error : cause
        if (error instanceof OutcomeUnknown) {
          yield* database.run((journal) => journal.transitionTask(
            task.id,
            "outcome_unknown",
            { error: error.message },
            {
              type: "tool.outcome_unknown",
              payload: { tool: tool.name, input, startedAt: startedAt.toISOString(), reason: error.reason }
            }
          ))
          return yield* new UnknownOutcomeError({
            taskId: task.id,
            tool: tool.name,
            message: unknownOutcomeNotice(tool.name, input)
          })
        }
        return yield* failTask(task, tool, errorMessage(error))
      })

    const failTask = (task: TaskRecord, tool: DurableTool, message: string) =>
      Effect.gen(function* () {
        yield* database.run((journal) => journal.transitionTask(
          task.id,
          "failed",
          { error: message },
          { type: "tool.failed", payload: { tool: tool.name, error: message } }
        ))
        return yield* new ToolExecutionError({ taskId: task.id, tool: tool.name, message })
      })

    /** Journal the intent of a new call (after `beforeTool` allows it), then run it. */
    const runFresh = (
      scope: CallScope,
      tool: DurableTool,
      requested: Json,
      inputHash: string,
      parentTaskId: string | null,
      caller: Caller | null,
      /** Retrying an interrupted idempotent call: keep its idempotency key. */
      retryKey: string | null = null
    ) =>
      Effect.gen(function* () {
        const submission = yield* database.read((storage) => storage.getSubmission(scope.submissionId))
        if (submission?.cancelRequested) {
          return yield* new InterruptedError({ message: "submission cancellation requested" })
        }
        const hookContext = (signal: AbortSignal): ToolHookContext => ({
          agentId: scope.agentId,
          submissionId: scope.submissionId,
          turnId: scope.turnId,
          signal
        })
        const call = (input: Json): ToolCall => ({
          name: tool.name,
          input,
          caller: caller ? { taskId: caller.task.id, tool: caller.task.name ?? "" } : null
        })
        // beforeTool runs before the intent is journaled: until it allows the
        // call, nothing has started, and a crash here leaves nothing to recover.
        let input = requested
        const beforeTool = scope.hooks?.beforeTool
        if (beforeTool) {
          const decision = yield* Effect.tryPromise({
            try: async (signal) => beforeTool(call(requested), hookContext(signal)),
            catch: (cause) => new ToolBlockedError({ tool: tool.name, message: `beforeTool failed: ${errorMessage(cause)}` })
          })
          if (decision && "block" in decision) {
            yield* database.run((journal) => journal.appendEvent({
              agentId: scope.agentId,
              submissionId: scope.submissionId,
              turnId: scope.turnId,
              type: "tool.blocked",
              payload: { tool: tool.name, input: requested, reason: decision.block, callerTaskId: caller?.task.id ?? null }
            }))
            return yield* new ToolBlockedError({ tool: tool.name, message: decision.block })
          }
          if (decision) input = decision.input
        }
        yield* crash.hit("tool.before-persist", { name: tool.name })
        const id = ids.next("task")
        const policy = policyName(tool.replay)
        const task = yield* database.run((journal) => journal.startTask({
          id,
          turnId: scope.turnId,
          agentId: scope.agentId,
          type: "tool",
          name: tool.name,
          input,
          inputHash,
          parentTaskId,
          callerTaskId: caller?.task.id ?? null,
          callKey: caller?.key ?? null,
          replayPolicy: policy,
          idempotencyKey: retryKey ?? idempotencyKeyFor(tool.replay, id, input),
          attempt: scope.attempt,
          event: { type: "tool.started", payload: { tool: tool.name, input, replay: policy, callerTaskId: caller?.task.id ?? null } }
        }))
        yield* crash.hit("tool.after-persist", { name: tool.name })
        const afterTool = scope.hooks?.afterTool
        return yield* runTask(task, tool, input, scope, {
          replay: false,
          afterTool: afterTool
            ? async (output) => afterTool(call(input), output, hookContext(new AbortController().signal))
            : undefined
        })
      })

    /**
     * Continue a call journaled by an earlier attempt (`slot`), or run it fresh:
     * completed work is answered from the journal, an unknown outcome is refused
     * once, and interrupted or cancelled calls run again.
     */
    const resumeOrRun = (scope: CallScope, tool: DurableTool, input: Json, inputHash: string, slot: TaskRecord | undefined, tasks: ReadonlyArray<TaskRecord>, caller: Caller | null) =>
      Effect.gen(function* () {
        if (!slot) return yield* runFresh(scope, tool, input, inputHash, null, caller)
        const effective = effectiveTask(slot, tasks)
        // Observation tools re-read current state rather than return what they saw before the crash.
        if (!tool.reuse && (effective.state === "completed" || effective.state === "failed")) {
          return yield* runFresh(scope, tool, input, inputHash, caller ? effective.id : null, caller)
        }
        switch (effective.state) {
          case "completed": {
            yield* database.run((journal) => journal.appendEvent({
              agentId: scope.agentId,
              submissionId: scope.submissionId,
              turnId: scope.turnId,
              taskId: effective.id,
              type: "tool.reused",
              payload: { tool: tool.name, input, state: "completed" }
            }))
            return effective.output
          }
          case "failed": {
            yield* database.run((journal) => journal.appendEvent({
              agentId: scope.agentId,
              submissionId: scope.submissionId,
              turnId: scope.turnId,
              taskId: effective.id,
              type: "tool.reused",
              payload: { tool: tool.name, input, state: "failed" }
            }))
            return yield* new ToolExecutionError({
              taskId: effective.id,
              tool: tool.name,
              message: effective.error ?? "tool failed"
            })
          }
          case "outcome_unknown": {
            if (!effective.acknowledged) {
              // Unsafe effects are never blindly replayed. Refuse once, explicitly;
              // a deliberate second call after inspection executes normally.
              yield* database.run((journal) => journal.refuseUnknownOutcomeRepeat(effective, scope.submissionId, input))
              return yield* new UnknownOutcomeError({
                taskId: effective.id,
                tool: tool.name,
                message: `${unknownOutcomeNotice(tool.name, input)}\nThis call was NOT executed. If, after inspecting state, you still need it, call the tool again.`
              })
            }
            return yield* runFresh(scope, tool, input, inputHash, effective.id, caller)
          }
          case "cancelled":
            return yield* runFresh(scope, tool, input, inputHash, effective.id, caller)
          case "interrupted":
            // Not replayed during recovery (resumeOnCall, a missing tool, or a nested call):
            // an idempotent call retries with its original key, so it resumes the same work.
            return yield* runFresh(scope, tool, input, inputHash, effective.id, caller, effective.idempotencyKey)
          case "pending":
          case "running":
            // Recovery classifies every unfinished task before a new attempt starts.
            return yield* new UnknownOutcomeError({
              taskId: effective.id,
              tool: tool.name,
              message: unknownOutcomeNotice(tool.name, input)
            })
        }
      })

    /**
     * A tool calling another tool. The nested call is a task of its own, owned
     * by the caller: hooks, replay policy, and journaling apply as to the
     * model's calls. A caller that runs again (a replay after a crash) gets the
     * nested calls it already made back, matched by key, tool, and input.
     */
    const callNested = (caller: Caller, name: string, input: Json, scope: CallScope): Effect.Effect<Json, ToolCallError> =>
      Effect.gen(function* () {
        const tool = scope.byName.get(name)
        if (!tool || tool.callers === "model") {
          return yield* new ToolExecutionError({ taskId: caller.task.id, tool: name, message: `no tool named ${name} can be called from a tool` })
        }
        const inputHash = hashInput(tool.name, input)
        const tasks = yield* database.read((storage) => storage.tasksForTurn(caller.task.turnId))
        // The caller and the calls it replays or retries.
        const incarnations = new Set<string>()
        for (let at: TaskRecord | undefined = caller.task; at; at = tasks.find((t) => t.id === at?.parentTaskId)) incarnations.add(at.id)
        const slot = tasks
          .filter(
            (t) =>
              t.type === "tool" &&
              t.parentTaskId === null &&
              t.callerTaskId !== null &&
              incarnations.has(t.callerTaskId) &&
              t.id !== caller.task.id &&
              t.callKey === caller.key &&
              t.name === tool.name &&
              t.inputHash === inputHash
          )
          .at(-1)
        return yield* resumeOrRun(scope, tool, input, inputHash, slot, tasks, caller)
      })

    const scopeOf = (ctx: TurnContext, tools: ToolSet): CallScope => ({
      ...tools,
      agentId: ctx.agentId,
      submissionId: ctx.submissionId,
      turnId: ctx.turnId,
      attempt: ctx.attempt,
      interruptReason: () => ctx.interruptReason ?? "executor_lost"
    })

    const execute = Effect.fn("ToolExecutor.execute")(function* (ctx: TurnContext, tool: DurableTool, input: Json, tools: ToolSet) {
      const inputHash = hashInput(tool.name, input)
      const key = `${tool.name}:${inputHash}`
      const ordinal = ctx.ordinals.get(key) ?? 0
      ctx.ordinals.set(key, ordinal + 1)

      // Map this call onto work journaled by earlier attempts of the same turn.
      const tasks = yield* database.read((storage) => storage.tasksForTurn(ctx.turnId))
      const slots = tasks.filter(
        (t) =>
          t.type === "tool" &&
          t.parentTaskId === null &&
          t.callerTaskId === null &&
          t.name === tool.name &&
          t.inputHash === inputHash &&
          t.attempt < ctx.attempt
      )
      return yield* resumeOrRun(scopeOf(ctx, tools), tool, input, inputHash, slots[ordinal], tasks, null)
    })

    const replay = Effect.fn("ToolExecutor.replay")(function* (original: TaskRecord, tool: DurableTool, tools: ToolSet, submissionId: string) {
      const task = yield* database.run((journal) => journal.startTask({
        turnId: original.turnId,
        agentId: original.agentId,
        type: "tool",
        name: original.name,
        input: original.input,
        inputHash: original.inputHash,
        parentTaskId: original.id,
        callerTaskId: original.callerTaskId,
        callKey: original.callKey,
        replayPolicy: original.replayPolicy,
        // Idempotent tools retry with the SAME key.
        idempotencyKey: original.idempotencyKey,
        attempt: original.attempt,
        event: {
          type: "tool.replayed",
          payload: { tool: original.name, input: original.input, replayOf: original.id, replay: original.replayPolicy }
        }
      }))
      yield* crash.hit("recovery.during-replay", { name: tool.name })
      const input = original.input
      const scope: CallScope = {
        ...tools,
        agentId: original.agentId,
        submissionId,
        turnId: original.turnId,
        attempt: original.attempt,
        interruptReason: () => "executor_lost"
      }
      yield* runTask(task, tool, input, scope, { replay: true }).pipe(
        Effect.catchTags({ ToolExecutionError: () => Effect.void, UnknownOutcomeError: () => Effect.void })
      )
      const updated = yield* database.read((storage) => storage.getTask(task.id))
      return updated ?? task
    })

    return ToolExecutor.of({ execute, replay })
  })
)
