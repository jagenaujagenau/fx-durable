import { Schema } from "effect"
import type { DurableFx } from "../runtime/durable-fx.js"
import { defineDurableTool, type DurableTool } from "./define-tool.js"

/**
 * Subagents: a tool that hands a task to a child durable agent and returns its
 * answer.
 *
 * The child's agent ID and its submission's request ID both come from the
 * call's idempotency key. After a crash, the recovered turn calls the tool
 * again (it is `resumeOnCall`, so recovery does not block on it), and the call
 * attaches to the same child and the same submission. The child's own
 * interrupted work is recovered like any agent's. One task, one subagent, no
 * matter how many times the processes die.
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

/** The child agent id for one subagent call. */
export const subagentId = (parentAgentId: string, name: string, key: string) => `${parentAgentId}/${name}/${key}`

/** Declare a subagent tool. Add it to a runtime's `tools` like any other. */
export const defineSubagent = (definition: SubagentDefinition): DurableTool => {
  let bound: DurableFx | null = null
  const tool = defineDurableTool({
    name: definition.name,
    description: definition.description,
    // The key is stable across retries; it names the child and its request.
    replay: { strategy: "idempotent" },
    resumeOnCall: true,
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "The task for the subagent, with all the context it needs" } },
      required: ["task"]
    },
    execute: async (input, context) => {
      const fx = bound
      if (!fx) throw new Error(`subagent ${definition.name} is not part of an open DurableFx runtime`)
      const { task } = decodeInput(input)
      const key = context.idempotencyKey ?? context.taskId
      const parent = await (await fx.attach(context.agentId)).info()
      const childId = subagentId(context.agentId, definition.name, key)
      const child = await fx.agent(childId, { runtime: definition.runtime, model: definition.model ?? parent.model, cwd: parent.cwd })
      const submission = await child.submit(task, { requestId: key })

      const cancel = () => void submission.cancel().catch(() => undefined)
      context.signal.addEventListener("abort", cancel, { once: true })
      // Relay what the child says as this call's progress.
      void (async () => {
        for await (const event of submission.events()) {
          const text = event.payload.text
          if (event.type === "model.completed" && Schema.is(Schema.String)(text) && text.length > 0) context.progress(`${text}\n`)
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
