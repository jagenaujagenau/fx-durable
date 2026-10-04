import { z } from "zod"

/** Server payloads, parsed at the client boundary. */

export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"])
export type PermissionMode = z.infer<typeof PermissionMode>

export const Config = z.object({
  pid: z.number(),
  offline: z.boolean(),
  defaultModel: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string(), provider: z.string() }))
})
export type Config = z.infer<typeof Config>

export const SessionSummary = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  model: z.string(),
  state: z.string(),
  updatedAt: z.string()
})
export type SessionSummary = z.infer<typeof SessionSummary>
export const SessionList = z.object({ sessions: z.array(SessionSummary) })

export const PendingApproval = z.object({
  approvalId: z.string(),
  agentId: z.string(),
  tool: z.string(),
  category: z.enum(["read", "edit", "exec"]),
  input: z.json(),
  requestedAt: z.string()
})
export type PendingApproval = z.infer<typeof PendingApproval>

export const SessionDetails = SessionSummary.extend({
  mode: PermissionMode,
  pendingApprovals: z.array(PendingApproval),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), turns: z.number() }),
  runningSubmissionId: z.string().nullable()
})
export type SessionDetails = z.infer<typeof SessionDetails>

export const CreatedSession = z.object({ id: z.string(), cwd: z.string() })
export const ApiError = z.object({ error: z.string() })

export const JournalEvent = z.object({
  sequence: z.number(),
  type: z.string(),
  taskId: z.string().nullable(),
  at: z.string(),
  payload: z.object({
    tool: z.string().optional(),
    replay: z.union([z.string(), z.boolean()]).optional(),
    text: z.string().optional(),
    attempt: z.number().optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
    usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable() }).optional()
  })
})
export type JournalEvent = z.infer<typeof JournalEvent>

export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval-requested"), approval: PendingApproval }),
  z.object({ type: z.literal("approval-resolved"), approvalId: z.string(), decision: z.string() }),
  z.object({ type: z.literal("mode-changed"), mode: PermissionMode }),
  z.object({ type: z.literal("tool-progress"), taskId: z.string(), chunk: z.string() })
])

export const Hello = z.object({ pid: z.number() })

export interface FileNode {
  readonly name: string
  readonly path: string
  readonly children?: ReadonlyArray<FileNode>
}
const FileNodeSchema: z.ZodType<FileNode> = z.lazy(() =>
  z.object({ name: z.string(), path: z.string(), children: z.array(FileNodeSchema).optional() })
)
export const FileTreeResponse = z.object({ cwd: z.string(), tree: z.array(FileNodeSchema) })
export const FileContent = z.object({ path: z.string(), content: z.string().nullable(), size: z.number() })
export type FileContent = z.infer<typeof FileContent>

export const HistoryResponse = z.object({ messages: z.array(z.unknown()) })

// Tool inputs and outputs the UI renders specially.
export const BashInput = z.object({ command: z.string(), description: z.string().optional() })
export const BashOutput = z.object({ exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean() })
export const EditInput = z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() })
export const WriteInput = z.object({ path: z.string(), content: z.string() })
export const ReadInput = z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() })
export const ReadOutput = z.object({ path: z.string(), totalLines: z.number(), content: z.string() })
export const SearchInput = z.object({ pattern: z.string().optional(), path: z.string().optional() })
export const Todo = z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) })
export type Todo = z.infer<typeof Todo>
export const TodoInput = z.object({ todos: z.array(Todo) })
export const SubagentInput = z.object({ task: z.string() })
export const SubagentOutput = z.object({ agentId: z.string(), text: z.string() })
