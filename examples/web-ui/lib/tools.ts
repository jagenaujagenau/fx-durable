import { spawn } from "node:child_process"
import { glob as fsGlob, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { defineDurableTool, defineSubagent, type DurableTool, type DurableToolContext, type ToolHooks } from "fx-durable"
import { z } from "zod"
import { live, type ToolCategory } from "./live"

/**
 * The coding tools: Claude Code's core set, as durable tools.
 *
 * Replay policy is chosen per tool from what happens if it runs twice:
 * reads are safe; writes are idempotent (same content, or an edit that is
 * already applied); shell commands are unsafe, so an interrupted command is
 * reported as outcome unknown instead of being run again.
 */

export type WorkspaceResolver = (agentId: string) => Promise<string>

const MAX_OUTPUT = 30_000
const IGNORED = new Set([".git", "node_modules", ".next", ".data"])

const truncate = (text: string, max = MAX_OUTPUT) =>
  text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters truncated]` : text

/** Resolve a model-supplied path inside the workspace; refuse anything outside it. */
const inWorkspace = (root: string, path: string) => {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  const fromRoot = relative(root, absolute)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`${path} is outside the workspace (${root})`)
  return absolute
}

/** The server's environment without credentials (the gateway key, tokens, secrets). */
const SECRET = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i
const commandEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !SECRET.test(name))),
  NODE_ENV: process.env.NODE_ENV,
  CI: "1",
  FORCE_COLOR: "0"
})

const run = (command: string, cwd: string, signal: AbortSignal, timeoutMs: number, onOutput?: (chunk: string) => void) =>
  new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((done, fail) => {
    // Not a login shell: profile scripts must not change the directory or environment.
    const child = spawn("bash", ["-c", command], { cwd, env: commandEnv() })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const kill = () => child.kill("SIGTERM")
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    signal.addEventListener("abort", kill, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      onOutput?.(chunk.toString())
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
      onOutput?.(chunk.toString())
    })
    child.once("error", fail)
    child.once("close", (exitCode) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", kill)
      done({ exitCode, stdout: truncate(stdout), stderr: truncate(stderr), timedOut })
    })
  })

/** The tools of each runtime: the coding agent's, and the read-only explorer subagent's. */
export interface CodingToolset {
  readonly coding: ReadonlyArray<DurableTool>
  readonly explorer: ReadonlyArray<DurableTool>
}

export const createCodingTools = (workspaceOf: WorkspaceResolver): CodingToolset => {
  /** The workspace a tool works in. Permission is asked earlier, in the runtime's beforeTool hook. */
  const prepare = async (_tool: string, _category: ToolCategory, _input: z.core.util.JSONType, context: DurableToolContext) =>
    workspaceOf(context.agentId)

  const readFileTool = defineDurableTool({
    name: "read_file",
    description:
      "Read a text file from the workspace. Returns numbered lines (like `cat -n`). Use offset/limit for large files.",
    replay: "safe",
    // Observes the workspace: after a crash, read it again rather than reuse a stale answer.
    reuse: false,
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root"),
      offset: z.number().int().min(1).optional().describe("1-based line to start from"),
      limit: z.number().int().min(1).optional().describe("Number of lines to read (default 2000)")
    }),
    execute: async (input, context) => {
      const root = await prepare("read_file", "read", input, context)
      const lines = (await readFile(inWorkspace(root, input.path), "utf8")).split("\n")
      const start = (input.offset ?? 1) - 1
      const slice = lines.slice(start, start + (input.limit ?? 2000))
      const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line.slice(0, 2000)}`).join("\n")
      return { path: input.path, totalLines: lines.length, content: truncate(numbered) }
    }
  })

  const writeFileTool = defineDurableTool({
    name: "write_file",
    description: "Create or overwrite a file in the workspace with the given content. Prefer edit_file for changes to existing files.",
    replay: "safe",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root"),
      content: z.string().describe("The complete new file content")
    }),
    execute: async (input, context) => {
      const root = await prepare("write_file", "edit", input, context)
      const target = inWorkspace(root, input.path)
      const existed = await stat(target).then(() => true, () => false)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, input.content)
      return { path: input.path, created: !existed, bytes: Buffer.byteLength(input.content) }
    }
  })

  const editFileTool = defineDurableTool({
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. Read the file first.",
    replay: "safe",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the workspace root"),
      old_string: z.string().describe("Exact text to replace"),
      new_string: z.string().describe("Replacement text"),
      replace_all: z.boolean().optional().describe("Replace every occurrence (default false)")
    }),
    execute: async (input, context) => {
      const root = await prepare("edit_file", "edit", input, context)
      const target = inWorkspace(root, input.path)
      const original = await readFile(target, "utf8")
      const count = original.split(input.old_string).length - 1
      if (count === 0) {
        // Idempotent replay: the edit may have been applied before a crash.
        if (input.new_string.length > 0 && original.includes(input.new_string)) return { path: input.path, replacements: 0, alreadyApplied: true }
        throw new Error(`old_string not found in ${input.path}. Read the file and copy the text exactly.`)
      }
      if (count > 1 && !input.replace_all) {
        throw new Error(`old_string occurs ${count} times in ${input.path}. Add surrounding context to make it unique, or set replace_all.`)
      }
      const updated = input.replace_all ? original.split(input.old_string).join(input.new_string) : original.replace(input.old_string, () => input.new_string)
      await writeFile(target, updated)
      return { path: input.path, replacements: input.replace_all ? count : 1, alreadyApplied: false }
    }
  })

  const listFilesTool = defineDurableTool({
    name: "list_files",
    description: "List the entries of a directory in the workspace (directories end with /).",
    replay: "safe",
    // Observes the workspace: after a crash, read it again rather than reuse a stale answer.
    reuse: false,
    inputSchema: z.object({ path: z.string().optional().describe("Directory, relative to the workspace root (default: root)") }),
    execute: async (input, context) => {
      const root = await prepare("list_files", "read", input, context)
      const entries = await readdir(inWorkspace(root, input.path ?? "."), { withFileTypes: true })
      return {
        path: input.path ?? ".",
        entries: entries
          .filter((e) => !IGNORED.has(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
      }
    }
  })

  const globTool = defineDurableTool({
    name: "glob",
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.test.js". Ignores .git and node_modules.',
    replay: "safe",
    // Observes the workspace: after a crash, read it again rather than reuse a stale answer.
    reuse: false,
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern"),
      path: z.string().optional().describe("Directory to search from (default: root)")
    }),
    execute: async (input, context) => {
      const root = await prepare("glob", "read", input, context)
      const base = inWorkspace(root, input.path ?? ".")
      const matches: Array<string> = []
      for await (const match of fsGlob(input.pattern, { cwd: base, exclude: (name) => IGNORED.has(String(name)) })) {
        matches.push(match)
        if (matches.length >= 500) break
      }
      return { pattern: input.pattern, matches: matches.sort(), truncated: matches.length >= 500 }
    }
  })

  const grepTool = defineDurableTool({
    name: "grep",
    description: "Search file contents with a regular expression (ripgrep syntax). Returns matching lines as path:line:text.",
    replay: "safe",
    // Observes the workspace: after a crash, read it again rather than reuse a stale answer.
    reuse: false,
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression"),
      path: z.string().optional().describe("File or directory to search (default: root)"),
      include: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts"'),
      case_insensitive: z.boolean().optional()
    }),
    execute: async (input, context) => {
      const root = await prepare("grep", "read", input, context)
      const target = relative(root, inWorkspace(root, input.path ?? ".")) || "."
      const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
      const flags = [input.case_insensitive ? "-i" : "", input.include ? `-g ${quote(input.include)}` : ""].join(" ")
      const command = `if command -v rg >/dev/null; then rg -n --no-heading --color never ${flags} -e ${quote(input.pattern)} ${quote(target)}; else grep -rnE ${input.case_insensitive ? "-i" : ""} --exclude-dir=node_modules --exclude-dir=.git ${input.include ? `--include=${quote(input.include)}` : ""} -e ${quote(input.pattern)} ${quote(target)}; fi | head -500`
      const result = await run(command, root, context.signal, 30_000)
      return { pattern: input.pattern, matches: result.stdout.trim() || "(no matches)" }
    }
  })

  const bashTool = defineDurableTool({
    name: "bash",
    description:
      "Run a shell command in the workspace root (bash -c). Use for tests, builds, git, and package managers. Not for reading or editing files: use the file tools.",
    replay: "unsafe",
    inputSchema: z.object({
      command: z.string().describe("The command to run"),
      description: z.string().optional().describe("What the command does, in 5-10 words"),
      timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("Timeout (default 120000)")
    }),
    execute: async (input, context) => {
      const root = await prepare("bash", "exec", input, context)
      // Stream output: durably (for viewers that reconnect) and live (for the open page).
      return run(input.command, root, context.signal, input.timeout_ms ?? 120_000, (chunk) => {
        context.progress(chunk)
        live.publish(context.agentId, { type: "tool-progress", taskId: context.taskId, chunk })
      })
    }
  })

  const todoTool = defineDurableTool({
    name: "todo_write",
    description:
      "Create or update the task list for the current request. Use it for any task with 3+ steps. Send the full list each time; keep exactly one item in_progress.",
    replay: "safe",
    inputSchema: z.object({
      todos: z.array(
        z.object({
          content: z.string().describe("Imperative description, e.g. 'Run the tests'"),
          status: z.enum(["pending", "in_progress", "completed"])
        })
      )
    }),
    execute: async (input, context) => {
      await prepare("todo_write", "read", input, context)
      return { ok: true, remaining: input.todos.filter((t) => t.status !== "completed").length }
    }
  })

  const explore = defineSubagent({
    name: "explore",
    description:
      "Delegate a read-only investigation to a subagent (finding code, tracing how something works, summarizing files). It cannot edit files or run commands. Give it the full question; it reports back.",
    runtime: EXPLORER_RUNTIME
  })

  return {
    coding: [readFileTool, writeFileTool, editFileTool, listFilesTool, globTool, grepTool, bashTool, todoTool, explore],
    explorer: [readFileTool, listFilesTool, globTool, grepTool]
  }
}

export const CODING_RUNTIME = "coding"
export const EXPLORER_RUNTIME = "explorer"

const CATEGORIES = new Map<string, ToolCategory>([
  ["write_file", "edit"],
  ["edit_file", "edit"],
  ["bash", "exec"]
])

/**
 * Permission prompts as a beforeTool hook. It runs before fx-durable journals
 * the call, so a crash while a prompt is open leaves nothing half-started:
 * the recovered turn simply asks again.
 */
export const permissionHooks: ToolHooks = {
  beforeTool: async (call, context) => {
    try {
      await live.authorize(context.agentId, call.name, CATEGORIES.get(call.name) ?? "read", call.input, context.signal)
      return undefined
    } catch (error) {
      return { block: error instanceof Error ? error.message : String(error) }
    }
  }
}

export const SYSTEM_PROMPT = `You are a coding agent working in a local project workspace, in the style of Claude Code.

- All file paths are relative to the workspace root. bash runs there too. Stay inside the workspace.
- Read before you edit. Make the smallest correct change. Keep the project's style.
- Prefer the file tools (read_file, edit_file, write_file, glob, grep, list_files) over shell equivalents.
- Use todo_write to plan and track multi-step work.
- Use the explore subagent for broad read-only investigation, so your own context stays focused.
- Verify changes: run the tests or the relevant command with bash.
- If a tool call is denied, do not retry it; ask the user.
- Be concise. Use GitHub-flavored Markdown. Reference code as path:line.
- If a turn was interrupted and recovered, read the recovery notes carefully: never repeat an operation whose outcome is unknown without checking first.`

export const EXPLORER_PROMPT = `You are a read-only investigator working for a coding agent, in a local project workspace.

- All paths are relative to the workspace root. You can read, list, glob and grep. You cannot edit or run anything.
- Answer the question you were given with evidence: file paths with line numbers and short quotes.
- Be concise: your answer goes back to the agent that asked, not to a person.`

