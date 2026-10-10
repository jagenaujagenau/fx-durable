import { spawn } from "node:child_process"
import { glob as fsGlob, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { Schema } from "effect"
import { isJsonString } from "../domain/json.js"
import { defineDurableTool, type DurableTool, type DurableToolContext } from "./define-tool.js"

/**
 * File and shell tools for coding agents, as durable tools.
 *
 * Each tool's replay policy follows from what happens if it runs twice:
 * reads are safe and re-read after a crash (`reuse: false`) instead of
 * returning what the file held before; writes and edits are safe because
 * running them again leaves the same file; `bash` is unsafe, so an
 * interrupted command is reported as outcome unknown, never run again.
 *
 * Paths are resolved inside the workspace and refused outside it. That keeps
 * a model on track; it is not a sandbox (symlinks and `bash` can reach out).
 */

export interface CodingToolsOptions {
  /**
   * The directory the tools work in. Defaults to the agent's `cwd`
   * (`fx.agent(id, { cwd })`); a function picks one per call.
   */
  readonly workspace?: string | ((context: DurableToolContext) => string | Promise<string>)
  /** Environment for `bash` and `grep`. Defaults to this process's, without variables whose names look like credentials. */
  readonly env?: NodeJS.ProcessEnv
  /** Default `bash` timeout (the model may ask for up to 10 minutes). Default 120 000 ms. */
  readonly bashTimeoutMs?: number
  /** Longest text a tool returns before truncating it. Default 30 000 characters. */
  readonly maxOutputChars?: number
}

export interface CodingTools {
  readonly readFile: DurableTool
  readonly writeFile: DurableTool
  readonly editFile: DurableTool
  readonly listFiles: DurableTool
  readonly glob: DurableTool
  readonly grep: DurableTool
  readonly bash: DurableTool
  /** Every tool above. */
  readonly all: ReadonlyArray<DurableTool>
  /** The tools that only read: for explorers, reviewers, and plan modes. */
  readonly readOnly: ReadonlyArray<DurableTool>
}

const IGNORED = new Set([".git", "node_modules"])
const MAX_MATCHES = 500
const MAX_LINE_CHARS = 2000

const CREDENTIAL = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

/** This process's environment without anything that looks like a credential. */
export const environmentWithoutCredentials = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIAL.test(name)))

/** Resolve a model-supplied path inside `root`; refuse anything outside it. */
export const resolveInWorkspace = (root: string, path: string): string => {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  const fromRoot = relative(root, absolute)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`${path} is outside the workspace (${root})`)
  return absolute
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

const description = (text: string) => ({ description: text })

export const createCodingTools = (options: CodingToolsOptions = {}): CodingTools => {
  const maxOutput = options.maxOutputChars ?? 30_000
  const truncate = (text: string) =>
    text.length > maxOutput ? `${text.slice(0, maxOutput)}\n… [${text.length - maxOutput} more characters truncated]` : text

  const workspaceOf = async (context: DurableToolContext): Promise<string> => {
    const configured = options.workspace
    const root = configured === undefined ? context.cwd : isJsonString(configured) ? configured : await configured(context)
    if (root === null) throw new Error("no workspace: give the agent a cwd, or pass `workspace` to createCodingTools")
    return resolve(root)
  }

  const shell = (command: string, cwd: string, signal: AbortSignal, timeoutMs: number, onOutput?: (chunk: string) => void) =>
    new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((done, fail) => {
      // Not a login shell: profile scripts must not change the directory or environment.
      const child = spawn("bash", ["-c", command], {
        cwd,
        env: { ...(options.env ?? environmentWithoutCredentials()), CI: "1", FORCE_COLOR: "0" }
      })
      let stdout = ""
      let stderr = ""
      let timedOut = false
      const kill = () => child.kill("SIGTERM")
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)
      signal.addEventListener("abort", kill, { once: true })
      const collect = (into: "stdout" | "stderr") => (chunk: Buffer) => {
        const text = chunk.toString()
        if (into === "stdout") stdout += text
        else stderr += text
        onOutput?.(text)
      }
      child.stdout.on("data", collect("stdout"))
      child.stderr.on("data", collect("stderr"))
      child.once("error", fail)
      child.once("close", (exitCode) => {
        clearTimeout(timer)
        signal.removeEventListener("abort", kill)
        done({ exitCode, stdout: truncate(stdout), stderr: truncate(stderr), timedOut })
      })
    })

  const readFileTool = defineDurableTool({
    name: "read_file",
    description: "Read a text file from the workspace. Returns numbered lines (like `cat -n`). Use offset/limit for large files.",
    replay: "safe",
    reuse: false,
    inputSchema: Schema.Struct({
      path: Schema.String.annotate(description("File path, relative to the workspace root")),
      offset: Schema.optionalKey(Schema.Int.annotate(description("1-based line to start from"))),
      limit: Schema.optionalKey(Schema.Int.annotate(description("Number of lines to read (default 2000)")))
    }),
    execute: async (input, context) => {
      const root = await workspaceOf(context)
      const lines = (await readFile(resolveInWorkspace(root, input.path), "utf8")).split("\n")
      const start = Math.max(1, input.offset ?? 1) - 1
      const slice = lines.slice(start, start + Math.max(1, input.limit ?? 2000))
      const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line.slice(0, MAX_LINE_CHARS)}`).join("\n")
      return { path: input.path, totalLines: lines.length, content: truncate(numbered) }
    }
  })

  const writeFileTool = defineDurableTool({
    name: "write_file",
    description: "Create or overwrite a file in the workspace with the given content. Prefer edit_file for changes to existing files.",
    replay: "safe",
    inputSchema: Schema.Struct({
      path: Schema.String.annotate(description("File path, relative to the workspace root")),
      content: Schema.String.annotate(description("The complete new file content"))
    }),
    execute: async (input, context) => {
      const target = resolveInWorkspace(await workspaceOf(context), input.path)
      const existed = await stat(target).then(
        () => true,
        () => false
      )
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
    inputSchema: Schema.Struct({
      path: Schema.String.annotate(description("File path, relative to the workspace root")),
      old_string: Schema.String.annotate(description("Exact text to replace")),
      new_string: Schema.String.annotate(description("Replacement text")),
      replace_all: Schema.optionalKey(Schema.Boolean.annotate(description("Replace every occurrence (default false)")))
    }),
    execute: async (input, context) => {
      const target = resolveInWorkspace(await workspaceOf(context), input.path)
      const original = await readFile(target, "utf8")
      const count = original.split(input.old_string).length - 1
      if (count === 0) {
        // Running it again after a crash: the edit may already be applied.
        if (input.new_string.length > 0 && original.includes(input.new_string)) {
          return { path: input.path, replacements: 0, alreadyApplied: true }
        }
        throw new Error(`old_string not found in ${input.path}. Read the file and copy the text exactly.`)
      }
      if (count > 1 && !input.replace_all) {
        throw new Error(`old_string occurs ${count} times in ${input.path}. Add surrounding context to make it unique, or set replace_all.`)
      }
      const updated = input.replace_all
        ? original.split(input.old_string).join(input.new_string)
        : original.replace(input.old_string, () => input.new_string)
      await writeFile(target, updated)
      return { path: input.path, replacements: input.replace_all ? count : 1, alreadyApplied: false }
    }
  })

  const listFilesTool = defineDurableTool({
    name: "list_files",
    description: "List the entries of a directory in the workspace (directories end with /).",
    replay: "safe",
    reuse: false,
    inputSchema: Schema.Struct({
      path: Schema.optionalKey(Schema.String.annotate(description("Directory, relative to the workspace root (default: root)")))
    }),
    execute: async (input, context) => {
      const entries = await readdir(resolveInWorkspace(await workspaceOf(context), input.path ?? "."), { withFileTypes: true })
      return {
        path: input.path ?? ".",
        entries: entries
          .filter((entry) => !IGNORED.has(entry.name))
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort()
      }
    }
  })

  const globTool = defineDurableTool({
    name: "glob",
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/*.test.js". Ignores .git and node_modules.',
    replay: "safe",
    reuse: false,
    inputSchema: Schema.Struct({
      pattern: Schema.String.annotate(description("Glob pattern")),
      path: Schema.optionalKey(Schema.String.annotate(description("Directory to search from (default: root)")))
    }),
    execute: async (input, context) => {
      const base = resolveInWorkspace(await workspaceOf(context), input.path ?? ".")
      const matches: Array<string> = []
      for await (const match of fsGlob(input.pattern, { cwd: base, exclude: (name) => IGNORED.has(String(name)) })) {
        matches.push(match)
        if (matches.length >= MAX_MATCHES) break
      }
      return { pattern: input.pattern, matches: matches.sort(), truncated: matches.length >= MAX_MATCHES }
    }
  })

  const grepTool = defineDurableTool({
    name: "grep",
    description: "Search file contents with a regular expression. Returns matching lines as path:line:text.",
    replay: "safe",
    reuse: false,
    inputSchema: Schema.Struct({
      pattern: Schema.String.annotate(description("Regular expression")),
      path: Schema.optionalKey(Schema.String.annotate(description("File or directory to search (default: root)"))),
      include: Schema.optionalKey(Schema.String.annotate(description('Only search files matching this glob, e.g. "*.ts"'))),
      case_insensitive: Schema.optionalKey(Schema.Boolean)
    }),
    execute: async (input, context) => {
      const root = await workspaceOf(context)
      const target = quote(relative(root, resolveInWorkspace(root, input.path ?? ".")) || ".")
      const pattern = quote(input.pattern)
      const ignoreCase = input.case_insensitive ? "-i" : ""
      const rg = `rg -n --no-heading --color never ${ignoreCase} ${input.include ? `-g ${quote(input.include)}` : ""} -e ${pattern} ${target}`
      const grep = `grep -rnE ${ignoreCase} --exclude-dir=node_modules --exclude-dir=.git ${input.include ? `--include=${quote(input.include)}` : ""} -e ${pattern} ${target}`
      const command = `if command -v rg >/dev/null; then ${rg}; else ${grep}; fi | head -${MAX_MATCHES}`
      const result = await shell(command, root, context.signal, 30_000)
      return { pattern: input.pattern, matches: result.stdout.trim() || "(no matches)" }
    }
  })

  const bashTool = defineDurableTool({
    name: "bash",
    description:
      "Run a shell command in the workspace root (bash -c). Use for tests, builds, git, and package managers. Not for reading or editing files: use the file tools.",
    replay: "unsafe",
    inputSchema: Schema.Struct({
      command: Schema.String.annotate(description("The command to run")),
      description: Schema.optionalKey(Schema.String.annotate(description("What the command does, in 5-10 words"))),
      timeout_ms: Schema.optionalKey(Schema.Int.annotate(description("Timeout in milliseconds (at most 600000)")))
    }),
    execute: async (input, context) => {
      const timeoutMs = Math.min(600_000, Math.max(1000, input.timeout_ms ?? options.bashTimeoutMs ?? 120_000))
      return shell(input.command, await workspaceOf(context), context.signal, timeoutMs, context.progress)
    }
  })

  const readOnly = [readFileTool, listFilesTool, globTool, grepTool]
  return {
    readFile: readFileTool,
    writeFile: writeFileTool,
    editFile: editFileTool,
    listFiles: listFilesTool,
    glob: globTool,
    grep: grepTool,
    bash: bashTool,
    all: [readFileTool, writeFileTool, editFileTool, listFilesTool, globTool, grepTool, bashTool],
    readOnly
  }
}
