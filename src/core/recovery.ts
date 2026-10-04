import { hostname } from "node:os"
import { Context, Effect, Layer, Stream } from "effect"
import { ToolExecutor, effectiveTask } from "../tools/executor.js"
import { recoveryActionFor } from "../tools/replay-policy.js"
import { ToolRegistry } from "../tools/registry.js"
import { AgentSupervisor } from "./agent.js"
import { CrashInjector } from "./crash.js"
import type { NotFoundError, StorageError } from "./errors.js"
import { now } from "./ids.js"
import { RuntimeRegistry } from "./runtime.js"
import type { TaskRecord, TurnRecord, UnknownOutcomeReason } from "./schema.js"
import { Storage, type ExecutorRecord } from "./storage.js"
import { TaskEngine } from "./task.js"
import { closeTurnTask, markOutcomeUnknown } from "./turn.js"

/**
 * Startup recovery. Every step is a persisted transition, so crashing during
 * recovery leaves a state that the next recovery pass handles the same way.
 *
 *   1. discover unfinished turns whose executor is gone
 *   2. resolve the runtime configuration (park the agent if unavailable)
 *   3. classify interrupted tasks by persisted replay policy
 *   4. replay safe / retry idempotent tools; unsafe → outcome_unknown
 *   5. append recovery events and hand the turn to this executor's worker,
 *      which restores the latest checkpoint and continues the logical turn
 */

export interface RecoveryReport {
  readonly recoveredTurns: ReadonlyArray<string>
  readonly replayedTasks: ReadonlyArray<string>
  readonly unknownOutcomes: ReadonlyArray<string>
  readonly parkedAgents: ReadonlyArray<string>
  readonly skippedTurns: ReadonlyArray<string>
}

export interface RecoveryOptions {
  /** A turn exceeding this many attempts moves to needs_input instead of retrying forever. */
  readonly maxAttempts?: number
  /** Executors on other hosts are presumed dead after this much heartbeat silence. */
  readonly staleExecutorMillis?: number
}

export interface RecoveryManagerInterface {
  readonly resume: () => Effect.Effect<RecoveryReport, StorageError | NotFoundError>
  /** Is the executor that owns a turn gone (crashed, stopped, or silent)? */
  readonly isExecutorGone: (executorId: string | null) => Effect.Effect<boolean, StorageError>
}

export class RecoveryManager extends Context.Service<RecoveryManager, RecoveryManagerInterface>()(
  "fx-durable/RecoveryManager"
) {}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/** Classify the unfinished tasks of a turn by their persisted replay policy. */
export const classifyTurnTasks = (turn: TurnRecord, reason: UnknownOutcomeReason) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const engine = yield* TaskEngine
    const unknown: Array<string> = []
    const tasks = yield* storage.tasksForTurn(turn.id)
    for (const task of tasks) {
      if (task.state !== "running" && task.state !== "pending") continue
      if (task.type === "turn") continue
      if (task.type === "model") {
        yield* engine.transitionTask(task.id, "interrupted", { error: reason }, {
          type: "model.interrupted",
          payload: { model: task.name, reason }
        })
        continue
      }
      if (task.type === "checkpoint") {
        yield* engine.transitionTask(task.id, "interrupted", { error: reason })
        continue
      }
      const action = recoveryActionFor(task.replayPolicy ?? "unsafe")
      if (action === "mark_outcome_unknown") {
        yield* markOutcomeUnknown(task, reason)
        unknown.push(task.id)
      } else {
        yield* engine.transitionTask(task.id, "interrupted", { error: reason }, {
          type: "tool.interrupted",
          payload: { tool: task.name, input: task.input, replay: task.replayPolicy, action, reason }
        })
      }
    }
    return unknown
  })

/** Is an executor gone? Same host: ask the OS. Other hosts: heartbeat silence. */
export const executorGone = (record: ExecutorRecord | null, at: Date, self: string | null, staleAfter = 30_000): boolean => {
  if (!record) return true
  if (record.stoppedAt) return true
  if (record.id === self) return false
  if (record.hostname === hostname()) {
    // A different executor in our own pid is a previous incarnation of this process image.
    if (record.pid === process.pid) return true
    return !pidAlive(record.pid)
  }
  return at.getTime() - record.heartbeatAt.getTime() > staleAfter
}

/**
 * Journal-only recovery for observers such as `fxd recover`: classify the
 * interrupted work of dead executors (unsafe → outcome_unknown, replayable →
 * interrupted) without executing anything. The application continues those
 * turns on its next `resume()`.
 */
export const journalRecover = Effect.gen(function* () {
  const storage = yield* Storage
  const engine = yield* TaskEngine
  const at = yield* now
  const classified: Array<{ turnId: string; agentId: string; unknown: ReadonlyArray<string> }> = []
  for (const turn of yield* storage.unfinishedTurns()) {
    const record = turn.executorId ? yield* storage.getExecutor(turn.executorId) : null
    if (turn.executorId !== null && !executorGone(record, at, null)) continue
    const reason: UnknownOutcomeReason = record && record.hostname !== hostname() && !record.stoppedAt ? "executor_lost" : "process_terminated"
    const unknown = yield* storage.transaction(
      Effect.gen(function* () {
        const agent = yield* storage.getAgent(turn.agentId)
        if (agent && agent.state !== "recovering") {
          yield* engine.transitionAgent(agent.id, "recovering", "interrupted turn awaiting application resume", {
            type: "recovery.started",
            turnId: turn.id,
            submissionId: turn.submissionId,
            payload: { attempt: turn.attempt, previousExecutor: turn.executorId, mode: "journal" }
          })
        }
        if (turn.state === "running") {
          yield* engine.transitionTurn(turn.id, "interrupted", { executorId: null }, {
            type: "turn.interrupted",
            payload: { reason, attempt: turn.attempt }
          })
        }
        return yield* classifyTurnTasks(turn, reason)
      })
    )
    if (turn.state === "running" || unknown.length > 0) classified.push({ turnId: turn.id, agentId: turn.agentId, unknown })
  }
  return classified
})

export const layer = (options: RecoveryOptions = {}) =>
  Layer.effect(
    RecoveryManager,
    Effect.gen(function* () {
      const storage = yield* Storage
      const engine = yield* TaskEngine
      const registry = yield* RuntimeRegistry
      const toolRegistry = yield* ToolRegistry
      const executor = yield* ToolExecutor
      const supervisor = yield* AgentSupervisor
      const crash = yield* CrashInjector
      const context = yield* Effect.context<Storage | TaskEngine>()
      const maxAttempts = options.maxAttempts ?? 4
      const staleAfter = options.staleExecutorMillis ?? 30_000

      const isExecutorGone = (executorId: string | null) =>
        Effect.gen(function* () {
          if (executorId === null) return true
          if (executorId === supervisor.executorId) return false
          return executorGone(yield* storage.getExecutor(executorId), yield* now, supervisor.executorId, staleAfter)
        })

      const lostReason = (record: ExecutorRecord | null): UnknownOutcomeReason =>
        record && record.hostname !== hostname() && !record.stoppedAt ? "executor_lost" : "process_terminated"

      const classify = classifyTurnTasks

      /** Interrupted replayable tool calls with no settled replay yet. */
      const pendingReplays = (tasks: ReadonlyArray<TaskRecord>) =>
        tasks
          .filter((t) => t.type === "tool" && t.parentTaskId === null)
          .map((t) => effectiveTask(t, tasks))
          .filter(
            (t) =>
              t.state === "interrupted" && (t.replayPolicy === "safe" || t.replayPolicy === "idempotent")
          )

      const recoverTurn = (turn: TurnRecord) =>
        Effect.gen(function* () {
          const agent = yield* storage.getAgent(turn.agentId)
          if (!agent) return { outcome: "skipped" as const, replayed: [], unknown: [] }
          const previous = turn.executorId ? yield* storage.getExecutor(turn.executorId) : null
          const reason = lostReason(previous)

          yield* crash.hit("recovery.started")
          yield* storage.transaction(
            Effect.gen(function* () {
              yield* engine.transitionAgent(agent.id, "recovering", null, {
                type: "recovery.started",
                turnId: turn.id,
                submissionId: turn.submissionId,
                payload: { attempt: turn.attempt, previousExecutor: turn.executorId }
              })
              if (turn.state === "running") {
                yield* engine.transitionTurn(turn.id, "interrupted", { executorId: null }, {
                  type: "turn.interrupted",
                  payload: { reason, attempt: turn.attempt }
                })
              }
            })
          )

          // Resolve the runtime before touching tools. Missing → park, keep the work.
          const hasRuntime = yield* registry.has(agent.runtimeId)
          if (!hasRuntime) {
            const message = `runtime "${agent.runtimeId}" is not registered; turn parked until it is`
            yield* engine.transitionAgent(agent.id, "configuration_error", message, {
              type: "recovery.failed",
              turnId: turn.id,
              submissionId: turn.submissionId,
              payload: { reason: "runtime_unavailable", runtimeId: agent.runtimeId }
            })
            return { outcome: "parked" as const, replayed: [], unknown: [] }
          }

          if (turn.attempt >= maxAttempts) {
            const message = `turn interrupted ${turn.attempt} times; giving up automatic recovery`
            yield* storage.transaction(
              Effect.gen(function* () {
                yield* classify(turn, reason)
                yield* closeTurnTask(turn.id, "failed", message)
                yield* engine.transitionTurn(turn.id, "failed", undefined, {
                  type: "turn.failed",
                  payload: { error: message }
                })
                yield* engine.transitionSubmission(turn.submissionId, "failed", { error: message }, {
                  type: "submission.failed",
                  turnId: turn.id,
                  payload: { error: message, reason: "max_recovery_attempts" }
                })
                yield* engine.transitionAgent(agent.id, "needs_input", message, {
                  type: "agent.needs_input",
                  turnId: turn.id,
                  payload: { reason: message }
                })
                yield* engine.emit({
                  agentId: agent.id,
                  turnId: turn.id,
                  submissionId: turn.submissionId,
                  type: "recovery.failed",
                  payload: { reason: "max_attempts", attempts: turn.attempt }
                })
              })
            )
            return { outcome: "gave_up" as const, replayed: [], unknown: [] }
          }

          const unknown = yield* classify(turn, reason)
          yield* crash.hit("recovery.after-classify")

          // Replay only what the persisted policy allows.
          const replayed: Array<string> = []
          const replays = pendingReplays(yield* storage.tasksForTurn(turn.id))
          if (replays.length > 0) {
            const runtime = yield* registry.resolve(agent.runtimeId).pipe(Effect.orDie)
            yield* Effect.scoped(
              Effect.gen(function* () {
                const resolved = yield* toolRegistry.resolve(agent, runtime).pipe(Effect.orDie)
                for (const task of replays) {
                  const tool = resolved.byName.get(task.name ?? "")
                  if (!tool) continue // tool removed from runtime: the model sees it as interrupted
                  const result = yield* executor.replay(task, tool)
                  replayed.push(result.id)
                }
              })
            )
          }

          yield* crash.hit("recovery.before-continue")
          yield* storage.transaction(
            Effect.gen(function* () {
              yield* engine.transitionTurn(
                turn.id,
                "running",
                { attempt: turn.attempt + 1, executorId: supervisor.executorId },
                {
                  type: "turn.recovered",
                  payload: { attempt: turn.attempt + 1, replayed, unknownOutcomes: unknown }
                }
              )
              yield* engine.transitionAgent(agent.id, "running", null, {
                type: "recovery.completed",
                turnId: turn.id,
                submissionId: turn.submissionId,
                payload: { attempt: turn.attempt + 1, replayed: replayed.length, unknownOutcomes: unknown.length }
              })
            })
          )
          return { outcome: "recovered" as const, replayed, unknown }
        })

      const resume = Effect.fn("RecoveryManager.resume")(function* () {
        const recoveredTurns: Array<string> = []
        const replayedTasks: Array<string> = []
        const unknownOutcomes: Array<string> = []
        const parkedAgents: Array<string> = []
        const skippedTurns: Array<string> = []

        for (const turn of yield* storage.unfinishedTurns()) {
          if (!(yield* isExecutorGone(turn.executorId))) {
            skippedTurns.push(turn.id)
            continue
          }
          const result = yield* recoverTurn(turn)
          if (result.outcome === "recovered") recoveredTurns.push(turn.id)
          if (result.outcome === "parked") parkedAgents.push(turn.agentId)
          if (result.outcome === "skipped") skippedTurns.push(turn.id)
          replayedTasks.push(...result.replayed)
          unknownOutcomes.push(...result.unknown)
        }

        // Orphaned tasks outside any active turn (should not exist) are made explicit too.
        yield* storage.unfinishedTasks().pipe(
          Stream.runForEach((task) =>
            Effect.gen(function* () {
              const turn = yield* storage.getTurn(task.turnId)
              if (!turn || turn.state === "running" || turn.state === "interrupted") return
              if (task.type === "tool" && task.replayPolicy !== "safe") {
                yield* markOutcomeUnknown(task, "process_terminated")
                unknownOutcomes.push(task.id)
              } else {
                yield* engine.transitionTask(task.id, "interrupted", { error: "orphaned" })
              }
            })
          )
        )

        // Agents stuck in transient states with no active turn, and agents with queued work.
        for (const agent of yield* storage.listAgents()) {
          const active = yield* storage.activeTurn(agent.id)
          if (!active && agent.state === "recovering") {
            yield* engine.transitionAgent(agent.id, "idle", null, { type: "agent.idle" })
          }
          if (!active && agent.state === "running") {
            yield* engine.transitionAgent(agent.id, "idle", null, { type: "agent.idle" })
          }
          const queued = yield* storage.nextQueuedSubmission(agent.id)
          const owned = active && active.state === "running" && active.executorId === supervisor.executorId
          if (owned || queued) {
            yield* supervisor.ensureWorker(agent.id)
            yield* supervisor.wake(agent.id)
          }
        }

        return { recoveredTurns, replayedTasks, unknownOutcomes, parkedAgents, skippedTurns }
      })

      return RecoveryManager.of({ resume: () => resume().pipe(Effect.provide(context)), isExecutorGone })
    })
  )

