/**
 * The smallest durable agent. Run it twice: the second run remembers the
 * first conversation (restored from the SQLite checkpoint), and re-running
 * with the same requestId attaches to the existing submission.
 *
 *   pnpm build && npx tsx examples/hello-durable/index.ts "My name is Ada"
 *   npx tsx examples/hello-durable/index.ts "What is my name?"
 */
import { Schema } from "effect"
import { DurableFx, defineDurableTool, sqlite } from "fx-durable"
import { MODEL, modelTransport } from "../model.js"

const clock = defineDurableTool({
  name: "current_time",
  description: "Get the current time",
  replay: "safe",
  inputSchema: Schema.Struct({}),
  execute: () => new Date().toISOString()
})

const fx = await DurableFx.open({
  storage: sqlite("./.examples/hello.db"),
  runtimes: { chat: { tools: [clock], instructions: "Be brief." } },
  ...modelTransport((req) => {
    const users = req.messages.filter((m) => m.role === "user")
    return { text: `(scripted) I have seen ${users.length} message(s) from you. Latest: "${req.userText}"` }
  })
})

const agent = await fx.agent("assistant", { runtime: "chat", model: MODEL })
const prompt = process.argv[2] ?? "Hello!"
const submission = await agent.submit(prompt, { requestId: `hello:${prompt}` })

for await (const event of submission.events()) {
  console.log(`#${event.sequence} ${event.type}`)
}
console.log((await submission.result()).text)
await fx.close()
