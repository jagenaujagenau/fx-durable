/**
 * A real application process for the crash suite. The suite runs it with an
 * `FXD_CRASH_AT` plan, the process SIGKILLs itself at that boundary, and the
 * suite restarts it to check recovery invariants.
 *
 * External side effects are appended to a ledger file, which survives the
 * process and lets the suite count how many times each effect really ran.
 */
import { appendFileSync } from "node:fs"
import { Schema } from "effect"
import { DurableFx, defineDurableTool, sqlite, crashPoint } from "../../src/index.js"
import type { JsonObject } from "../../src/index.js"
import { scriptedModel, type Script } from "../../src/testing/index.js"

const DB = process.env.FXD_TEST_DB!
const LEDGER = process.env.FXD_TEST_LEDGER!
const SCENARIO = process.env.FXD_TEST_SCENARIO ?? "deploy"
const REQUEST_ID = process.env.FXD_TEST_REQUEST_ID ?? "req-1"
const CHUNK_DELAY = Number(process.env.FXD_TEST_CHUNK_DELAY ?? "0")
// Live mode: the real AI Gateway and a real model instead of the scripted one.
const LIVE = process.env.FXD_TEST_LIVE === "1"
const MODEL = process.env.FXD_TEST_MODEL ?? "anthropic/claude-sonnet-4.5"
const INSTRUCTIONS = process.env.FXD_TEST_INSTRUCTIONS ?? "You are a test agent."
// read_file opts out of result reuse: it observes state, so a recovered turn re-reads.
const READ_REUSE = process.env.FXD_TEST_READ_REUSE !== "0"

const record = (effect: string, detail: JsonObject = {}) =>
  appendFileSync(LEDGER, `${JSON.stringify({ effect, detail, pid: process.pid })}\n`)

const readFile = defineDurableTool({
  name: "read_file",
  description: "Read a file",
  replay: "safe",
  reuse: READ_REUSE,
  inputSchema: Schema.Struct({ path: Schema.String }),
  execute: ({ path }) => {
    record("read_file", { path })
    return { path, content: '{ "name": "hn-client" }' }
  }
})

const runTests = defineDurableTool({
  name: "run_tests",
  description: "Run the test suite",
  replay: "safe",
  inputSchema: Schema.Struct({ command: Schema.String }),
  execute: async ({ command }) => {
    record("run_tests", { command })
    crashPoint("test.during-safe-tool", "run_tests")
    await new Promise((r) => setTimeout(r, 5))
    return { command, passed: 12, failed: 0 }
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

const checkDeploy = defineDurableTool({
  name: "check_deploy",
  description: "Inspect the current deployment",
  replay: "safe",
  inputSchema: Schema.Struct({ version: Schema.String }),
  execute: ({ version }) => {
    record("check_deploy", { version })
    return { live: version }
  }
})

const charge = defineDurableTool({
  name: "charge",
  description: "Charge a card (idempotent downstream)",
  replay: { strategy: "idempotent", key: ({ taskId }) => `charge-${taskId}` },
  inputSchema: Schema.Struct({ amount: Schema.Number }),
  execute: async ({ amount }, ctx) => {
    record("charge", { amount, key: ctx.idempotencyKey, replay: ctx.replay })
    crashPoint("test.during-idempotent-tool", "charge")
    return { charged: amount, key: ctx.idempotencyKey }
  }
})

const isRecovery = (text: string) => text.includes("[fx-durable recovery]")

const scripts = new Map<string, Script>(Object.entries({
  // read (safe) → deploy (unsafe) → done. On recovery with an unknown deploy,
  // the model tries deploy again (must be refused), then inspects state.
  deploy: (req) => {
    if (isRecovery(req.userText) && req.userText.includes("OUTCOME UNKNOWN")) {
      if (req.step === 0) return { toolCalls: [{ name: "deploy", input: { version: "abc123" } }] }
      if (req.step === 1) return { toolCalls: [{ name: "check_deploy", input: { version: "abc123" } }] }
      return { text: "Deployment state inspected; abc123 is live." }
    }
    // Normal path (also a recovery whose deploy never started).
    const done = new Set(req.toolResults.map((r) => r.toolName))
    if (!done.has("read_file")) return { toolCalls: [{ name: "read_file", input: { path: "package.json" } }] }
    if (!done.has("deploy")) return { toolCalls: [{ name: "deploy", input: { version: "abc123" } }] }
    return { text: "Deployed abc123." }
  },
  // A long safe tool, then done.
  tests: (req) => {
    if (req.toolResults.length === 0) return { toolCalls: [{ name: "run_tests", input: { command: "npm test" } }] }
    return { text: "All tests pass." }
  },
  idempotent: (req) => {
    if (req.toolResults.length === 0) return { toolCalls: [{ name: "charge", input: { amount: 42 } }] }
    return { text: "Charged." }
  },
  chat: (req) => ({ text: `You said: ${req.userText.slice(0, 40)}` })
} satisfies Record<string, Script>))

const main = async () => {
  const script = scripts.get(SCENARIO)
  if (!script) throw new Error(`unknown scenario: ${SCENARIO}`)
  const fx = await DurableFx.open({
    storage: sqlite(DB),
    runtimes: { coding: { tools: [readFile, runTests, deploy, checkDeploy, charge], instructions: INSTRUCTIONS } },
    fetch: LIVE ? undefined : scriptedModel(script, { chunkDelayMs: CHUNK_DELAY }),
    idlePollMillis: 200
  })
  const agent = await fx.agent("engineer", { runtime: "coding", model: MODEL })
  const submission = await agent.submit(process.env.FXD_TEST_PROMPT ?? "Ship version abc123", {
    requestId: REQUEST_ID
  })
  try {
    const result = await submission.result()
    process.stdout.write(`${JSON.stringify({ ok: true, submissionId: submission.id, result })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, submissionId: submission.id, error: String(error) })}\n`)
  }
  await fx.close()
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exit(1)
})
