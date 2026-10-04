import { Context, Effect, Layer } from "effect"
import { ToolExecutor } from "./tool-executor.js"
import { ToolRegistry } from "./tool-registry.js"
import { AgentSupervisor } from "./supervisor.js"
import { CrashInjector } from "./crash.js"
import type { NotFoundError, StorageError } from "../domain/errors.js"
import { lostReason } from "../domain/executors.js"
import { Database } from "./database.js"
import { RuntimeRegistry } from "./runtime-registry.js"
import type { TaskRecord, TurnRecord } from "../domain/schema.js"
import { effectiveTask } from "../domain/tool-outcomes.js"

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
      const database = yield* Database
      const registry = yield* RuntimeRegistry
      const toolRegistry = yield* ToolRegistry
      const executor = yield* ToolExecutor
      const supervisor = yield* AgentSupervisor
      const crash = yield* CrashInjector
      const maxAttempts = options.maxAttempts ?? 4
      const staleAfter = options.staleExecutorMillis ?? 30_000

      const isExecutorGone = (executorId: string | null) =>
        database.executors((registry) => registry.isGone(executorId, supervisor.executorId, staleAfter))

      /** Interrupted replayable tool calls with no settled replay yet. */
      const pendingReplays = (tasks: ReadonlyArray<TaskRecord>) =>
        tasks
          .filter((t) => t.type === "tool" && t.parentTaskId === null)
          .map((t) => effectiveTask(t, tasks))
          .filter((t) => t.state === "interrupted" && (t.replayPolicy === "safe" || t.replayPolicy === "idempotent"))

      const recoverTurn = (turn: TurnRecord) =>
        Effect.gen(function* () {
          const agent = yield* database.read((storage) => storage.getAgent(turn.agentId))
          if (!agent) return { outcome: "skipped" as const, replayed: [], unknown: [] }
          const executorId = turn.executorId
          const previous = executorId ? yield* database.read((storage) => storage.getExecutor(executorId)) : null
          const reason = lostReason(previous)

          yield* crash.hit("recovery.started")
          yield* database.run((journal) => journal.beginRecovery(turn, reason))

          // Resolve the runtime before touching tools. Missing → park, keep the work.
          if (!(yield* registry.has(agent.runtimeId))) {
            yield* database.run((journal) => journal.recoveryParked(turn, agent.runtimeId))
            return { outcome: "parked" as const, replayed: [], unknown: [] }
          }

          if (turn.attempt >= maxAttempts) {
            yield* database.run((journal) => journal.abandonRecovery(turn, reason))
            return { outcome: "gave_up" as const, replayed: [], unknown: [] }
          }

          const unknown = yield* database.run((journal) => journal.classifyTurnTasks(turn.id, reason))
          yield* crash.hit("recovery.after-classify")

          // Replay only what the persisted policy allows.
          const replayed: Array<string> = []
          const replays = pendingReplays(yield* database.read((storage) => storage.tasksForTurn(turn.id)))
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
          yield* database.run((journal) => journal.resumeTurn(turn, supervisor.executorId, replayed, unknown))
          return { outcome: "recovered" as const, replayed, unknown }
        })

      const resume = Effect.fn("RecoveryManager.resume")(function* () {
        const recoveredTurns: Array<string> = []
        const replayedTasks: Array<string> = []
        const unknownOutcomes: Array<string> = []
        const parkedAgents: Array<string> = []
        const skippedTurns: Array<string> = []

        for (const turn of yield* database.read((storage) => storage.unfinishedTurns())) {
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
        unknownOutcomes.push(...(yield* database.run((journal) => journal.settleOrphanedTasks())))

        // Agents stuck in transient states with no active turn, and agents with queued work.
        for (const agent of yield* database.read((storage) => storage.listAgents())) {
          yield* database.run((journal) => journal.idleIfStranded(agent.id))
          const active = yield* database.read((storage) => storage.activeTurn(agent.id))
          const queued = yield* database.read((storage) => storage.nextQueuedSubmission(agent.id))
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
