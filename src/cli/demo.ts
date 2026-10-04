import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { killNow } from "../core/crash.js"
import { isJsonObject, jsonText } from "../core/json.js"
import { DurableFx } from "../core/durable-fx.js"
import type { DurableEvent } from "../core/schema.js"
import { sqlite } from "../sqlite/storage.js"
import { scriptedModel, type Script } from "../testing/scripted-model.js"
import { defineDurableTool } from "../tools/define-tool.js"
import { bold, cyan, dim, green, red, toolLabel, yellow } from "./render.js"

/**
 * The killer demo. A scripted model (offline, deterministic) drives the real
 * libfx kernel through a coding task, then a production deploy.
 *
 *   npx fx-durable demo          # run; kill -9 it at any point
 *   npx fx-durable demo          # restart: it recovers and continues
 *   npx fx-durable demo --crash-at tool.after-execute:deploy
 */

const TASK = "Task: build a small Hacker News client, then deploy version abc123 to production."
const REQUEST_ID = "demo-hn-client"

export interface DemoOptions {
  readonly reset: boolean
  readonly crashAt?: string | undefined
  readonly fast: boolean
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    })
  })

export const runDemo = async (options: DemoOptions) => {
  const root = resolve(".fxd-demo")
  if (options.reset) rmSync(root, { recursive: true, force: true })
  const workspace = join(root, "workspace")
  mkdirSync(join(workspace, "src"), { recursive: true })
  const packageJson = join(workspace, "package.json")
  if (!existsSync(packageJson)) {
    writeFileSync(packageJson, JSON.stringify({ name: "hn-client", version: "0.1.0", scripts: { test: "node --test" } }, null, 2))
  }
  const cursorFile = join(root, "cursor")
  const deployMarker = join(workspace, ".deployed")
  const pace = options.fast ? 0.1 : 1

  const readFile = defineDurableTool({
    name: "read_file",
    description: "Read a file from the workspace",
    replay: "safe",
    inputSchema: Schema.Struct({ path: Schema.String }),
    execute: async ({ path }) => {
      await sleep(300 * pace)
      return readFileSync(join(workspace, path), "utf8")
    }
  })
  const editFile = defineDurableTool({
    name: "edit_file",
    description: "Write a file in the workspace",
    // Writing a full file is idempotent: replaying it converges to the same state.
    replay: "safe",
    inputSchema: Schema.Struct({ path: Schema.String, content: Schema.String }),
    execute: async ({ path, content }) => {
      await sleep(300 * pace)
      writeFileSync(join(workspace, path), content)
      return { written: path, bytes: content.length }
    }
  })
  const bash = defineDurableTool({
    name: "bash",
    description: "Run a shell command",
    replay: "safe",
    inputSchema: Schema.Struct({ command: Schema.String }),
    execute: async ({ command }, { signal }) => {
      await sleep(3000 * pace, signal)
      return { command, exitCode: 0, stdout: "✓ 12 passing (fetchTopStories, renderStory, …)" }
    }
  })
  const deploy = defineDurableTool({
    name: "deploy",
    description: "Deploy a version to an environment",
    replay: "unsafe",
    inputSchema: Schema.Struct({ environment: Schema.String, version: Schema.String }),
    execute: async ({ environment, version }) => {
      // The external effect happens immediately; the confirmation takes a while.
      writeFileSync(deployMarker, JSON.stringify({ environment, version, at: new Date().toISOString() }))
      await sleep(3000 * pace)
      return { environment, version, url: "https://hn-client.example.com" }
    }
  })
  const checkDeployment = defineDurableTool({
    name: "check_deployment",
    description: "Inspect what is currently deployed",
    replay: "safe",
    inputSchema: Schema.Struct({ environment: Schema.String }),
    execute: async ({ environment }) => {
      await sleep(800 * pace)
      return existsSync(deployMarker)
        ? { environment, live: JSON.parse(readFileSync(deployMarker, "utf8")) }
        : { environment, live: null }
    }
  })

  const appSource = `export async function fetchTopStories(limit = 30) {
  const ids = await (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")).json()
  return Promise.all(ids.slice(0, limit).map(async (id) =>
    (await fetch(\`https://hacker-news.firebaseio.com/v0/item/\${id}.json\`)).json()))
}

export const renderStory = (s) => \`\${s.score} ▲ \${s.title} (\${s.by})\`
`

  const script: Script = (req) => {
    if (req.userText.includes("[fx-durable recovery]") && req.userText.includes("OUTCOME UNKNOWN")) {
      const inspected = req.toolResults.find((r) => r.toolName === "check_deployment")
      if (!inspected) {
        return {
          text: "The previous deploy may or may not have happened. Inspecting deployment state before doing anything.",
          toolCalls: [{ name: "check_deployment", input: { environment: "production" } }]
        }
      }
      const live = inspected.output.includes("abc123")
      return {
        text: live
          ? "Verified: abc123 is live in production. The deploy went through before the crash, so I will not deploy again. Done."
          : "Nothing is live yet; the interrupted deploy never took effect. Ask me to deploy again when ready."
      }
    }
    const done = new Set(req.toolResults.map((r) => r.toolName))
    if (!done.has("read_file"))
      return { text: "Let me look at the project first.", toolCalls: [{ name: "read_file", input: { path: "package.json" } }] }
    if (!done.has("edit_file"))
      return { text: "Writing the client.", toolCalls: [{ name: "edit_file", input: { path: "src/app.ts", content: appSource } }] }
    if (!done.has("bash")) return { toolCalls: [{ name: "bash", input: { command: "npm test" } }] }
    if (!done.has("deploy"))
      return { text: "Tests pass. Deploying.", toolCalls: [{ name: "deploy", input: { environment: "production", version: "abc123" } }] }
    return { text: "Shipped: abc123 is live at https://hn-client.example.com." }
  }

  const [point, name] = (options.crashAt ?? "").split(":")
  const fx = await DurableFx.open({
    storage: sqlite(join(root, "demo.db")),
    runtimes: { coding: { tools: [readFile, editFile, bash, deploy, checkDeployment] } },
    fetch: scriptedModel(script, { latencyMs: 700 * pace, chunkDelayMs: 15 * pace }),
    crash: point ? { point, name: name || undefined, onCrash: killNow } : "env",
    idlePollMillis: 200
  })

  console.log(dim(`fx-durable demo · pid ${process.pid} · try: kill -9 ${process.pid}`))
  console.log()

  const agent = await fx.agent("engineer", { runtime: "coding", model: "anthropic/claude-sonnet-4.5", cwd: workspace })
  let cursor = existsSync(cursorFile) ? Number(readFileSync(cursorFile, "utf8")) : 0
  const submission = await agent.submit(TASK, { requestId: REQUEST_ID })
  const status = await submission.status()
  if (status.state === "completed" && !options.reset) {
    const history: Array<DurableEvent> = []
    for await (const e of agent.events({ after: cursor, follow: false })) history.push(e)
    if (history.length === 0) {
      console.log(green("✓ already finished:"), status.result?.text ?? "")
      console.log(dim("run `fx-durable demo --reset` to start over"))
      await fx.close()
      return
    }
  }

  const labels = new Map<string, string>()
  for await (const event of agent.events({ after: cursor })) {
    render(event, labels)
    cursor = event.sequence
    writeFileSync(cursorFile, String(cursor))
    if (event.submissionId === submission.id && ["submission.completed", "submission.failed", "submission.cancelled"].includes(event.type)) break
  }
  console.log()
  console.log(dim("inspect it: fxd inspect engineer --db .fxd-demo/demo.db · fxd trace engineer --db .fxd-demo/demo.db"))
  await fx.close()
}

const render = (event: DurableEvent, labels: Map<string, string>) => {
  const p = event.payload
  const text = (key: string) => jsonText(p[key])
  const label = () => (event.taskId && labels.get(event.taskId)) || toolLabel(text("tool") || "tool", p.input)
  switch (event.type) {
    case "submission.created":
      console.log(bold(text("content")))
      console.log()
      break
    case "recovery.started":
      console.log()
      console.log(bold(`Recovering agent ${event.agentId}...`))
      console.log()
      break
    case "turn.recovered":
      console.log(green("✓ restored checkpoint"))
      console.log(green("✓ recovered interrupted turn"))
      break
    case "model.interrupted":
      console.log(dim("✗ interrupted model call — will be redone (replay-safe)"))
      break
    case "tool.interrupted":
      console.log(dim(`✗ ${label()} interrupted`))
      break
    case "tool.replayed":
      console.log(green(`✓ ${text("tool")} was replay-safe`) + dim(" — replaying"))
      break
    case "tool.outcome_unknown": {
      const input = p.input !== undefined && isJsonObject(p.input) ? p.input : {}
      console.log()
      console.log(yellow(bold("⚠ Interrupted external operation")))
      console.log()
      console.log(`  ${text("tool")}`)
      for (const [k, v] of Object.entries(input)) console.log(dim(`  ${k}: ${jsonText(v)}`))
      console.log()
      console.log(yellow("  Outcome unknown."))
      console.log(yellow("  Operation will NOT be replayed automatically."))
      console.log()
      break
    }
    case "recovery.completed":
      console.log()
      console.log(bold("Continuing..."))
      console.log()
      break
    case "model.started":
      console.log(cyan("● model"))
      break
    case "model.completed":
      if (text("text")) console.log(dim(`  ${text("text")}`))
      break
    case "tool.started":
      if (event.taskId) labels.set(event.taskId, toolLabel(text("tool"), p.input))
      console.log(cyan(`● ${label()}`))
      break
    case "tool.completed":
      console.log(green(`✓ ${label()}`))
      break
    case "tool.reused":
      console.log(green(`✓ ${label()}`) + dim(" (journaled — not re-run)"))
      break
    case "tool.failed":
      console.log(red(`✗ ${label()}: ${text("error")}`))
      break
    case "tool.outcome_unknown_refused":
      console.log(yellow(`✗ ${label()} refused — the previous attempt's outcome is unknown`))
      break
    case "checkpoint.created":
      console.log(dim(`✓ checkpoint #${text("sequence")}`))
      break
    case "submission.completed":
      console.log()
      console.log(green(bold("Done.")), text("text"))
      break
    case "submission.failed":
      console.log(red(`Failed: ${text("error")}`))
      break
  }
}
