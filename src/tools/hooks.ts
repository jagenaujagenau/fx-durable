import type { Json } from "../domain/json.js"

/** A tool call as the model made it. */
export interface ToolCall {
  readonly name: string
  readonly input: Json
}

export interface ToolHookContext {
  readonly agentId: string
  readonly submissionId: string
  readonly turnId: string
  /** Aborted when the turn is cancelled or its executor stops. */
  readonly signal: AbortSignal
}

/**
 * What `beforeTool` decides. Return nothing to run the call as it is,
 * `{ block }` to refuse it (the model receives the message as the tool's
 * error), or `{ input }` to run it with different input.
 */
export type BeforeToolDecision = { readonly block: string } | { readonly input: Json } | undefined

/**
 * Hooks around fresh tool calls, declared on a runtime.
 *
 * `beforeTool` runs before the call's intent is journaled, so a call it is
 * still deciding about has not started: a crash during a slow decision (such
 * as a permission prompt) leaves no task behind, and the recovered turn asks
 * again. Replays of interrupted calls skip it, because their intent was only
 * journaled after it allowed them. Calls answered from the journal skip both
 * hooks.
 */
export interface ToolHooks {
  readonly beforeTool?: (call: ToolCall, context: ToolHookContext) => BeforeToolDecision | Promise<BeforeToolDecision>
  /**
   * Runs after a fresh call succeeds, before its result is journaled; return
   * a value to replace the result. If it throws, the original result is kept:
   * the effect has already happened.
   */
  readonly afterTool?: (call: ToolCall, output: Json, context: ToolHookContext) => Json | undefined | Promise<Json | undefined>
}
