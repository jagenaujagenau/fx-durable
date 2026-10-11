import type { SubmissionKind, SubmissionRecord, TaskRecord, TaskState, TaskType } from "./schema.js"
import { subagentId } from "../tools/subagent.js"

/**
 * Live work across agents as one graph, for task panels and debugging. Built
 * from the journal, so it shows what is committed: a task appears once its
 * intent is journaled and leaves when it settles.
 */

export interface TaskGraphNode {
  readonly id: string
  readonly agentId: string
  readonly turnId: string
  /** `turn` is a turn's own task; `model`, `tool`, and `checkpoint` run inside it. */
  readonly type: TaskType
  /** The tool or model name. */
  readonly name: string | null
  readonly state: TaskState
  /**
   * The node this one runs for: a nested call's calling tool, a subagent
   * turn's subagent tool call, otherwise its turn. Null for a top-level turn.
   */
  readonly owner: string | null
  readonly startedAt: Date | null
}

export interface QueuedWork {
  readonly agentId: string
  readonly submissionId: string
  readonly kind: SubmissionKind
}

export interface TaskGraph {
  /** Running work, owners before the nodes they own. */
  readonly nodes: ReadonlyArray<TaskGraphNode>
  /** Requests waiting for their agent, oldest first per agent. */
  readonly queued: ReadonlyArray<QueuedWork>
}

export const buildTaskGraph = (live: ReadonlyArray<TaskRecord>, submissions: ReadonlyArray<SubmissionRecord>): TaskGraph => {
  const turnTask = new Map<string, string>()
  for (const task of live) if (task.type === "turn") turnTask.set(task.turnId, task.id)

  // A subagent's turn runs for the tool call that started it (its id is derived from the call's key).
  const subagentCall = new Map<string, string>()
  for (const task of live) {
    if (task.type === "tool" && task.name && task.idempotencyKey) subagentCall.set(subagentId(task.agentId, task.name, task.idempotencyKey), task.id)
  }

  const ownerOf = (task: TaskRecord): string | null => {
    if (task.type === "turn") return subagentCall.get(task.agentId) ?? null
    if (task.callerTaskId) return task.callerTaskId
    return turnTask.get(task.turnId) ?? null
  }

  const nodes = live.map(
    (task): TaskGraphNode => ({
      id: task.id,
      agentId: task.agentId,
      turnId: task.turnId,
      type: task.type,
      name: task.name,
      state: task.state,
      owner: ownerOf(task),
      startedAt: task.startedAt
    })
  )

  // Owners first: a node is placed once its owner has been (or its owner is not live).
  const ids = new Set(nodes.map((node) => node.id))
  const placed = new Set<string>()
  const ordered: Array<TaskGraphNode> = []
  let remaining = nodes
  while (remaining.length > 0) {
    const ready = remaining.filter((node) => node.owner === null || !ids.has(node.owner) || placed.has(node.owner))
    // A cycle cannot come from the journal; place the rest as they are rather than loop.
    const batch = ready.length > 0 ? ready : remaining
    for (const node of batch) {
      ordered.push(node)
      placed.add(node.id)
    }
    remaining = remaining.filter((node) => !placed.has(node.id))
  }

  const queued = submissions
    .filter((s) => s.state === "queued")
    .map((s): QueuedWork => ({ agentId: s.agentId, submissionId: s.id, kind: s.kind }))
  return { nodes: ordered, queued }
}
