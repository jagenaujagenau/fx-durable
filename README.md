<div align="center">

# fx-durable

Agents should outlive their processes.

[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](tsconfig.json)
[![Effect](https://img.shields.io/badge/Effect-v4-000000?style=for-the-badge)](https://effect.website)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](src/durable/sqlite/storage.ts)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

## What is this?

fx-durable builds durable agents on [libfx](https://github.com/vercel-labs/fx/tree/main/sdk). When the process
crashes, the machine restarts, or the client disconnects, the agent carries on, and it never reports an uncertain side
effect as a success.

libfx keeps each conversation as a durable session: it stores every step of a turn, continues a turn a crash cut off,
queues requests, and replays events from any point. fx-durable adds what an agent runtime needs around those
sessions:

- **Tools with replay policies.** A journal of tool calls, keyed by libfx's call id, gives each call exactly one
  recorded outcome: completed work is never redone, a safe call runs again, and an unsafe one that may have run is
  reported as unknown instead of being retried.
- **Typed documents** that tools write in the same transaction as their result.
- **Tools calling tools**, **subagents**, and **extensions** that bundle tools, instructions, and hooks.
- **Stable agents** that move between sessions on reset, fork, or a change of tools.
- **Usage and cost**, ready-made **coding tools**, and a **test kit** with a scripted model and a crash matrix.

> fx-durable builds on the durable sessions of the next libfx release. Until it ships, it pins
> `libfx@0.0.13-dev.1432.g1df91f0b4ebf`.

## Quick Start

Requires Node.js 22.13+ (for the built-in `node:sqlite`) and pnpm.

```ts
import { Schema } from "effect"
import { DurableFx, defineDurableTool, sqlite } from "fx-durable"

const search = defineDurableTool({
  name: "search",
  replay: "safe",
  inputSchema: Schema.Struct({ query: Schema.String }),
  execute: ({ query }) => searchCode(query)
})

const deploy = defineDurableTool({
  name: "deploy",
  replay: "unsafe",
  inputSchema: Schema.Struct({ version: Schema.String }),
  execute: ({ version }, { signal }) => deployVersion(version, { signal })
})

const fx = await DurableFx.open({
  storage: sqlite("./fx.db"),
  runtimes: { coding: { tools: [search, deploy], instructions: "You are a careful engineer." } }
})

const agent = await fx.agent("engineer", { runtime: "coding", model: "anthropic/claude-sonnet-4.5" })
const submission = await agent.submit("Fix issue #382", { requestId: "github-382" })

for await (const event of submission.events()) if (event.type === "text_delta") process.stdout.write(event.delta)
const result = await submission.result() // { text, stopReason, usage }
```

Credentials come from `AI_GATEWAY_API_KEY` or `DurableFx.open({ apiKey })`. Opening fx-durable continues every
request a previous process left unfinished; pass `recovery: "manual"` to do that later with `fx.resume()`.

The examples run offline with a scripted model (or against the AI Gateway when `AI_GATEWAY_API_KEY` is set):

```bash
pnpm install && pnpm build
npx tsx examples/unsafe-tool/index.ts --crash   # the deploy starts, then the process is killed
npx tsx examples/unsafe-tool/index.ts           # the deploy is not run again; the agent inspects production
```

## Usage

### Without Effect

fx-durable is built on Effect, but the main `fx-durable` entry doesn't require it. Every call returns a Promise or an
AsyncIterable, errors are ordinary `Error` subclasses with a `_tag`, and records are plain objects. Tool input can be
validated with Effect Schema, any [Standard Schema](https://standardschema.dev) library, or a plain JSON Schema:

```ts
import { z } from "zod"

const forecast = defineDurableTool({
  name: "forecast",
  replay: "safe",
  inputSchema: z.object({ city: z.string(), days: z.number().int().min(1).max(7) }),
  execute: ({ city, days }) => getForecast(city, days)
})
```

The JSON Schema the model sees comes from the validator when it implements Standard JSON Schema, as Zod 4 does.
Otherwise pass `jsonSchema` yourself.

`fx-durable/effect` exposes the Effect-native side: the service graph as one `Layer` (`durableFxLayer`), the service
tags, and the `Database` boundary.

### Replay policies

Each tool declares what may happen to a call that a crash cut off.

| Policy | A call cut off by a crash | Examples |
|--------|---------------------------|----------|
| `"safe"` | Runs again | read file, grep, git status |
| `{ strategy: "idempotent", key }` | Runs again with the same idempotency key | payment APIs that take idempotency keys |
| `"unsafe"` | Recorded as `outcome_unknown`, never run again on its own | deploy, send email, git push |

A call that completed is never run again, whatever its policy: when libfx continues the turn, the call's recorded
result is used. An unsafe call that may have run reaches the model as an error saying it may have partly run, so the
model checks before acting. A tool that knows its request went out but can't tell whether it took effect can throw
`new OutcomeUnknown(message)`.

Tools that write shared state, such as files, can set `writes: true`: libfx then never runs them alongside the other
calls of the same model response.

### Requests, reconnecting, and cancelling

```ts
const submission = await agent.submit("Fix the failing tests", { requestId: "ci-1234" })
await agent.submit("Fix the failing tests", { requestId: "ci-1234" }) // the same request: nothing new runs

for await (const line of agent.events({ after: lastCursor })) {
  // the session's events after the cursor, then live ones; each line has a `cursor`
}

await agent.steer("Use pnpm, not npm.") // reaches the model at its next request
await submission.cancel()
```

A request is recorded, then stored by libfx, before `submit()` resolves. It runs after the agent's earlier requests,
and a client that disconnects doesn't stop it. `steer()` adds guidance to the turn that is running (or to the next
one). Cancelling a turn aborts its tool calls; an unsafe call that was running is recorded as `outcome_unknown`,
because stopping it locally doesn't prove the external effect stopped.

### Reset, handoff, and forks

```ts
await agent.reset()                                        // the next request starts a new conversation
await agent.reset({ summary: "We are migrating to v2." })  // a handoff: the model sees this in its instructions

const variant = await agent.fork("engineer-variant", { model: "anthropic/claude-opus-4.6" })
```

A fork continues from the conversation as it is now, in a session of its own; the source is not touched. It keeps the
runtime, model, and working directory unless you override them, and its documents follow their fork policies.

### Tools calling tools

```ts
const release = defineDurableTool({
  name: "release",
  replay: "safe",
  execute: async ({ version }, { executeTool }) => {
    await executeTool("run_tests", {})
    return executeTool("deploy", { version }) // a journaled call of its own
  }
})
```

A nested call is journaled under its caller, runs the hooks (which see `call.caller`), and keeps its own replay
policy. When the caller runs again after a crash, a nested call with the same key, tool, and input gets its recorded
outcome back instead of running again, so a safe `release` reruns without deploying twice. Each nested call is keyed
by its position, or by `executeTool(name, input, { key })`. Set `callers: "tools"` on a tool that only other tools may
call: the model is not offered it.

### Subagents

```ts
import { defineSubagent } from "fx-durable"

const research = defineSubagent({ name: "research", description: "Investigate a question and report back", runtime: "researcher" })

const fx = await DurableFx.open({
  storage: sqlite("./fx.db"),
  runtimes: {
    coding: { tools: [readFile, editFile, research] },
    researcher: { tools: [readFile, grep], instructions: "Answer with evidence. Do not edit files." }
  }
})
```

A subagent is a tool that hands a task to a child agent and returns its answer. The child is an ordinary agent named
after the parent and the call (`fx.attach(childId)` shows its events), and it reports what it says as the call's
progress. When a crash cuts the call off, libfx runs it again under the same id, and it attaches to **the same child
and the same request**. Cancelling the parent's turn cancels the child's request.

### Documents

```ts
import { defineDocument } from "fx-durable"

const Todos = defineDocument<{ items: string[] }>({ kind: "app.todos", version: 1, scope: "agent", initial: () => ({ items: [] }) })

const addTodo = defineDurableTool({
  name: "add_todo",
  replay: "safe",
  inputSchema: Schema.Struct({ item: Schema.String }),
  execute: async ({ item }, { documents }) => {
    await documents.update(Todos, (todos) => void todos.items.push(item))
    return `added ${item}`
  }
})

await agent.document(Todos)
await agent.updateDocument(Todos, () => ({ items: [] }))
for await (const todos of agent.watchDocument(Todos)) render(todos)
```

Documents are typed JSON stored with fx-durable's records, one per agent (`scope: "agent"`) or one for the whole
runtime (`scope: "global"`, through `fx.document()`). A tool's writes commit **in the same transaction as its
result**: a call that fails or is cut off by a crash writes nothing, and a call that runs again writes once. Updates
run again at commit on the value current then, so parallel calls compose; keep them pure and synchronous. To change a
document's shape, raise `version` and add `migrate(value, fromVersion)`. A fork gets a copy of each agent document, or
its initial value with `fork: "initial"`.

### Extensions

```ts
import { defineExtension } from "fx-durable"

const todo = defineExtension({
  name: "todo",
  tools: [addTodo],
  // Text, or a function rendered before each request: here the model sees the current list.
  instructions: async ({ document }) => {
    const { items } = await document(Todos)
    return items.length ? `Your todo list:\n${items.map((i) => `- ${i}`).join("\n")}` : undefined
  },
  hooks: { beforeTool: (call) => (call.name === "bash" ? { block: "No shell here." } : undefined) }
})

const fx = await DurableFx.open({ storage, runtimes: { coding: { tools: [readFile], extensions: [todo] } } })
await agent.setExtensions([todo, "web"])      // this agent's choice, in order; null goes back to the runtime's
await fx.installExtension(defineExtension({ name: "todo", tools: [addTodoV2] })) // a reload: replaces "todo"
```

An agent's tools, instructions, and hooks are its runtime's, then those of its extensions in order. A reload takes
effect at once for the calls that start after it. When an agent's set of tools changes, its next request (once none of
its requests is running) continues the conversation in a new session. Only the agent's choice of names is stored;
forks copy it. Two extensions bringing a tool of the same name make `submit()` reject until that is fixed.

### Hooks

```ts
runtimes: {
  coding: {
    tools: [readFile, editFile, bash],
    hooks: {
      beforeTool: async (call, { signal }) => (call.name === "bash" && !(await askUser(call.input, signal)) ? { block: "The user said no." } : undefined),
      afterTool: (call, output) => redactSecrets(output)
    }
  }
}
```

`beforeTool` runs before a call's intent is journaled. It can block the call (the model receives the message as the
tool's error) or replace its input. Until it allows the call, nothing has started: a crash during a slow decision, such
as a permission prompt, leaves nothing behind, and the call asks again when libfx runs it again. `afterTool` can
replace a result before it is journaled. Calls answered from the journal skip both.

### Coding tools

```ts
import { createCodingTools } from "fx-durable/tools"

const tools = createCodingTools() // works in the agent's cwd
const fx = await DurableFx.open({ storage: sqlite("./fx.db"), runtimes: { coding: { tools: tools.all }, explorer: { tools: tools.readOnly } } })
await fx.agent("engineer", { runtime: "coding", model: "anthropic/claude-sonnet-4.5", cwd: "/path/to/repo" })
```

| Tool | Replay | After a crash |
|------|--------|---------------|
| `read_file`, `list_files`, `glob`, `grep` | safe | read again |
| `write_file` | safe, `writes` | writing the same content twice is harmless |
| `edit_file` | safe, `writes` | an edit that is already applied reports `alreadyApplied` |
| `bash` | unsafe, `writes` | `outcome_unknown`; never run again on its own |

`bash` streams its output through `context.progress` (kept in the call's journal entry while it runs) and runs without
environment variables whose names look like credentials. Paths outside the workspace are refused, which keeps a model
on track but is not a sandbox.

### Usage and cost

```ts
const usage = await agent.usage({ prices: { "anthropic/claude-sonnet-4.5": { input: 3, output: 15, cacheRead: 0.3 } } })
usage.total // { turns, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, costUsd }
await fx.usage() // every agent
```

Totals add up the usage libfx reports for each finished turn, so any price table can be applied later. Prices are USD
per million tokens; cache prices default to the input price.

### Where things are stored

fx-durable keeps its own records (agents, requests, the tool-call journal, documents) in `storage`: `sqlite(path)`,
`openMemoryStorage()`, or your own `Storage`. libfx keeps the conversations in session stores. The libfx agents that
share a store share its work, so fx-durable keeps one store per set of tools: by default a directory next to the
database (`<db>.sessions/<store>`), or memory. Pass `durability: (store) => …` to put them elsewhere, such as a
Workflow World through libfx's `world()`. A single durability, such as `vercel()`, holds the sessions of one tool set.

A storage error closes fx-durable, since the in-memory view may no longer match what is stored: the call that hit it
rejects with the `StorageError`, later calls reject with `DurableFxFailedError`, and `fx.closed` settles. Opening again
continues from what was committed.

## Guarantees

The [crash suite](tests/crash/crash-matrix.test.ts) checks each of these by killing real processes with SIGKILL.

- **Intent is saved before the effect.** A tool call is journaled as running, then executed, then its result is
  journaled.
- **Unknown stays unknown.** An unsafe call that started and has no recorded result becomes `outcome_unknown`, and the
  model is told it may have partly run.
- **Completed work isn't redone.** A completed call is answered from the journal, nested calls included.
- **A tool's document writes happen exactly when its result does.**
- **Requests are idempotent.** The same `requestId` is the same request, across processes.
- **Agents are stable.** `fx.agent("engineer")` is the same agent, in the same conversation, after every restart.

libfx `0.0.13-dev.1432` starts a call to a tool that may run twice before storing it. A crash in that instant loses
the call, and the model calls again with a new id; fx-durable matches such a call to the journal entry of the lost one
(same request, tool, and input), so its nested calls and idempotency key carry over. libfx's main branch stores those
calls first; the matching becomes unnecessary once that ships.

## How it works

```text
               libfx              durable sessions: turns, steps, model calls,
                 │                queue, leases, event streams
               Effect             request follow-up, tool executor, session stores
                 │
              Database            run(journal => …) · read(storage => …)
                 │
     ── durability boundary ──
                 │
              Journal             every durable transition of fx-durable's records
                 │
              Storage             synchronous transactions (SQLite in WAL mode)
```

**libfx owns the conversation.** Each fx-durable agent points at a libfx session. A request is recorded, then prompted
into that session under a `messageId`; this process follows the turn to record its answer and outcome. After a crash,
fx-durable prompts every unfinished request again under the same `messageId`, and libfx continues the turn from its
last step (or reports how it already ended).

**fx-durable owns the tool calls.** Every tool is wrapped: the wrapper journals the call (keyed by session, libfx's
`executionId`, and the nested key) before it runs, and its result after. When libfx runs a call again, the journal
decides what that means. Unsafe tools are declared to libfx as not idempotent, so libfx never runs them twice; when
a turn ends, any of its calls still marked running are recorded as `outcome_unknown`.

**The durable core is plain synchronous code.** `Storage` is a synchronous interface with a transaction function
whose body must be synchronous, and the `Journal` on top holds every durable transition as a named method. Runtime
code reaches it only through the `Database` service, which a lint rule enforces.

### Custom storage

`DurableFx.open({ storage })` accepts any object implementing `Storage`. It must keep the durability contract
documented on the interface (atomic and nesting transactions, rollback on exceptions, no async bodies, reads that see
their own writes, `afterCommit` after the outermost commit, durable commits, and the uniqueness constraints). Check it
with the conformance suite:

```ts
import { storageContract } from "fx-durable/testing"

for (const check of storageContract) test(check.name, () => check.run(openMyStorage()))
```

## Testing

```bash
pnpm test
```

- **Journal and storage** (`tests/journal/`, `tests/storage/`): every transition, and the storage contract against
  SQLite and memory.
- **libfx assumptions** (`tests/libfx/`): what fx-durable relies on in libfx, checked against libfx alone.
- **Agents, documents, extensions, nested calls, subagents, usage, coding tools.**
- **The crash suite** (`tests/crash/`): it runs a real app process, kills it at a named crash point, runs it again,
  and checks a side-effect ledger and the records: the unsafe effect ran at most once, one request per `requestId`,
  nothing left running, unknown outcomes recorded as unknown.

`scriptedModel(script)` from `fx-durable/testing` answers libfx's model requests from a function, so the real libfx
runs offline. Scripts that should survive a crash decide from `request.allToolResults`: when libfx continues a turn, it
adds user messages of its own. You can inject crashes into your own app the same way the suite does:

```bash
FXD_CRASH_AT=tool.after-execute FXD_CRASH_NAME=deploy node app.js
```

## Project Structure

```
fx-durable/
├── examples/                # runnable examples (offline with a scripted model)
├── src/
│   ├── domain/              # schemas, documents, usage, errors
│   ├── durable/             # Journal, Storage, SQLite, memory (plain synchronous code)
│   ├── runtime/             # Database boundary, agents and sessions, tool executor, registries (Effect)
│   ├── testing/             # scripted model, storage contract
│   ├── tools/               # defineDurableTool, hooks, subagents, extensions, coding tools
│   ├── effect.ts            # Effect-native entry
│   └── index.ts             # main entry, no Effect required
├── tests/
│   ├── agents/              # requests, sessions, reset, forks, events, steering, cancelling
│   ├── crash/               # SIGKILL crash matrix
│   ├── documents/
│   ├── extensions/
│   ├── fixtures/            # app process the crash suite kills
│   ├── journal/
│   ├── libfx/               # libfx behavior fx-durable relies on
│   ├── nested/              # tools calling tools, progress, subagents
│   ├── storage/             # storage contract, SQLite and memory
│   ├── tools/               # coding tools
│   └── usage/
└── tools/oxlint/            # lint rules
```

## Contributing

Run `pnpm typecheck && pnpm lint && pnpm test` before opening a change. New durable behavior belongs in the Journal,
with tests in `tests/journal/`; changes to tool execution or recovery need a case in the crash suite, and the suite
should pass on repeated runs.

## License

[MIT](LICENSE)
