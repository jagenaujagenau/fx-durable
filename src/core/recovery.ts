import { Context, Effect, Layer } from "effect"
import { ToolExecutor } from "../tools/executor.js"
import { ToolRegistry } from "../tools/registry.js"
import { AgentSupervisor } from "./agent.js"
import { CrashInjector } from "./crash.js"
import type { NotFoundError, StorageError } from "./errors.js"
import { executorGone, lostReason } from "./executors.js"
import { JournalService, db, read } from "./journal-service.js"
import { RuntimeRegistry } from "./runtime.js"
import type { TaskRecord, TurnRecord, UnknownOutcomeReason } from "./schema.js"
import { effectiveTask } from "./tool-outcomes.js"

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

export const layer = (options: RecoveryOptions = {}) =>
  Layer.effect(
    RecoveryManager,
    Effect.gen(function* () {
      const journal = yield* JournalService
      const storage = journal.storage
      const registry = yield* RuntimeRegistry
      const toolRegistry = yield* ToolRegistry
      const executor = yield* ToolExecutor
      const supervisor = yield* AgentSupervisor
      const crash = yield* CrashInjector
      const maxAttempts = options.maxAttempts ?? 4
      const staleAfter = options.staleExecutorMillis ?? 30_000

      const isExecutorGone = (executorId: string | null) =>
        read(() => {
          if (executorId === null) return true
          if (executorId === supervisor.executorId) return false
          return executorGone(storage.getExecutor(executorId), journal.now(), supervisor.executorId, staleAfter)
        })

      /** Interrupted replayable tool calls with no settled replay yet. */
      const pendingReplays = (tasks: ReadonlyArray<TaskRecord>) =>
        tasks
          .filter((t) => t.type === "tool" && t.parentTaskId === null)
          .map((t) => effectiveTask(t, tasks))
          .filter((t) => t.state === "interrupted" && (t.replayPolicy === "safe" || t.replayPolicy === "idempotent"))

      /** Mark the turn interrupted and the agent recovering. */
      const beginRecovery = (turn: TurnRecord, reason: UnknownOutcomeReason) =>
        journal.transaction(() => {
          journal.transitionAgent(turn.agentId, "recovering", null, {
            type: "recovery.started",
            turnId: turn.id,
            submissionId: turn.submissionId,
            payload: { attempt: turn.attempt, previousExecutor: turn.executorId }
          })
          if (turn.state === "running") {
            journal.transitionTurn(turn.id, "interrupted", { executorId: null }, {
              type: "turn.interrupted",
              payload: { reason, attempt: turn.attempt }
            })
          }
        })

      /** Stop retrying a turn that keeps crashing: fail it and ask for input. */
      const giveUp = (turn: TurnRecord, reason: UnknownOutcomeReason) =>
        journal.transaction(() => {
          const message = `turn interrupted ${turn.attempt} times; giving up automatic recovery`
          journal.classifyTurnTasks(turn.id, reason)
          journal.closeTurnTask(turn.id, "failed", message)
          journal.transitionTurn(turn.id, "failed", {}, { type: "turn.failed", payload: { error: message } })
          journal.transitionSubmission(turn.submissionId, "failed", { error: message }, {
            type: "submission.failed",
            turnId: turn.id,
            payload: { error: message, reason: "max_recovery_attempts" }
          })
          journal.transitionAgent(turn.agentId, "needs_input", message, {
            type: "agent.needs_input",
            turnId: turn.id,
            payload: { reason: message }
          })
          journal.appendEvent({
            agentId: turn.agentId,
            turnId: turn.id,
            submissionId: turn.submissionId,
            type: "recovery.failed",
            payload: { reason: "max_attempts", attempts: turn.attempt }
          })
        })

      /** Hand the turn to this executor for its next attempt. */
      const continueTurn = (turn: TurnRecord, replayed: ReadonlyArray<string>, unknown: ReadonlyArray<string>) =>
        journal.transaction(() => {
          journal.transitionTurn(
            turn.id,
            "running",
            { attempt: turn.attempt + 1, executorId: supervisor.executorId },
            { type: "turn.recovered", payload: { attempt: turn.attempt + 1, replayed, unknownOutcomes: unknown } }
          )
          journal.transitionAgent(turn.agentId, "running", null, {
            type: "recovery.completed",
            turnId: turn.id,
            submissionId: turn.submissionId,
            payload: { attempt: turn.attempt + 1, replayed: replayed.length, unknownOutcomes: unknown.length }
          })
        })

      const recoverTurn = (turn: TurnRecord) =>
        Effect.gen(function* () {
          const agent = yield* db(() => storage.getAgent(turn.agentId))
          if (!agent) return { outcome: "skipped" as const, replayed: [], unknown: [] }
          const executorId = turn.executorId
          const previous = executorId ? yield* db(() => storage.getExecutor(executorId)) : null
          const reason = lostReason(previous)

          yield* crash.hit("recovery.started")
          yield* db(() => beginRecovery(turn, reason))

          // Resolve the runtime before touching tools. Missing → park, keep the work.
          if (!(yield* registry.has(agent.runtimeId))) {
            const message = `runtime "${agent.runtimeId}" is not registered; turn parked until it is`
            yield* db(() =>
              journal.transitionAgent(agent.id, "configuration_error", message, {
                type: "recovery.failed",
                turnId: turn.id,
                submissionId: turn.submissionId,
                payload: { reason: "runtime_unavailable", runtimeId: agent.runtimeId }
              })
            )
            return { outcome: "parked" as const, replayed: [], unknown: [] }
          }

          if (turn.attempt >= maxAttempts) {
            yield* db(() => giveUp(turn, reason))
            return { outcome: "gave_up" as const, replayed: [], unknown: [] }
          }

          const unknown = yield* db(() => journal.classifyTurnTasks(turn.id, reason))
          yield* crash.hit("recovery.after-classify")

          // Replay only what the persisted policy allows.
          const replayed: Array<string> = []
          const replays = pendingReplays(yield* db(() => storage.tasksForTurn(turn.id)))
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
          yield* db(() => continueTurn(turn, replayed, unknown))
          return { outcome: "recovered" as const, replayed, unknown }
        })

      /** Orphaned tasks outside any active turn (should not exist) are made explicit too. */
      const settleOrphans = () =>
        journal.transaction(() => {
          const unknown: Array<string> = []
          for (const task of storage.unfinishedTasks()) {
            const turn = storage.getTurn(task.turnId)
            if (!turn || turn.state === "running" || turn.state === "interrupted") continue
            if (task.type === "tool" && task.replayPolicy !== "safe") {
              journal.markOutcomeUnknown(task, "process_terminated")
              unknown.push(task.id)
            } else {
              journal.transitionTask(task.id, "interrupted", { error: "orphaned" })
            }
          }
          return unknown
        })

      const resume = Effect.fn("RecoveryManager.resume")(function* () {
        const recoveredTurns: Array<string> = []
        const replayedTasks: Array<string> = []
        const unknownOutcomes: Array<string> = []
        const parkedAgents: Array<string> = []
        const skippedTurns: Array<string> = []

        for (const turn of yield* db(() => storage.unfinishedTurns())) {
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
        unknownOutcomes.push(...(yield* db(settleOrphans)))

        // Agents stuck in transient states with no active turn, and agents with queued work.
        for (const agent of yield* db(() => storage.listAgents())) {
          const active = yield* db(() => storage.activeTurn(agent.id))
          if (!active && (agent.state === "recovering" || agent.state === "running")) {
            yield* db(() => journal.transitionAgent(agent.id, "idle", null, { type: "agent.idle" }))
          }
          const queued = yield* db(() => storage.nextQueuedSubmission(agent.id))
          const owned = active && active.state === "running" && active.executorId === supervisor.executorId
          if (owned || queued) {
            yield* supervisor.ensureWorker(agent.id)
            yield* supervisor.wake(agent.id)
          }
        }

        return { recoveredTurns, replayedTasks, unknownOutcomes, parkedAgents, skippedTurns }
      })

      return RecoveryManager.of({ resume, isExecutorGone })
    })
  )
