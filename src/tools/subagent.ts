import { Schema } from "effect"
import type { DurableFx } from "../runtime/durable-fx.js"
import { defineDurableTool, type DurableTool } from "./define-tool.js"

/**
 * Subagents: a tool that hands a task to a child durable agent and returns its
 * answer.
 *
 * The child's agent id and its request id both come from the call's
 * idempotency key, which is stable across runs of the call. If a crash cuts
 * the call off, libfx runs it again when the parent's turn continues, and the
 * call attaches to the same child and the same request. The child's own turn
 * continues like any agent's. One task, one subagent, no matter how many times
 * the processes die. Cancelling the parent's turn cancels the child's request.
 */

export interface SubagentDefinition {
  /** The tool name the model calls. */
  readonly name: string
  /** When the model should delegate to this subagent. */
  readonly description: string
  /** Runtime id the child runs with (its tools and instructions), registered on the same DurableFx. */
  readonly runtime: string
  /** The child's model. Defaults to the parent agent's model. */
  readonly model?: string
}

const SubagentInput = Schema.Struct({ task: Schema.String })
const decodeInput = Schema.decodeUnknownSync(SubagentInput)

/** Tools that need the DurableFx they run in, bound by `DurableFx.open()` and `registerRuntime()`. */
const binders = new WeakMap<DurableTool, (fx: DurableFx) => void>()

export const bindTools = (fx: DurableFx, tools: ReadonlyArray<DurableTool>): void => {
  for (const tool of tools) binders.get(tool)?.(fx)
}

/** The child agent id for one subagent call: `call` is the model's call id (and nested key, if any). */
export const subagentId = (parentAgentId: string, name: string, call: string) => `${parentAgentId}/${name}/${call}`

/** A call's id without its session: the model's call id, then its nested key. */
export const callPath = (sessionId: string, callId: string) => (callId.startsWith(`${sessionId}/`) ? callId.slice(sessionId.length + 1) : callId)

/** Declare a subagent tool. Add it to a runtime's `tools` like any other. */
export const defineSubagent = (definition: SubagentDefinition): DurableTool => {
  let bound: DurableFx | null = null
  const tool = defineDurableTool({
    name: definition.name,
    description: definition.description,
    // The key is stable across runs; it names the child and its request.
    replay: { strategy: "idempotent" },
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "The task for the subagent, with all the context it needs" } },
      required: ["task"]
    },
    execute: async (input, context) => {
      const fx = bound
      if (!fx) throw new Error(`subagent ${definition.name} is not part of an open DurableFx runtime`)
      const { task } = decodeInput(input)
      const key = context.idempotencyKey ?? `${context.sessionId}/${context.executionId}`
      const parent = await (await fx.attach(context.agentId)).info()
      const childId = subagentId(context.agentId, definition.name, callPath(context.sessionId, key))
      const child = await fx.agent(childId, { runtime: definition.runtime, model: definition.model ?? parent.model, cwd: parent.cwd })
      const submission = await child.submit(task, { requestId: key })

      const cancel = () => void submission.cancel().catch(() => undefined)
      context.signal.addEventListener("abort", cancel, { once: true })
      // Relay what the child says as this call's progress.
      void (async () => {
        for await (const event of submission.events()) {
          if (event.type === "text_delta") context.progress(event.delta)
        }
      })().catch(() => undefined)
      try {
        const result = await submission.result()
        return { agentId: childId, text: result.text }
      } finally {
        context.signal.removeEventListener("abort", cancel)
      }
    }
  })
  binders.set(tool, (fx) => {
    bound = fx
  })
  return tool
}
