import { Context, Effect, Layer, Schema } from "effect"
import type { FxHostTool, FxToolContext } from "libfx"
import { CrashInjector } from "./crash.js"
import { Database } from "./database.js"
import { ToolBlockedError, ToolExecutionError, UnknownOutcomeError } from "../domain/errors.js"
import { canonicalJson, type Json, type JsonObject } from "../domain/json.js"
import { applyUpdate, DocumentUpdateFailed, documentValue, ownValue, type DurableDocument } from "../domain/documents.js"
import type { StagedDocumentWrite } from "../durable/journal.js"
import type { ToolCallKey } from "../durable/storage.js"
import type { ToolCallRecord } from "../domain/schema.js"
import { OutcomeUnknown, type DocumentAccess, type DurableTool, type NestedCallOptions } from "../tools/define-tool.js"
import type { ToolCall, ToolHookContext, ToolHooks } from "../tools/hooks.js"
import { idempotencyKeyFor, policyName } from "../tools/replay-policy.js"
import { ToolRegistry } from "./tool-registry.js"

/**
 * Runs tool calls between libfx and the tools, with fx-durable's journal in
 * the middle.
 *
 * libfx records each step of a turn and, after a crash, continues the turn.
 * A replay-safe or idempotent call that was cut off runs again under the same
 * `executionId`; the journal (keyed by session, `executionId`, and nested
 * key) decides what that rerun means:
 *
 *   - completed or failed before the crash → the recorded outcome, nothing runs;
 *   - started but unfinished, replay-safe or idempotent → run again;
 *   - started but unfinished, unsafe → outcome_unknown (a nested call, whose
 *     caller runs again).
 *
 * An unsafe call the model made is never run again by libfx: the model is
 * told it may have partly run, and when the turn ends the journal records
 * its outcome as unknown.
 *
 * A fresh call runs `beforeTool`, records its intent, runs, then commits its
 * result together with its document writes.
 */

/** The tools one agent can run, with its hooks. */
export interface ToolSet {
  readonly byName: ReadonlyMap<string, DurableTool>
  readonly hooks: ToolHooks | undefined
}

/** What libfx passes as a turn's `context`: who the call is for. */
export const CallContext = Schema.Struct({
  agentId: Schema.String,
  submissionId: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String)
})
export type CallContext = typeof CallContext.Type
const decodeCallContext = Schema.decodeUnknownSync(CallContext)

export interface ToolExecutorInterface {
  /**
   * libfx descriptors for the tools a session store's agents are offered. A
   * call runs the calling agent's own code and hooks for that tool, as its
   * tool set is at the time of the call.
   */
  readonly hostTools: (offered: ReadonlyArray<DurableTool>) => ReadonlyArray<FxHostTool>
}

export class ToolExecutor extends Context.Service<ToolExecutor, ToolExecutorInterface>()("fx-durable/ToolExecutor") {}

const MAX_PROGRESS_CHARS = 64 * 1024
const PROGRESS_MS = 100

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

export const unknownOutcomeNotice = (tool: string, input: Json): string =>
  [
    `The previous \`${tool}\` operation was interrupted.`,
    `Input: ${JSON.stringify(input)}`,
    "It may or may not have completed successfully.",
    "Do not repeat it blindly.",
    "Inspect the current system state before deciding what to do."
  ].join("\n")

const callIdOf = (key: ToolCallKey) => (key.callKey ? `${key.sessionId}/${key.executionId}/${key.callKey}` : `${key.sessionId}/${key.executionId}`)

/** Where a call runs: one model call (`executionId`) of one agent's session. */
interface CallScope extends ToolSet {
  readonly agentId: string
  readonly sessionId: string
  readonly executionId: string
  readonly submissionId: string | null
  readonly cwd: string | null
}

interface Caller {
  readonly tool: string
  readonly key: ToolCallKey
}

export const layer = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    const database = yield* Database
    const crash = yield* CrashInjector
    const registry = yield* ToolRegistry

    const read = <A>(f: Parameters<typeof database.read<A>>[0]) => Effect.runPromise(database.read(f))
    const hit = (point: string, name: string) => Effect.runPromise(crash.hit(point, { name }))

    const hookContext = (scope: CallScope, signal: AbortSignal): ToolHookContext => ({
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      executionId: scope.executionId,
      submissionId: scope.submissionId,
      signal
    })

    /** The outcome a call already has in the journal, if it settled. */
    const settled = (record: ToolCallRecord): Json => {
      const callId = callIdOf(record)
      switch (record.state) {
        case "completed":
          return record.output
        case "failed":
          throw new ToolExecutionError({ callId, tool: record.name, message: record.error ?? "tool failed" })
        case "outcome_unknown":
          throw new UnknownOutcomeError({ callId, tool: record.name, message: unknownOutcomeNotice(record.name, record.input) })
        case "running":
          throw new Error("unreachable: a running call has not settled")
      }
    }

    /** Calls running in this process, by `callIdOf` (a call from a dead process is not among them). */
    const live = new Set<string>()

    /**
     * libfx (until a release that stores an idempotent call before running it)
     * can lose a call a crash cut off right as it started: the continued turn
     * asks the model again, which calls again under a new `executionId`. Such a
     * call takes over the journal entry of the lost one, matched by request,
     * tool, and input, so its nested calls and idempotency key carry over.
     */
    const lostCall = async (scope: CallScope, tool: DurableTool, input: Json): Promise<ToolCallRecord | undefined> => {
      if (scope.submissionId === null) return undefined
      const running = await read((storage) => storage.runningToolCalls())
      return running.find(
        (row) =>
          row.callKey === "" &&
          row.agentId === scope.agentId &&
          row.sessionId === scope.sessionId &&
          row.submissionId === scope.submissionId &&
          row.executionId !== scope.executionId &&
          row.name === tool.name &&
          canonicalJson(row.input) === canonicalJson(input) &&
          !live.has(callIdOf(row))
      )
    }

    /** Run one call: the model's (`callKey` ""), or a nested one. */
    const call = async (scope: CallScope, tool: DurableTool, requested: Json, callKey: string, caller: Caller | null, signal: AbortSignal): Promise<Json> => {
      if (callKey === "") {
        const lost = await lostCall(scope, tool, requested)
        if (lost) return call({ ...scope, executionId: lost.executionId }, tool, requested, "", caller, signal)
      }
      const key: ToolCallKey = { sessionId: scope.sessionId, executionId: scope.executionId, callKey }
      const existing = await read((storage) => storage.getToolCall(key))
      if (existing) {
        if (existing.name !== tool.name || (caller && canonicalJson(existing.input) !== canonicalJson(requested))) {
          throw new ToolExecutionError({
            callId: callIdOf(key),
            tool: tool.name,
            message: `nested call key ${callKey} was used by another call (${existing.name}); give each call its own key`
          })
        }
        if (existing.state !== "running") return settled(existing)
        // It started before a crash.
        if (policyName(tool.replay) === "unsafe") {
          database.runSync((journal) => journal.markToolCallUnknown(key, "process_terminated"))
          return settled({ ...existing, state: "outcome_unknown" })
        }
        const restarted = database.runSync((journal) => journal.restartToolCall(key))
        return run(scope, tool, restarted.input, restarted, caller, signal)
      }

      const request: ToolCall = { name: tool.name, input: requested, caller: caller ? { tool: caller.tool, callId: callIdOf(caller.key) } : null }
      const decision = scope.hooks?.beforeTool ? await scope.hooks.beforeTool(request, hookContext(scope, signal)) : undefined
      if (decision && "block" in decision) throw new ToolBlockedError({ tool: tool.name, message: decision.block })
      const input = decision ? decision.input : requested
      const record = database.runSync((journal) =>
        journal.startToolCall({
          ...key,
          agentId: scope.agentId,
          submissionId: scope.submissionId,
          name: tool.name,
          input,
          replayPolicy: policyName(tool.replay),
          idempotencyKey: idempotencyKeyFor(tool.replay, callIdOf(key), input)
        })
      )
      await hit("tool.after-intent", tool.name)
      return run(scope, tool, input, record, caller, signal)
    }

    /** Execute a journaled call and record how it ended. */
    const run = async (scope: CallScope, tool: DurableTool, input: Json, record: ToolCallRecord, caller: Caller | null, signal: AbortSignal): Promise<Json> => {
      const key: ToolCallKey = record
      const callId = callIdOf(key)
      live.add(callId)
      try {
        return await execute(scope, tool, input, record, caller, signal, key, callId)
      } finally {
        live.delete(callId)
      }
    }

    const execute = async (
      scope: CallScope,
      tool: DurableTool,
      input: Json,
      record: ToolCallRecord,
      caller: Caller | null,
      signal: AbortSignal,
      key: ToolCallKey,
      callId: string
    ): Promise<Json> => {
      let finished = false

      // Nested calls: each a journaled call of its own, under this one's key.
      const nestedAbort = new AbortController()
      const nested = new Set<Promise<Json>>()
      let ordinal = 0
      const executeTool = (name: string, nestedInput: Json, options: NestedCallOptions = {}): Promise<Json> => {
        if (finished) return Promise.reject(new Error(`${tool.name} has returned; it can no longer call ${name}`))
        const target = scope.byName.get(name)
        const nestedKey = `${key.callKey ? `${key.callKey}/` : ""}${options.key ?? String(ordinal++)}`
        if (!target || target.callers === "model") {
          return Promise.reject(new ToolExecutionError({ callId, tool: name, message: `no tool named ${name} can be called from a tool` }))
        }
        const promise = call(scope, target, nestedInput, nestedKey, { tool: tool.name, key }, AbortSignal.any([signal, nestedAbort.signal]))
        nested.add(promise)
        promise.finally(() => nested.delete(promise)).catch(() => undefined)
        return promise
      }

      // Document writes, staged in call order and committed with the result.
      type Step = (value: JsonObject) => JsonObject
      const staged = new Map<string, { readonly document: DurableDocument<JsonObject>; readonly steps: Array<Step> }>()
      const ownerOf = (document: DurableDocument<JsonObject>) => (document.scope === "agent" ? scope.agentId : null)
      const readDocument = async <T extends JsonObject>(document: DurableDocument<T>): Promise<T> => {
        const stored = await read((storage) => storage.getDocument(ownerOf(document), document.kind))
        const steps = staged.get(`${document.scope}:${document.kind}`)?.steps ?? []
        return ownValue(document, steps.reduce<JsonObject>((value, step) => step(value), documentValue(document, stored)))
      }
      const documents: DocumentAccess = {
        get: (document) => readDocument(document),
        update: async (document, update) => {
          if (finished) throw new Error(`${tool.name} has returned; it can no longer update ${document.kind}`)
          // Fail here, in the tool, rather than at commit.
          const value = applyUpdate(document, await readDocument(document), update)
          const stageKey = `${document.scope}:${document.kind}`
          const entry = staged.get(stageKey) ?? { document, steps: [] }
          entry.steps.push((current) => applyUpdate(document, ownValue(document, current), update))
          staged.set(stageKey, entry)
          return value
        }
      }

      // Output reported while it runs, journaled at most every PROGRESS_MS.
      let progress = ""
      let pending: ReturnType<typeof setTimeout> | null = null
      const flush = () => {
        pending = null
        try {
          database.runSync((journal) => journal.recordProgress(key, progress))
        } catch {
          // Progress is best-effort; a storage failure is reported by the next durable write.
        }
      }
      const reportProgress = (chunk: string) => {
        if (finished || chunk.length === 0) return
        progress = (progress + chunk).slice(-MAX_PROGRESS_CHARS)
        pending ??= setTimeout(flush, PROGRESS_MS)
      }

      const settle = async () => {
        finished = true
        if (pending) clearTimeout(pending)
        nestedAbort.abort()
        await Promise.allSettled(nested)
      }

      let output: Json
      try {
        const running = Promise.resolve().then(() =>
          tool.run(input, {
            agentId: scope.agentId,
            sessionId: scope.sessionId,
            executionId: scope.executionId,
            submissionId: scope.submissionId,
            cwd: scope.cwd,
            idempotencyKey: record.idempotencyKey,
            signal,
            replay: record.attempts > 1,
            progress: reportProgress,
            executeTool,
            documents
          })
        )
        running.catch(() => undefined)
        await hit("tool.during-execute", tool.name)
        output = await running
      } catch (cause) {
        await settle()
        if (cause instanceof OutcomeUnknown || (signal.aborted && policyName(tool.replay) === "unsafe")) {
          const reason = cause instanceof OutcomeUnknown ? cause.reason : "cancelled"
          database.runSync((journal) => journal.markToolCallUnknown(key, reason))
          throw new UnknownOutcomeError({ callId, tool: tool.name, message: unknownOutcomeNotice(tool.name, input) })
        }
        if (cause instanceof ToolExecutionError || cause instanceof UnknownOutcomeError || cause instanceof ToolBlockedError) {
          // A nested call's failure the tool let through: this call failed too, with that message.
          database.runSync((journal) => journal.failToolCall(key, cause.message))
          throw cause
        }
        const message = errorMessage(cause)
        database.runSync((journal) => journal.failToolCall(key, message))
        throw new ToolExecutionError({ callId, tool: tool.name, message, cause })
      }
      await settle()
      await hit("tool.after-execute", tool.name)

      // A failing afterTool keeps the original result: the effect already happened.
      const afterTool = scope.hooks?.afterTool
      if (afterTool) {
        const request: ToolCall = { name: tool.name, input, caller: caller ? { tool: caller.tool, callId: callIdOf(caller.key) } : null }
        const replaced = await Promise.resolve()
          .then(() => afterTool(request, output, hookContext(scope, signal)))
          .catch(() => undefined)
        if (replaced !== undefined) output = replaced
      }

      const writes: ReadonlyArray<StagedDocumentWrite> = [...staged.values()].map(({ document, steps }) => ({
        document,
        agentId: ownerOf(document),
        updates: [(draft: JsonObject) => steps.reduce<JsonObject>((value, step) => step(value), draft)]
      }))
      try {
        database.runSync((journal) => journal.completeToolCall(key, output, writes))
      } catch (cause) {
        if (!(cause instanceof DocumentUpdateFailed)) throw cause
        database.runSync((journal) => journal.failToolCall(key, cause.message))
        throw new ToolExecutionError({ callId, tool: tool.name, message: cause.message, cause })
      }
      await hit("tool.after-result-persist", tool.name)
      return output
    }

    /** The calling agent's tool set now, and its version of `tool`. */
    const resolve = async (agentId: string, tool: DurableTool) => {
      const agent = await read((storage) => storage.getAgent(agentId))
      if (!agent) throw new Error(`agent ${agentId} does not exist`)
      const current = await Effect.runPromise(registry.toolSet(agent))
      // A tool the agent no longer has finishes with the definition its turn started with.
      return { tools: current, tool: current.byName.get(tool.name) ?? tool }
    }

    const hostTools = (offered: ReadonlyArray<DurableTool>): ReadonlyArray<FxHostTool> =>
      offered.map(
        (descriptor): FxHostTool => ({
          name: descriptor.name,
          description: descriptor.description,
          inputSchema: descriptor.jsonSchema,
          // libfx starts an idempotent call before storing it, so after a crash it may ask the model
          // again instead of rerunning the call: fine for a call that may run twice. An unsafe call
          // is stored before it starts, and libfx never reruns it.
          idempotent: policyName(descriptor.replay) !== "unsafe",
          writes: descriptor.writes,
          execute: async (input: Json, context: FxToolContext) => {
            try {
              const who = decodeCallContext(context.context)
              const { tools, tool } = await resolve(who.agentId, descriptor)
              const scope: CallScope = { byName: tools.byName, hooks: tools.hooks, ...who, sessionId: context.sessionId, executionId: context.executionId }
              return await call(scope, tool, input, "", null, context.signal)
            } catch (cause) {
              // libfx hands the model the message of what the tool throws.
              throw new Error(errorMessage(cause))
            }
          }
        })
      )

    return ToolExecutor.of({ hostTools })
  })
)
