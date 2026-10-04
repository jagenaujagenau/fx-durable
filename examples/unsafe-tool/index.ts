/**
 * The important case: an unsafe external effect interrupted after it began.
 *
 *   npx tsx examples/unsafe-tool/index.ts --crash   # deploy starts, process dies before the result commits
 *   npx tsx examples/unsafe-tool/index.ts           # outcome_unknown: NOT replayed; the agent inspects state
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { Schema } from "effect"
import { DurableFx, defineDurableTool, sqlite } from "fx-durable"
import { MODEL, modelTransport } from "../model.js"

mkdirSync("./.examples", { recursive: true })
const LIVE = "./.examples/live-version"

const deploy = defineDurableTool({
  name: "deploy",
  description: "Deploy a version to production",
  replay: "unsafe",
  inputSchema: Schema.Struct({ version: Schema.String }),
  execute: async ({ version }) => {
    writeFileSync(LIVE, version) // the external effect
    if (process.argv.includes("--crash")) process.kill(process.pid, "SIGKILL")
    return { deployed: version }
  }
})

const status = defineDurableTool({
  name: "deployment_status",
  description: "Read what is live in production",
  replay: "safe",
  inputSchema: Schema.Struct({}),
  execute: () => ({ live: existsSync(LIVE) ? readFileSync(LIVE, "utf8") : null })
})

const fx = await DurableFx.open({
  storage: sqlite("./.examples/unsafe-tool.db"),
  runtimes: { ops: { tools: [deploy, status] } },
  ...modelTransport((req) => {
    if (req.userText.includes("OUTCOME UNKNOWN")) {
      return req.toolResults.length === 0
        ? { toolCalls: [{ name: "deployment_status", input: {} }] }
        : { text: `Inspected production instead of redeploying: ${req.toolResults[0]!.output}` }
    }
    return req.toolResults.length === 0
      ? { toolCalls: [{ name: "deploy", input: { version: "abc123" } }] }
      : { text: "Deployed abc123." }
  })
})

const agent = await fx.agent("ops", { runtime: "ops", model: MODEL })
const submission = await agent.submit("Deploy abc123 to production.", { requestId: "deploy-abc123" })
for await (const event of submission.events()) {
  if (event.type === "tool.outcome_unknown") console.log("⚠ outcome unknown:", event.payload)
}
console.log((await submission.result()).text)
await fx.close()
