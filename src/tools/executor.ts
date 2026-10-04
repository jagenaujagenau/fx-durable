import { Context, Effect, Exit, Layer } from "effect"
import { CrashInjector } from "../core/crash.js"
import {
  InterruptedError,
  ToolExecutionError,
  UnknownOutcomeError,
  type NotFoundError,
  type StorageError
} from "../core/errors.js"
import { IdGenerator } from "../core/ids.js"
import { JournalService, db } from "../core/journal-service.js"
import type { TaskRecord, UnknownOutcomeReason } from "../core/schema.js"
import { effectiveTask, unknownOutcomeNotice } from "../core/tool-outcomes.js"
import type { Json } from "../core/json.js"
import { hashInput, type TurnContext } from "../core/turn-context.js"
import { OutcomeUnknown, type DurableTool } from "./define-tool.js"
import { idempotencyKeyFor, policyName } from "./replay-policy.js"

/**
 * Write-ahead tool execution:
 *
 *   persist intent (running) → commit → execute effect → persist result → commit
 *
 * If the process dies between the external effect and the result commit,
 * recovery finds a running task and classifies it by its persisted policy.
 */

export type ToolCallError = ToolExecutionError | UnknownOutcomeError | InterruptedError | StorageError | NotFoundError

export interface ToolExecutorInterface {
  /** Execute a model-requested tool call within a turn attempt. */
  readonly execute: (ctx: TurnContext, tool: DurableTool, input: Json) => Effect.Effect<Json, ToolCallError>
  /** Recovery: replay an interrupted replay-safe/idempotent task as a child task. */
  readonly replay: (task: TaskRecord, tool: DurableTool) => Effect.Effect<TaskRecord, StorageError | NotFoundError>
}

export class ToolExecutor extends Context.Service<ToolExecutor, ToolExecutorInterface>()("fx-durable/ToolExecutor") {}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export { effectiveTask, unknownOutcomeNotice }

export const layer = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    const journal = yield* JournalService
    const storage = journal.storage
    const ids = yield* IdGenerator
    const crash = yield* CrashInjector

    /** Run the tool body for a task that is already durably `running`. */
    const runTask = (
      task: TaskRecord,
      tool: DurableTool,
      input: Json,
      options: { readonly replay: boolean; readonly interruptReason: () => UnknownOutcomeReason }
    ): Effect.Effect<Json, ToolExecutionError | UnknownOutcomeError | StorageError | NotFoundError> =>
      Effect.gen(function* () {
        const startedAt = journal.now()
        const controller = new AbortController()
        const settled = { done: false }

        const body = Effect.gen(function* () {
          // Start the external effect, then hit the "during" crash point while it is in flight.
          const promise = yield* Effect.sync(() =>
            tool.run(input, {
              agentId: task.agentId,
              turnId: task.turnId,
              taskId: task.id,
              idempotencyKey: task.idempotencyKey,
              signal: controller.signal,
              replay: options.replay
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
              controller.abort()
              const current = yield* db(() => storage.getTask(task.id))
              if (!current || current.state !== "running") return
              // Local cancellation does not prove an external unsafe effect was cancelled.
              if (task.replayPolicy === "safe") {
                yield* db(() => journal.transitionTask(task.id, "cancelled", { error: "cancelled" }, { type: "tool.cancelled", payload: { tool: tool.name } }))
              } else {
                const reason = options.interruptReason()
                yield* db(() => journal.transitionTask(
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

        if (Exit.isSuccess(exit)) {
          yield* crash.hit("tool.after-execute", { name: tool.name })
          const output = exit.value
          const durationMs = journal.now().getTime() - startedAt.getTime()
          yield* db(() => journal.transitionTask(
            task.id,
            "completed",
            { output, metadata: { durationMs, replay: options.replay } },
            { type: "tool.completed", payload: { tool: tool.name, input, durationMs, replay: options.replay } }
          ))
          yield* crash.hit("tool.after-result-persist", { name: tool.name })
          return output
        }

        const cause = exit.cause
        const failure = cause.reasons.find((r) => r._tag === "Fail")
        const error = failure && failure._tag === "Fail" ? failure.error : cause
        if (error instanceof OutcomeUnknown) {
          yield* db(() => journal.transitionTask(
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
        const message = errorMessage(error)
        yield* db(() => journal.transitionTask(
          task.id,
          "failed",
          { error: message },
          { type: "tool.failed", payload: { tool: tool.name, error: message } }
        ))
        return yield* new ToolExecutionError({ taskId: task.id, tool: tool.name, message })
      })

    const runFresh = (ctx: TurnContext, tool: DurableTool, input: Json, inputHash: string, parentTaskId: string | null) =>
      Effect.gen(function* () {
        const submission = yield* db(() => storage.getSubmission(ctx.submissionId))
        if (submission?.cancelRequested) {
          return yield* new InterruptedError({ message: "submission cancellation requested" })
        }
        yield* crash.hit("tool.before-persist", { name: tool.name })
        const id = ids.next("task")
        const policy = policyName(tool.replay)
        const task = yield* db(() => journal.startTask({
          id,
          turnId: ctx.turnId,
          agentId: ctx.agentId,
          type: "tool",
          name: tool.name,
          input,
          inputHash,
          parentTaskId,
          replayPolicy: policy,
          idempotencyKey: idempotencyKeyFor(tool.replay, id, input),
          attempt: ctx.attempt,
          event: { type: "tool.started", payload: { tool: tool.name, input, replay: policy } }
        }))
        yield* crash.hit("tool.after-persist", { name: tool.name })
        return yield* runTask(task, tool, input, {
          replay: false,
          interruptReason: () => ctx.interruptReason ?? "executor_lost"
        })
      })

    const execute = Effect.fn("ToolExecutor.execute")(function* (ctx: TurnContext, tool: DurableTool, input: Json) {
      const inputHash = hashInput(tool.name, input)
      const key = `${tool.name}:${inputHash}`
      const ordinal = ctx.ordinals.get(key) ?? 0
      ctx.ordinals.set(key, ordinal + 1)

      // Map this call onto work journaled by earlier attempts of the same turn.
      const tasks = yield* db(() => storage.tasksForTurn(ctx.turnId))
      const slots = tasks.filter(
        (t) =>
          t.type === "tool" &&
          t.parentTaskId === null &&
          t.name === tool.name &&
          t.inputHash === inputHash &&
          t.attempt < ctx.attempt
      )
      const slot = slots[ordinal]
      if (!slot) return yield* runFresh(ctx, tool, input, inputHash, null)

      const effective = effectiveTask(slot, tasks)
      switch (effective.state) {
        case "completed": {
          yield* db(() => journal.appendEvent({
            agentId: ctx.agentId,
            submissionId: ctx.submissionId,
            turnId: ctx.turnId,
            taskId: effective.id,
            type: "tool.reused",
            payload: { tool: tool.name, input, state: "completed" }
          }))
          return effective.output
        }
        case "failed": {
          yield* db(() => journal.appendEvent({
            agentId: ctx.agentId,
            submissionId: ctx.submissionId,
            turnId: ctx.turnId,
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
            yield* db(() =>
              journal.transaction(() => {
                storage.updateTask(effective.id, { acknowledged: true })
                journal.appendEvent({
                  agentId: ctx.agentId,
                  submissionId: ctx.submissionId,
                  turnId: ctx.turnId,
                  taskId: effective.id,
                  type: "tool.outcome_unknown_refused",
                  payload: { tool: tool.name, input }
                })
              })
            )
            return yield* new UnknownOutcomeError({
              taskId: effective.id,
              tool: tool.name,
              message: `${unknownOutcomeNotice(tool.name, input)}\nThis call was NOT executed. If, after inspecting state, you still need it, call the tool again.`
            })
          }
          return yield* runFresh(ctx, tool, input, inputHash, effective.id)
        }
        case "cancelled":
        case "interrupted":
          return yield* runFresh(ctx, tool, input, inputHash, effective.id)
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

    const replay = Effect.fn("ToolExecutor.replay")(function* (original: TaskRecord, tool: DurableTool) {
      const task = yield* db(() => journal.startTask({
        turnId: original.turnId,
        agentId: original.agentId,
        type: "tool",
        name: original.name,
        input: original.input,
        inputHash: original.inputHash,
        parentTaskId: original.id,
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
      yield* runTask(task, tool, input, { replay: true, interruptReason: () => "executor_lost" }).pipe(
        Effect.catchTags({ ToolExecutionError: () => Effect.void, UnknownOutcomeError: () => Effect.void })
      )
      const updated = yield* db(() => storage.getTask(task.id))
      return updated ?? task
    })

    return ToolExecutor.of({ execute, replay })
  })
)
