/**
 * Crash in the middle of a safe tool, then restart.
 *
 *   npx tsx examples/crash-recovery/index.ts --crash   # dies during `npm test`
 *   npx tsx examples/crash-recovery/index.ts           # recovers: replays the safe tool, continues
 */
import { Schema } from "effect"
import { DurableFx, defineDurableTool, sqlite } from "fx-durable"
import { MODEL, modelTransport } from "../model.js"

const runTests = defineDurableTool({
  name: "run_tests",
  description: "Run the test suite",
  replay: "safe", // reading state only: replaying after a crash is harmless
  inputSchema: Schema.Struct({ command: Schema.String }),
  execute: async ({ command }, { replay }) => {
    console.log(replay ? `  ↻ replaying ${command}` : `  ▶ ${command}`)
    if (process.argv.includes("--crash") && !replay) {
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 200)
    }
    await new Promise((r) => setTimeout(r, 1000))
    return { passed: 12, failed: 0 }
  }
})

const fx = await DurableFx.open({
  storage: sqlite("./.examples/crash-recovery.db"),
  runtimes: { coding: { tools: [runTests] } },
  ...modelTransport((req) =>
    // After recovery the same call returns the journaled (replayed) result without re-running.
    req.toolResults.length === 0
      ? { toolCalls: [{ name: "run_tests", input: { command: "npm test" } }] }
      : { text: `Tests: ${req.toolResults[0]!.output}` }
  )
})
const agent = await fx.agent("engineer", { runtime: "coding", model: MODEL })
const submission = await agent.submit("Run the tests and report.", { requestId: "run-tests-1" })
console.log((await submission.result()).text)
await fx.close()
