import { hostname } from "node:os"
import { Cause, Context, Effect, Exit, Fiber, FiberMap, Layer, Queue, Schedule, Scope } from "effect"
import { ToolExecutor } from "./tool-executor.js"
import { ToolRegistry } from "./tool-registry.js"
import { CrashInjector } from "./crash.js"
import { NotFoundError, type StorageError } from "../domain/errors.js"
import { IdGenerator } from "./ids.js"
import { Database } from "./database.js"
import { LibFx, type FxSession, type LibfxTool } from "./libfx.js"
import { makeDurableFetch, type ModelTransportHolder } from "./model.js"
import { RuntimeRegistry } from "./runtime-registry.js"
import type { DurableAgentRecord, SubmissionContent, TurnRecord } from "../domain/schema.js"
import { isTerminalSubmission } from "../domain/state-machine.js"
import { buildRecoveryPrompt } from "../domain/tool-outcomes.js"
import { makeTurnContext, type TurnContext } from "./turn-context.js"

/**
 * Owns execution inside this process: one worker Fiber per agent, one active
 * turn per agent, parallelism across agents. Fibers execute durable work but
 * are never its representation — every fact recovery needs is in SQLite
 * before the next externally observable operation.
 */

export interface AgentSupervisorInterface {
  readonly executorId: string
  /** Start the agent's worker if it is not running. */
  readonly ensureWorker: (agentId: string) => Effect.Effect<void>
  /** Nudge the agent's worker to look for new work. */
  readonly wake: (agentId: string) => Effect.Effect<void>
  readonly cancel: (submissionId: string) => Effect.Effect<void, StorageError | NotFoundError>
  /** Mark this executor as stopped and interrupt its turns (they stay recoverable). */
  readonly shutdown: () => Effect.Effect<void>
}

export class AgentSupervisor extends Context.Service<AgentSupervisor, AgentSupervisorInterface>()(
  "fx-durable/AgentSupervisor"
) {}

export interface SupervisorOptions {
  readonly heartbeatMillis?: number
  /** How often idle workers re-check the durable queue for work submitted by other processes. */
  readonly idlePollMillis?: number
}

interface AgentSession {
  readonly agentId: string
  readonly fx: FxSession
  readonly holder: ModelTransportHolder
  readonly scope: Scope.Closeable
  readonly runtimeId: string
  readonly model: string
  checkpointSeq: number | null
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export const layer = (options: SupervisorOptions = {}) =>
  Layer.effect(
    AgentSupervisor,
    Effect.gen(function* () {
      const database = yield* Database
      const ids = yield* IdGenerator
      const registry = yield* RuntimeRegistry
      const toolRegistry = yield* ToolRegistry
      const executor = yield* ToolExecutor
      const libfx = yield* LibFx
      const crash = yield* CrashInjector

      const executorId = ids.next("exec")
      yield* database.run((journal) => journal.registerExecutor(executorId, process.pid, hostname()))
      yield* database.run((journal) => journal.heartbeatExecutor(executorId)).pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(options.heartbeatMillis ?? 5000)),
        Effect.forkScoped
      )

      const workers = yield* FiberMap.make<string>()
      const wakes = new Map<string, Queue.Queue<void>>()
      const sessions = new Map<string, AgentSession>()
      const attempts = new Map<string, { ctx: TurnContext; fiber: Fiber.Fiber<void, unknown> }>()
      let stopping = false

      const wakeQueue = (agentId: string) =>
        Effect.gen(function* () {
          let q = wakes.get(agentId)
          if (!q) {
            q = yield* Queue.sliding<void>(1)
            wakes.set(agentId, q)
          }
          return q
        })

      const closeSession = (agentId: string) =>
        Effect.gen(function* () {
          const session = sessions.get(agentId)
          if (!session) return
          sessions.delete(agentId)
          yield* session.fx.close()
          yield* Scope.close(session.scope, Exit.void)
        })

      /** Build (or reuse) the live libfx agent, restored from the latest durable checkpoint. */
      const getSession = (agent: DurableAgentRecord, expectedSeq: number | null) =>
        Effect.gen(function* () {
          const existing = sessions.get(agent.id)
          if (
            existing &&
            existing.checkpointSeq === expectedSeq &&
            existing.runtimeId === agent.runtimeId &&
            existing.model === agent.model
          ) {
            return existing
          }
          if (existing) yield* closeSession(agent.id)

          const runtime = yield* registry.resolve(agent.runtimeId)
          const scope = yield* Scope.make()
          const built = yield* Effect.gen(function* () {
            const resolved = yield* toolRegistry.resolve(agent, runtime).pipe(Scope.provide(scope))
            const checkpoint = yield* database.read((storage) => storage.latestCheckpoint(agent.id))
            const holder: ModelTransportHolder = { current: null }
            const fetch = makeDurableFetch(holder, libfx.transport, database.models, crash)
            const tools: Array<LibfxTool> = resolved.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.jsonSchema,
              execute: (input, { signal }) => {
                const ctx = holder.current
                if (!ctx) return Promise.reject(new Error(`tool ${tool.name} called outside of a turn`))
                const promise = Effect.runPromiseExit(executor.execute(ctx, tool, input), { signal }).then(
                  (exit) => {
                    if (Exit.isSuccess(exit)) return exit.value
                    const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
                    if (failure && failure._tag === "Fail") throw new Error(failure.error.message)
                    if (Cause.hasInterruptsOnly(exit.cause)) throw new Error("tool call cancelled")
                    throw new Error(Cause.pretty(exit.cause))
                  }
                )
                ctx.inflight.add(promise)
                promise.finally(() => ctx.inflight.delete(promise)).catch(() => undefined)
                return promise
              }
            }))
            const fx = yield* libfx.create({
              agent,
              checkpoint: checkpoint?.fxCheckpoint ?? null,
              instructions: resolved.instructions,
              tools,
              fetch
            })
            const session: AgentSession = {
              agentId: agent.id,
              fx,
              holder,
              scope,
              runtimeId: agent.runtimeId,
              model: agent.model,
              checkpointSeq: checkpoint?.sequence ?? null
            }
            return session
          }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
          sessions.set(agent.id, built)
          return built
        })

      /** Run one attempt of an active turn owned by this executor. */
      const runAttempt = (turn: TurnRecord, ctx: TurnContext) =>
        Effect.gen(function* () {
          const submission = yield* database.read((storage) => storage.getSubmission(turn.submissionId))
          const agent = yield* database.read((storage) => storage.getAgent(turn.agentId))
          if (!submission || !agent) return yield* new NotFoundError({ entity: "turn", id: turn.id })

          if (submission.cancelRequested) {
            yield* database.run((journal) =>
              journal.transaction(() => {
                journal.classifyTurnTasks(turn.id, "cancelled")
                journal.cancelTurn(turn)
              })
            )
            return
          }

          const sessionExit = yield* Effect.exit(getSession(agent, turn.baseCheckpointSeq))
          if (Exit.isFailure(sessionExit)) {
            const failure = sessionExit.cause.reasons.find((r) => r._tag === "Fail")
            const error = failure && failure._tag === "Fail" ? failure.error : null
            if (error && error._tag === "RuntimeConfigurationError") {
              // Do not discard work: park the turn until the runtime is registered again.
              yield* database.run((journal) => journal.parkTurn(turn, agent.runtimeId, error.message))
              return
            }
            const message = error ? error.message : Cause.pretty(sessionExit.cause)
            yield* database.run((journal) => journal.failTurn(turn, message))
            return
          }
          const session = sessionExit.value
          if (session.checkpointSeq !== turn.baseCheckpointSeq) {
            yield* database.run((journal) => journal.failTurn(turn, `checkpoint mismatch: turn started from ${turn.baseCheckpointSeq}, latest is ${session.checkpointSeq}`))
            return
          }

          const content: SubmissionContent =
            turn.attempt === 1
              ? submission.content
              : buildRecoveryPrompt(submission, turn, yield* database.read((storage) => storage.tasksForTurn(turn.id)))

          const settleInflight = Effect.promise(() => Promise.allSettled(ctx.inflight))

          const attempt = Effect.gen(function* () {
            session.holder.current = ctx
            const result = yield* session.fx.prompt(content).pipe(
              Effect.ensuring(Effect.sync(() => (session.holder.current = null)))
            )
            yield* settleInflight

            // Checkpoint + turn completion commit in ONE transaction: a
            // checkpoint never exists for an unfinished turn.
            const checkpointTask = yield* database.run((journal) => journal.startTask({
              turnId: turn.id,
              agentId: agent.id,
              type: "checkpoint",
              attempt: turn.attempt
            }))
            yield* crash.hit("checkpoint.before-write")
            const bytes = yield* session.fx.checkpoint()
            const written = yield* database.run((journal) =>
              journal.completeTurn(
                {
                  turn,
                  agent,
                  checkpointTaskId: checkpointTask.id,
                  checkpoint: bytes,
                  result: { text: result.text, stopReason: result.stopReason, usage: result.usage }
                },
                () => crash.hitSync("checkpoint.during-write")
              )
            )
            session.checkpointSeq = written.sequence
            yield* crash.hit("checkpoint.after-write")
          })

          const exit = yield* Effect.exit(
            attempt.pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  yield* settleInflight
                  const reason = ctx.interruptReason ?? "executor_lost"
                  yield* database.run((journal) => journal.classifyTurnTasks(turn.id, reason))
                  yield* closeSession(agent.id)
                  yield* database.run((journal) =>
                    reason === "cancelled" ? journal.cancelTurn(turn) : journal.interruptTurn(turn, "executor stopped")
                  )
                }).pipe(Effect.orDie)
              )
            )
          )
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return

          // The attempt failed in-process (model/transport/checkpoint error).
          yield* settleInflight
          const latest = yield* database.read((storage) => storage.getSubmission(submission.id))
          yield* database.run((journal) => journal.classifyTurnTasks(turn.id, latest?.cancelRequested ? "cancelled" : "executor_lost"))
          yield* closeSession(agent.id)
          if (latest?.cancelRequested) {
            yield* database.run((journal) => journal.cancelTurn(turn))
            return
          }
          const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
          const message = failure && failure._tag === "Fail" ? errorMessage(failure.error) : Cause.pretty(exit.cause)
          yield* database.run((journal) => journal.failTurn(turn, message))
        })

      /** One scheduling step. Returns true if it did work. */
      const step = (agentId: string) =>
        Effect.gen(function* () {
          const agent = yield* database.read((storage) => storage.getAgent(agentId))
          if (!agent) return false
          const active = yield* database.read((storage) => storage.activeTurn(agentId))
          if (active) {
            if (active.state !== "running" || active.executorId !== executorId) return false // awaiting recovery
            const ctx = makeTurnContext({
              agentId,
              submissionId: active.submissionId,
              turnId: active.id,
              attempt: active.attempt,
              model: agent.model
            })
            const fiber = yield* Effect.forkChild(runAttempt(active, ctx).pipe(Effect.asVoid))
            attempts.set(agentId, { ctx, fiber })
            yield* Fiber.join(fiber).pipe(Effect.exit)
            attempts.delete(agentId)
            return true
          }
          if (agent.state === "configuration_error" && !(yield* registry.has(agent.runtimeId))) return false
          if (agent.state === "recovering") return false
          const next = yield* database.read((storage) => storage.nextQueuedSubmission(agentId))
          if (next) {
            const turn = yield* database.run((journal) => journal.startTurn(next, executorId))
            if (turn) yield* crash.hit("turn.after-start")
            return true
          }
          if (agent.state === "running") {
            yield* database.run((journal) => journal.transitionAgent(agentId, "idle", null, { type: "agent.idle" }))
          }
          return false
        })

      const workerLoop = (agentId: string) =>
        Effect.gen(function* () {
          const q = yield* wakeQueue(agentId)
          while (!stopping) {
            const worked = yield* step(agentId).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`fx-durable worker ${agentId} step failed`, cause).pipe(Effect.as(false))
              )
            )
            if (!worked) yield* Queue.take(q).pipe(Effect.timeoutOption(options.idlePollMillis ?? 1000))
          }
        })

      const ensureWorker = (agentId: string) =>
        Effect.gen(function* () {
          if (stopping) return
          if (yield* FiberMap.has(workers, agentId)) return
          yield* FiberMap.run(workers, agentId, workerLoop(agentId), {
            onlyIfMissing: true
          })
        })

      const wake = (agentId: string) =>
        Effect.gen(function* () {
          const q = yield* wakeQueue(agentId)
          yield* Queue.offer(q, undefined)
        })

      const cancel = Effect.fn("AgentSupervisor.cancel")(function* (submissionId: string) {
        const submission = yield* database.read((storage) => storage.getSubmission(submissionId))
        if (!submission) return yield* new NotFoundError({ entity: "submission", id: submissionId })
        if (isTerminalSubmission(submission.state)) return
        yield* database.run((journal) => journal.requestCancellation(submission))
        const running = attempts.get(submission.agentId)
        if (running && running.ctx.submissionId === submissionId) {
          running.ctx.interruptReason = "cancelled"
          yield* Fiber.interrupt(running.fiber)
        }
        yield* wake(submission.agentId)
      })

      const shutdown = () =>
        Effect.gen(function* () {
          if (stopping) return
          stopping = true
          for (const { ctx } of attempts.values()) ctx.interruptReason ??= "executor_lost"
          yield* Effect.forEach([...attempts.values()], ({ fiber }) => Fiber.interrupt(fiber), { discard: true })
          yield* FiberMap.clear(workers)
          yield* Effect.forEach([...sessions.keys()], closeSession, { discard: true })
          yield* database.run((journal) => journal.stopExecutor(executorId)).pipe(Effect.ignore)
        })

      yield* Effect.addFinalizer(() => shutdown())

      return AgentSupervisor.of({ executorId, ensureWorker, wake, cancel, shutdown })
    })
  )
