import { Effect } from "effect"
import { effectiveTask, unknownOutcomeNotice } from "../tools/executor.js"
import type { StorageError, NotFoundError } from "./errors.js"
import { IdGenerator, now } from "./ids.js"
import { isJsonString, jsonText, type Json } from "./json.js"
import type { SubmissionContent, SubmissionRecord, TaskRecord, TurnRecord, UnknownOutcomeReason } from "./schema.js"
import { Storage } from "./storage.js"
import { TaskEngine } from "./task.js"

/**
 * Durable turn operations. A turn is one logical libfx execution cycle for a
 * submission. It may take several attempts: attempt 1 runs the submission;
 * later attempts are recoveries that resume from the pre-turn checkpoint with
 * the journal of what already happened.
 */

type R = Storage | TaskEngine | IdGenerator

/** Begin a turn for a queued submission. Returns null if it is no longer runnable. */
export const startTurn = (submission: SubmissionRecord, executorId: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const engine = yield* TaskEngine
    const ids = yield* IdGenerator
    return yield* storage.transaction(
      Effect.gen(function* () {
        const current = yield* storage.getSubmission(submission.id)
        if (!current || current.state !== "queued" || current.cancelRequested) return null
        const checkpoint = yield* storage.latestCheckpoint(submission.agentId)
        const startedAt = yield* now
        const turn: TurnRecord = {
          id: yield* ids.next("turn"),
          agentId: submission.agentId,
          submissionId: submission.id,
          state: "running",
          attempt: 1,
          executorId,
          baseCheckpointSeq: checkpoint?.sequence ?? null,
          startedAt,
          completedAt: null
        }
        yield* storage.insertTurn(turn)
        yield* storage.insertTask({
          id: yield* ids.next("task"),
          turnId: turn.id,
          agentId: turn.agentId,
          parentTaskId: null,
          type: "turn",
          state: "running",
          name: null,
          input: null,
          inputHash: null,
          replayPolicy: null,
          idempotencyKey: null,
          attempt: 1,
          metadata: null,
          startedAt
        })
        yield* engine.transitionSubmission(submission.id, "running", undefined, {
          type: "submission.started",
          turnId: turn.id
        })
        yield* engine.transitionAgent(submission.agentId, "running", null)
        yield* engine.emit({
          agentId: turn.agentId,
          submissionId: submission.id,
          turnId: turn.id,
          type: "turn.started",
          payload: { attempt: 1, baseCheckpoint: turn.baseCheckpointSeq }
        })
        return turn
      })
    )
  })

/**
 * Settle every still-running task of a turn after an attempt ended without
 * committing them. Model tasks are replay-safe; tool tasks are classified by
 * their persisted replay policy.
 */
export const settleRunningTasks = (turnId: string, reason: UnknownOutcomeReason) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const engine = yield* TaskEngine
    const tasks = yield* storage.tasksForTurn(turnId)
    for (const task of tasks) {
      if (task.state !== "running" && task.state !== "pending") continue
      switch (task.type) {
        case "turn":
          break
        case "model":
          yield* engine.transitionTask(task.id, "interrupted", { error: reason }, {
            type: "model.interrupted",
            payload: { model: task.name, reason }
          })
          break
        case "checkpoint":
          yield* engine.transitionTask(task.id, "interrupted", { error: reason })
          break
        case "tool":
          if (task.replayPolicy === "unsafe") {
            yield* markOutcomeUnknown(task, reason)
          } else {
            yield* engine.transitionTask(task.id, "interrupted", { error: reason }, {
              type: "tool.interrupted",
              payload: { tool: task.name, input: task.input, replay: task.replayPolicy, reason }
            })
          }
          break
      }
    }
  })

export const markOutcomeUnknown = (task: TaskRecord, reason: UnknownOutcomeReason) =>
  Effect.gen(function* () {
    const engine = yield* TaskEngine
    yield* engine.transitionTask(task.id, "outcome_unknown", { error: `outcome unknown: ${reason}` }, {
      type: "tool.outcome_unknown",
      payload: {
        taskId: task.id,
        tool: task.name,
        input: task.input,
        startedAt: task.startedAt?.toISOString() ?? null,
        reason
      }
    })
  })

const turnTask = (tasks: ReadonlyArray<TaskRecord>) => tasks.find((t) => t.type === "turn" && t.parentTaskId === null)

/** Close the turn's root task, if it is still open. */
export const closeTurnTask = (turnId: string, to: "completed" | "failed" | "cancelled", error?: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const engine = yield* TaskEngine
    const root = turnTask(yield* storage.tasksForTurn(turnId))
    if (root && root.state === "running") {
      yield* engine.transitionTask(root.id, to, error ? { error } : {})
    }
  })

export const failTurn = (turn: TurnRecord, message: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const engine = yield* TaskEngine
    yield* storage.transaction(
      Effect.gen(function* () {
        yield* closeTurnTask(turn.id, "failed", message)
        yield* engine.transitionTurn(turn.id, "failed", undefined, { type: "turn.failed", payload: { error: message } })
        yield* engine.transitionSubmission(turn.submissionId, "failed", { error: message }, {
          type: "submission.failed",
          turnId: turn.id,
          payload: { error: message }
        })
        yield* engine.transitionAgent(turn.agentId, "failed", message)
      })
    )
  })

export const cancelTurn = (turn: TurnRecord) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const engine = yield* TaskEngine
    yield* storage.transaction(
      Effect.gen(function* () {
        yield* closeTurnTask(turn.id, "cancelled", "cancelled")
        yield* engine.transitionTurn(turn.id, "cancelled", undefined, { type: "turn.cancelled" })
        yield* engine.transitionSubmission(turn.submissionId, "cancelled", { error: "cancelled" }, {
          type: "submission.cancelled",
          turnId: turn.id
        })
        yield* engine.transitionAgent(turn.agentId, "idle", null)
      })
    )
  })

/** The turn's owner went away cleanly (shutdown): leave it for recovery. */
export const interruptTurn = (turn: TurnRecord, reason: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const engine = yield* TaskEngine
    const current = yield* storage.getTurn(turn.id)
    if (!current || current.state !== "running") return
    yield* engine.transitionTurn(turn.id, "interrupted", { executorId: null }, {
      type: "turn.interrupted",
      payload: { reason, attempt: current.attempt }
    })
  })

const contentText = (content: SubmissionContent): string =>
  isJsonString(content) ? content : content.map((block) => block.text).join("\n")

const preview = (value: Json, max = 2000): string => {
  const text = jsonText(value)
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text
}

/**
 * The prompt for a recovery attempt: the original request plus everything the
 * journal knows about the interrupted attempt(s). Completed work is listed so
 * it is not repeated; uncertain unsafe effects are called out explicitly.
 */
export const buildRecoveryPrompt = (
  submission: SubmissionRecord,
  turn: TurnRecord,
  tasks: ReadonlyArray<TaskRecord>
): string => {
  const lines: Array<string> = [
    "[fx-durable recovery]",
    `The process running this turn stopped before it finished (attempt ${turn.attempt - 1}).`,
    "The conversation was restored to the start of this turn.",
    "",
    "Original request:",
    contentText(submission.content),
    ""
  ]
  const originals = tasks.filter((t) => t.type === "tool" && t.parentTaskId === null)
  const unknown: Array<string> = []
  if (originals.length > 0) {
    lines.push("Tool calls already journaled for this turn:")
    for (const original of originals) {
      const effective = effectiveTask(original, tasks)
      const call = `${original.name} ${preview(original.input, 300)}`
      const replayed = effective.id !== original.id && original.state === "interrupted" ? " (interrupted, replayed automatically: replay-safe)" : ""
      switch (effective.state) {
        case "completed":
          lines.push(`- ${call} → completed${replayed}. Result: ${preview(effective.output)}`)
          break
        case "failed":
          lines.push(`- ${call} → failed${replayed}: ${effective.error ?? "error"}`)
          break
        case "outcome_unknown":
          lines.push(`- ${call} → OUTCOME UNKNOWN`)
          unknown.push(unknownOutcomeNotice(original.name ?? "tool", original.input))
          break
        case "cancelled":
          lines.push(`- ${call} → cancelled`)
          break
        default:
          lines.push(`- ${call} → interrupted (not replayed)`)
      }
    }
    lines.push("")
    lines.push("Calling a completed tool again with the same input returns the journaled result without re-executing it.")
    lines.push("")
  }
  for (const notice of unknown) {
    lines.push("⚠ Interrupted external operation")
    lines.push(notice)
    lines.push("")
  }
  lines.push("Continue the original request from here.")
  return lines.join("\n")
}

export type TurnOpError = StorageError | NotFoundError
export type TurnServices = R
