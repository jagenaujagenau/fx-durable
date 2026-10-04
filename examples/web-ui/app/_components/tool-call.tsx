"use client"

import { getToolOrDynamicToolName, type DynamicToolUIPart, type ToolUIPart } from "ai"
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  FileEditIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderTreeIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  SearchIcon,
  ShieldQuestionIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XCircleIcon
} from "lucide-react"
import type { ReactNode } from "react"
import type { BundledLanguage } from "shiki"
import { z } from "zod"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { Tool, ToolContent } from "@/components/ai-elements/tool"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  BashInput,
  BashOutput,
  EditInput,
  ReadInput,
  ReadOutput,
  SearchInput,
  TodoInput,
  WriteInput,
  type PendingApproval,
  type Todo
} from "./schemas"

export type ToolPart = ToolUIPart | DynamicToolUIPart
export type ApprovalDecision = "allow" | "allow-session" | "deny"

const LANGUAGES = new Map<string, BundledLanguage>([
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "jsx"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["tsx", "tsx"],
  ["json", "json"],
  ["md", "markdown"],
  ["css", "css"],
  ["html", "html"],
  ["py", "python"],
  ["sh", "bash"],
  ["yml", "yaml"],
  ["yaml", "yaml"],
  ["toml", "toml"],
  ["go", "go"],
  ["rs", "rust"],
  ["sql", "sql"],
  ["env", "dotenv"]
])

export const languageOf = (path: string): BundledLanguage => LANGUAGES.get(path.split(".").at(-1)?.toLowerCase() ?? "") ?? "log"

interface ToolLabel {
  readonly icon: ReactNode
  readonly verb: string
  readonly argument: string
}

/** Claude Code-style label: Verb(argument). */
const describe = (part: ToolPart): ToolLabel => {
  const input = part.input
  switch (getToolOrDynamicToolName(part)) {
    case "bash":
      return { icon: <TerminalIcon />, verb: "Bash", argument: BashInput.safeParse(input).data?.command ?? "" }
    case "read_file":
      return { icon: <FileTextIcon />, verb: "Read", argument: ReadInput.safeParse(input).data?.path ?? "" }
    case "edit_file":
      return { icon: <FileEditIcon />, verb: "Update", argument: EditInput.safeParse(input).data?.path ?? "" }
    case "write_file":
      return { icon: <FilePlusIcon />, verb: "Write", argument: WriteInput.safeParse(input).data?.path ?? "" }
    case "grep":
      return { icon: <SearchIcon />, verb: "Search", argument: SearchInput.safeParse(input).data?.pattern ?? "" }
    case "glob":
      return { icon: <SearchIcon />, verb: "Glob", argument: SearchInput.safeParse(input).data?.pattern ?? "" }
    case "list_files":
      return { icon: <FolderTreeIcon />, verb: "List", argument: SearchInput.safeParse(input).data?.path ?? "." }
    case "todo_write":
      return { icon: <ListChecksIcon />, verb: "Update Todos", argument: "" }
    default:
      return { icon: <WrenchIcon />, verb: getToolOrDynamicToolName(part), argument: "" }
  }
}

const StatusIcon = ({ part, waiting }: { part: ToolPart; waiting: boolean }) => {
  if (waiting) return <ShieldQuestionIcon className="size-4 text-amber-500" />
  switch (part.state) {
    case "output-available":
      return <CheckCircle2Icon className="size-4 text-emerald-500" />
    case "output-error":
      return part.errorText?.includes("outcome unknown") ? (
        <TriangleAlertIcon className="size-4 text-amber-500" />
      ) : (
        <XCircleIcon className="size-4 text-red-500" />
      )
    case "input-available":
      return <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
    default:
      return <CircleDashedIcon className="size-4 text-muted-foreground" />
  }
}

/** Line diff of an edit: unchanged leading/trailing lines as context, the middle as -/+. */
export const Diff = ({ before, after }: { before: string; after: string }) => {
  const a = before.split("\n")
  const b = after.split("\n")
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const rows: Array<{ kind: " " | "-" | "+"; text: string }> = [
    ...a.slice(0, start).map((text) => ({ kind: " " as const, text })),
    ...a.slice(start, endA).map((text) => ({ kind: "-" as const, text })),
    ...b.slice(start, endB).map((text) => ({ kind: "+" as const, text })),
    ...a.slice(endA).map((text) => ({ kind: " " as const, text }))
  ]
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/30 py-2 font-mono text-xs leading-5">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn(
            "px-3",
            row.kind === "-" && "bg-red-500/10 text-red-700 dark:text-red-300",
            row.kind === "+" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          )}
        >
          <span className="mr-3 select-none opacity-50">{row.kind}</span>
          {row.text || " "}
        </div>
      ))}
    </pre>
  )
}

export const TodoList = ({ todos }: { todos: ReadonlyArray<Todo> }) => (
  <ul className="space-y-1.5 text-sm">
    {todos.map((todo, i) => (
      <li key={i} className="flex items-start gap-2">
        {todo.status === "completed" ? (
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        ) : todo.status === "in_progress" ? (
          <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-blue-500" />
        ) : (
          <CircleDashedIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <span className={cn(todo.status === "completed" && "text-muted-foreground line-through", todo.status === "in_progress" && "font-medium")}>
          {todo.content}
        </span>
      </li>
    ))}
  </ul>
)

const Output = ({ name, part }: { name: string; part: ToolPart }) => {
  const input = part.input
  const output = part.state === "output-available" ? part.output : undefined

  if (name === "bash") {
    const result = BashOutput.safeParse(output).data
    return (
      <div className="overflow-hidden rounded-md border bg-zinc-950 font-mono text-xs text-zinc-100">
        <div className="flex items-center justify-between border-zinc-800 border-b px-3 py-1.5 text-zinc-400">
          <span>$ {BashInput.safeParse(input).data?.command}</span>
          {result && (
            <span className={result.exitCode === 0 ? "text-emerald-400" : "text-red-400"}>
              {result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`}
            </span>
          )}
        </div>
        {result ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3">
            {result.stdout}
            {result.stderr && <span className="text-red-300">{result.stderr}</span>}
            {!result.stdout && !result.stderr && <span className="text-zinc-500">(no output)</span>}
          </pre>
        ) : (
          part.state === "input-available" && <div className="p-3 text-zinc-500">running…</div>
        )}
      </div>
    )
  }
  if (name === "edit_file") {
    const edit = EditInput.safeParse(input).data
    return edit ? <Diff before={edit.old_string} after={edit.new_string} /> : null
  }
  if (name === "write_file") {
    const write = WriteInput.safeParse(input).data
    return write ? <CodeBlock code={write.content} language={languageOf(write.path)} showLineNumbers /> : null
  }
  if (name === "read_file") {
    const read = ReadOutput.safeParse(output).data
    return read ? <CodeBlock code={read.content} language="log" /> : null
  }
  if (name === "todo_write") {
    const todos = TodoInput.safeParse(input).data?.todos
    return todos ? <TodoList todos={todos} /> : null
  }
  if (output === undefined) return null
  const text = z.string().safeParse(output).data
  return text !== undefined ? <CodeBlock code={text} language="log" /> : <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
}

const summaryOf = (name: string, part: ToolPart): string | null => {
  if (part.state !== "output-available") return null
  const output = part.output
  if (name === "read_file") {
    const read = ReadOutput.safeParse(output).data
    return read ? `${read.totalLines} lines` : null
  }
  if (name === "bash") {
    const result = BashOutput.safeParse(output).data
    return result ? (result.exitCode === 0 ? "ok" : `exit ${result.exitCode ?? "?"}`) : null
  }
  return null
}

/** The pending permission prompt for a running tool call, matched by tool name and input. */
export const approvalFor = (part: ToolPart, approvals: ReadonlyArray<PendingApproval>) => {
  if (part.state !== "input-available") return undefined
  const input = JSON.stringify(part.input)
  return approvals.find((a) => a.tool === getToolOrDynamicToolName(part) && JSON.stringify(a.input) === input)
}

export const ApprovalPrompt = ({
  approval,
  onDecide
}: {
  approval: PendingApproval
  onDecide: (approvalId: string, decision: ApprovalDecision) => void
}) => {
  const label = approval.category === "exec" ? "Run this command?" : "Make this edit?"
  const always = approval.category === "exec" ? `Yes, and don't ask again for ${approval.tool} this session` : "Yes, and allow all edits this session"
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="font-medium text-sm">{label}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onDecide(approval.approvalId, "allow")}>
          Yes <kbd className="ml-1 opacity-60">↵</kbd>
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onDecide(approval.approvalId, "allow-session")}>
          {always}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide(approval.approvalId, "deny")}>
          No, tell the agent what to do instead <kbd className="ml-1 opacity-60">esc</kbd>
        </Button>
      </div>
    </div>
  )
}

export const ToolCall = ({
  part,
  approval,
  onDecide
}: {
  part: ToolPart
  approval?: PendingApproval
  onDecide: (approvalId: string, decision: ApprovalDecision) => void
}) => {
  const name = getToolOrDynamicToolName(part)
  const { icon, verb, argument } = describe(part)
  const summary = summaryOf(name, part)
  const errorText = part.state === "output-error" ? part.errorText : undefined
  // Edits, writes, todos and anything waiting for permission open by default, like Claude Code.
  const openByDefault = approval !== undefined || name === "edit_file" || name === "todo_write" || name === "bash" || errorText !== undefined

  return (
    <Tool defaultOpen={openByDefault} className="mb-2 bg-card">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
        <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        <span className="font-medium">{verb}</span>
        {argument && <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{argument}</code>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {summary && <span className="text-muted-foreground text-xs">{summary}</span>}
          {approval && (
            <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400">
              needs permission
            </Badge>
          )}
          <StatusIcon part={part} waiting={approval !== undefined} />
        </span>
      </CollapsibleTrigger>
      <ToolContent className="space-y-3 px-3 pt-0 pb-3">
        {approval && <ApprovalPrompt approval={approval} onDecide={onDecide} />}
        <Output name={name} part={part} />
        {errorText && (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-sm",
              errorText.includes("outcome unknown")
                ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                : "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300"
            )}
          >
            {errorText.includes("outcome unknown")
              ? "Interrupted by a crash. fx-durable cannot know whether it took effect, so it will not run it again automatically."
              : errorText}
          </div>
        )}
      </ToolContent>
    </Tool>
  )
}
