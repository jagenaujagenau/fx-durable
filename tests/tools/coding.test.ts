import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { DurableToolContext, Json } from "../../src/index.js"
import { createCodingTools } from "../../src/tools/index.js"
import { openFx, tempDb } from "../helpers.js"

const workspace = () => mkdtempSync(join(tmpdir(), "fxd-tools-"))

const contextFor = (cwd: string | null, progress: Array<string> = []): DurableToolContext => ({
  agentId: "a",
  turnId: "t",
  taskId: "k",
  cwd,
  idempotencyKey: null,
  signal: new AbortController().signal,
  replay: false,
  progress: (chunk) => progress.push(chunk),
  executeTool: () => Promise.reject(new Error("no nested calls"))
})

describe("createCodingTools", () => {
  const tools = createCodingTools()

  it("declares replay policies from what running twice would do", () => {
    const policies = Object.fromEntries(tools.all.map((t) => [t.name, { replay: t.replay, reuse: t.reuse }]))
    expect(policies).toEqual({
      read_file: { replay: "safe", reuse: false },
      write_file: { replay: "safe", reuse: true },
      edit_file: { replay: "safe", reuse: true },
      list_files: { replay: "safe", reuse: false },
      glob: { replay: "safe", reuse: false },
      grep: { replay: "safe", reuse: false },
      bash: { replay: "unsafe", reuse: true }
    })
    expect(tools.readOnly.map((t) => t.name)).toEqual(["read_file", "list_files", "glob", "grep"])
  })

  it("does not advertise null for optional fields (the model would send it and fail validation)", () => {
    expect(JSON.stringify(tools.readFile.jsonSchema)).not.toContain("null")
  })

  it("writes, reads with line numbers, and edits files in the agent's cwd", async () => {
    const root = workspace()
    const context = contextFor(root)
    expect(await tools.writeFile.run({ path: "src/a.txt", content: "one\ntwo\nthree" }, context)).toMatchObject({ created: true })
    expect(await tools.readFile.run({ path: "src/a.txt", offset: 2, limit: 1 }, context)).toEqual({
      path: "src/a.txt",
      totalLines: 3,
      content: "     2\ttwo"
    })
    const edit: Json = { path: "src/a.txt", old_string: "two", new_string: "2" }
    expect(await tools.editFile.run(edit, context)).toMatchObject({ replacements: 1, alreadyApplied: false })
    // Run again, as after a crash: the edit is already there.
    expect(await tools.editFile.run(edit, context)).toMatchObject({ replacements: 0, alreadyApplied: true })
    expect(readFileSync(join(root, "src/a.txt"), "utf8")).toBe("one\n2\nthree")
  })

  it("refuses an ambiguous edit unless replace_all is set", async () => {
    const root = workspace()
    writeFileSync(join(root, "b.txt"), "x x")
    await expect(tools.editFile.run({ path: "b.txt", old_string: "x", new_string: "y" }, contextFor(root))).rejects.toThrow(/occurs 2 times/)
    await tools.editFile.run({ path: "b.txt", old_string: "x", new_string: "y", replace_all: true }, contextFor(root))
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("y y")
  })

  it("lists, globs, and greps", async () => {
    const root = workspace()
    const context = contextFor(root)
    await tools.writeFile.run({ path: "src/a.ts", content: "export const needle = 1\n" }, context)
    await tools.writeFile.run({ path: "src/b.md", content: "nothing here\n" }, context)
    expect(await tools.listFiles.run({}, context)).toEqual({ path: ".", entries: ["src/"] })
    expect(await tools.glob.run({ pattern: "**/*.ts" }, context)).toEqual({ pattern: "**/*.ts", matches: ["src/a.ts"], truncated: false })
    const found = await tools.grep.run({ pattern: "need+le" }, context)
    expect(JSON.stringify(found)).toContain("a.ts:1:export const needle = 1")
  })

  it("runs bash in the workspace, streams its output, and hides credentials", async () => {
    const root = workspace()
    const progress: Array<string> = []
    process.env.FXD_TEST_API_KEY = "hunter2"
    try {
      const result = await tools.bash.run({ command: 'pwd; echo "key=${FXD_TEST_API_KEY:-unset}"; exit 3' }, contextFor(root, progress))
      expect(result).toMatchObject({ exitCode: 3, timedOut: false })
      expect(JSON.stringify(result)).toContain("key=unset")
      expect(progress.join("")).toContain("key=unset")
    } finally {
      delete process.env.FXD_TEST_API_KEY
    }
  })

  it("refuses paths outside the workspace", async () => {
    await expect(tools.readFile.run({ path: "../../etc/passwd" }, contextFor(workspace()))).rejects.toThrow(/outside the workspace/)
    await expect(tools.readFile.run({ path: "/etc/passwd" }, contextFor(workspace()))).rejects.toThrow(/outside the workspace/)
  })

  it("needs a workspace: the agent's cwd, or the `workspace` option", async () => {
    await expect(tools.listFiles.run({}, contextFor(null))).rejects.toThrow(/no workspace/)
    const root = workspace()
    writeFileSync(join(root, "here.txt"), "")
    const perAgent = createCodingTools({ workspace: (context) => (context.agentId === "a" ? root : "/nowhere") })
    expect(await perAgent.listFiles.run({}, contextFor(null))).toEqual({ path: ".", entries: ["here.txt"] })
  })
})

describe("coding tools in an agent", () => {
  it("work in the directory given to fx.agent({ cwd })", async () => {
    const root = workspace()
    const { all } = createCodingTools()
    const fx = await openFx(
      tempDb(),
      (req) =>
        req.step === 0
          ? { toolCalls: [{ name: "write_file", input: { path: "hello.txt", content: "hi" } }] }
          : { text: "written" },
      { runtimes: { coder: { tools: all } } }
    )
    const agent = await fx.agent("coder", { runtime: "coder", model: "test/model", cwd: root })
    expect((await (await agent.submit("write it")).result()).text).toBe("written")
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hi")
    await fx.close()
  })
})
