/**
 * A real application process for the crash suite. The suite runs it with an
 * `FXD_CRASH_AT` plan, the process SIGKILLs itself at that boundary, and the
 * suite runs it again to check what recovery did.
 *
 * External side effects are appended to a ledger file, which survives the
 * process and lets the suite count how many times each effect really ran.
 */
import { appendFileSync } from "node:fs"
import { Schema } from "effect"
import { DurableFx, crashPoint, defineDocument, defineDurableTool, defineSubagent, sqlite, type Json, type JsonObject } from "../../src/index.js"
import { scriptedModel, type Script } from "../../src/testing/index.js"

const DB = process.env.FXD_TEST_DB!
const LEDGER = process.env.FXD_TEST_LEDGER!
const SCENARIO = process.env.FXD_TEST_SCENARIO ?? "deploy"
const REQUEST_ID = process.env.FXD_TEST_REQUEST_ID ?? "req-1"

const record = (effect: string, detail: JsonObject = {}) => appendFileSync(LEDGER, `${JSON.stringify({ effect, detail, pid: process.pid })}\n`)

export const Notes = defineDocument<{ lines: Array<string> }>({ kind: "test.notes", version: 1, scope: "agent", initial: () => ({ lines: [] }) })

const readFile = defineDurableTool({
  name: "read_file",
  description: "Read a file",
  replay: "safe",
  inputSchema: Schema.Struct({ path: Schema.String }),
  execute: ({ path }) => {
    record("read_file", { path })
    crashPoint("test.during-safe-tool", "read_file")
    return { path, content: '{ "name": "hn-client" }' }
  }
})

const deploy = defineDurableTool({
  name: "deploy",
  description: "Deploy to production",
  replay: "unsafe",
  inputSchema: Schema.Struct({ version: Schema.String }),
  execute: async ({ version }) => {
    record("deploy", { version })
    crashPoint("test.during-unsafe-tool", "deploy")
    await new Promise((r) => setTimeout(r, 5))
    return { deployed: version }
  }
})

const charge = defineDurableTool({
  name: "charge",
  description: "Charge the customer",
  replay: { strategy: "idempotent" },
  inputSchema: Schema.Struct({ amount: Schema.Number }),
  execute: ({ amount }, { idempotencyKey }) => {
    record("charge", { amount, key: idempotencyKey })
    crashPoint("test.during-idempotent-tool", "charge")
    return { charged: amount }
  }
})

const note = defineDurableTool({
  name: "note",
  description: "Add a line to the notes",
  replay: "safe",
  inputSchema: Schema.Struct({ line: Schema.String }),
  execute: async ({ line }, { documents }) => {
    record("note", { line })
    await documents.update(Notes, (notes) => void notes.lines.push(line))
    crashPoint("test.after-document-update", "note")
    return "noted"
  }
})

// A safe caller of an unsafe tool: release reruns after a crash, its nested deploy does not.
const release = defineDurableTool({
  name: "release",
  description: "Release a version: deploy it, then announce it",
  replay: "safe",
  inputSchema: Schema.Struct({ version: Schema.String }),
  execute: async ({ version }, { executeTool }) => {
    record("release", { version })
    const deployed = await executeTool("deploy", { version })
    crashPoint("test.in-release", "release")
    return { deployed, announced: true }
  }
})

const delegate = defineSubagent({ name: "delegate", description: "Hand a task to a worker", runtime: "worker" })

const work = defineDurableTool({
  name: "work",
  description: "Do the work",
  replay: "safe",
  execute: () => {
    record("work")
    crashPoint("test.during-work", "work")
    return "worked"
  }
})

/** Call each tool in order until it has a result, then answer with the last one. */
const sequence =
  (...calls: Array<{ readonly name: string; readonly input: Record<string, Json> }>): Script =>
  (req) => {
    // libfx's resume adds its own user messages, so decide from every result in the conversation.
    const done = new Map(req.allToolResults.map((result) => [result.toolName, result.output]))
    const next = calls.find((call) => !done.has(call.name))
    if (next) return { toolCalls: [next] }
    const last = calls.at(-1)
    return { text: `done: ${last ? done.get(last.name) : ""}` }
  }

const scripts = new Map<string, Script>([
  ["deploy", sequence({ name: "read_file", input: { path: "package.json" } }, { name: "deploy", input: { version: "abc123" } })],
  ["charge", sequence({ name: "charge", input: { amount: 42 } })],
  ["note", sequence({ name: "note", input: { line: "remember" } })],
  ["nested", sequence({ name: "release", input: { version: "abc123" } })],
  [
    "subagent",
    (req) => (req.tools.includes("work") ? sequence({ name: "work", input: {} })(req) : sequence({ name: "delegate", input: { task: "do the work" } })(req))
  ]
])

const main = async () => {
  const script = scripts.get(SCENARIO)
  if (!script) throw new Error(`unknown scenario: ${SCENARIO}`)
  const fx = await DurableFx.open({
    storage: sqlite(DB),
    runtimes: {
      coding: { tools: [readFile, deploy, charge, note, release, delegate], instructions: "You are a test agent." },
      worker: { tools: [work], instructions: "You do the work." }
    },
    fetch: scriptedModel(script)
  })
  const agent = await fx.agent("engineer", { runtime: "coding", model: "test/model" })
  const submission = await agent.submit("Ship version abc123", { requestId: REQUEST_ID })
  try {
    const result = await submission.result()
    process.stdout.write(`${JSON.stringify({ ok: true, submissionId: submission.id, result })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, submissionId: submission.id, error: String(error) })}\n`)
  }
  await fx.close()
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`)
  process.exit(1)
})
