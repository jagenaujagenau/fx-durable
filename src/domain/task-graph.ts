import type { SubmissionRecord, ToolCallRecord } from "./schema.js"
import { callPath, subagentId } from "../tools/subagent.js"

/**
 * Running work across agents as one graph, for task panels and debugging.
 * Built from fx-durable's records: requests still running, and the tool
 * calls running inside them, nested calls and subagents included.
 */

export interface TaskGraphNode {
  /** A request's id, or a tool call's (`session/execution[/key]`). */
  readonly id: string
  readonly agentId: string
  readonly type: "request" | "tool"
  /** The tool name, for a tool call. */
  readonly name: string | null
  /**
   * The node this one runs for: a nested call's calling tool, a subagent's
   * request's subagent call, a tool call's request. Null for a top-level
   * request, or when the owner is not known.
   */
  readonly owner: string | null
  readonly startedAt: Date
}

export interface TaskGraph {
  /** Running work, owners before the nodes they own. */
  readonly nodes: ReadonlyArray<TaskGraphNode>
}

const callId = (call: ToolCallRecord) =>
  call.callKey ? `${call.sessionId}/${call.executionId}/${call.callKey}` : `${call.sessionId}/${call.executionId}`

const parentKey = (key: string) => (key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "")

export const buildTaskGraph = (calls: ReadonlyArray<ToolCallRecord>, requests: ReadonlyArray<SubmissionRecord>): TaskGraph => {
  // A subagent's request runs for the call that started it (its agent id comes from the call's execution id).
  const subagentCall = new Map<string, string>()
  for (const call of calls) {
    subagentCall.set(subagentId(call.agentId, call.name, callPath(call.sessionId, call.idempotencyKey ?? callId(call))), callId(call))
  }

  const nodes: Array<TaskGraphNode> = [
    ...requests.map(
      (request): TaskGraphNode => ({
        id: request.id,
        agentId: request.agentId,
        type: "request",
        name: null,
        owner: subagentCall.get(request.agentId) ?? null,
        startedAt: request.createdAt
      })
    ),
    ...calls.map(
      (call): TaskGraphNode => ({
        id: callId(call),
        agentId: call.agentId,
        type: "tool",
        name: call.name,
        owner: call.callKey ? callId({ ...call, callKey: parentKey(call.callKey) }) : call.submissionId,
        startedAt: call.startedAt
      })
    )
  ]

  // Owners first: a node is placed once its owner has been (or its owner is not running).
  const ids = new Set(nodes.map((node) => node.id))
  const placed = new Set<string>()
  const ordered: Array<TaskGraphNode> = []
  let remaining = nodes
  while (remaining.length > 0) {
    const ready = remaining.filter((node) => node.owner === null || !ids.has(node.owner) || placed.has(node.owner))
    // A cycle cannot come from the records; place the rest as they are rather than loop.
    const batch = ready.length > 0 ? ready : remaining
    for (const node of batch) {
      ordered.push(node)
      placed.add(node.id)
    }
    remaining = remaining.filter((node) => !placed.has(node.id))
  }
  return { nodes: ordered }
}
