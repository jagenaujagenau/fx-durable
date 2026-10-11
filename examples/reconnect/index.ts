/**
 * Clients attach to agents; they do not own them. This client remembers the
 * cursor of the last event it saw and resumes from there: stored events
 * first, then live, with no gap in between. Ctrl-C it and run it again.
 *
 *   npx tsx examples/reconnect/index.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { DurableFx, sqlite } from "fx-durable"
import { MODEL, modelTransport } from "../model.js"

const CURSOR = "./.examples/reconnect.cursor"
const fx = await DurableFx.open({
  storage: sqlite("./.examples/reconnect.db"),
  runtimes: { chat: {} },
  ...modelTransport((req) => ({ text: `echo: ${req.userText}` }))
})
const agent = await fx.agent("echo", { runtime: "chat", model: MODEL })

const after = existsSync(CURSOR) ? Number(readFileSync(CURSOR, "utf8")) : 0
console.log(`resuming after cursor ${after}`)

// Some other client keeps submitting work...
const timer = setInterval(() => void agent.submit(`ping ${new Date().toISOString()}`), 1500)

// The first request opens the agent's session, which events() reads.
await (await agent.submit("hello")).result()
for await (const event of agent.events({ after })) {
  const cursor = event.cursor ?? after
  console.log(`#${cursor} ${event.type}`)
  writeFileSync(CURSOR, String(cursor))
  if (cursor >= after + 30) break
}
clearInterval(timer)
await fx.close()
