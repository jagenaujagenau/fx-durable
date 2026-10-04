# fx-durable code

A local coding agent UI in the style of Claude Code, built from three pieces:

- **[AI SDK harness](https://vercel.com/changelog/fx-ai-sdk-harness-adapter)**: `HarnessAgent` drives the agent and
  streams to `useChat`.
- **fx-durable**: the harness adapter in [`lib/fx-durable-harness.ts`](lib/fx-durable-harness.ts) runs the fx kernel
  (libfx) in-process, with every turn, model call, and tool call journaled in SQLite.
- **[AI Elements](https://ai-sdk.dev/elements)**: conversation, markdown, tool cards, code blocks, file tree, model
  picker, context meter, prompt input.

```ts
const agent = new HarnessAgent({ harness: createFxDurableHarness({ fx, runtime: "coding", tools, defaultModel }) })
const result = await agent.stream({ session, prompt })
return result.toUIMessageStreamResponse()
```

`@ai-sdk/harness-fx` runs the fx CLI inside a remote sandbox over ACP. This adapter implements the same `HarnessV1`
contract locally, so the app is ordinary AI SDK code and the agent survives its process.

## Run

```bash
# from the repo root
pnpm install && pnpm build

cd examples/web-ui
pnpm install
pnpm dev            # http://localhost:3100
```

Without `AI_GATEWAY_API_KEY`, a scripted model speaks the AI Gateway protocol, so everything runs offline (the libfx
kernel, the tools, the permission prompts are real; only the model's decisions are scripted). Put a key in
`.env.local` to use real models; `FXD_MODEL` picks the default.

Each new session gets a copy of [`workspace-template/`](workspace-template), a small project with two failing tests.
Or start a session in any directory on your machine (**New session** → path, or `/new /path/to/project`).

## Features

| | |
|---|---|
| Tools | `read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep`, `bash` (live output), `todo_write` |
| Subagent | `explore`: a read-only child agent (`defineSubagent`) for investigations; its work streams into the tool card |
| Streaming | Token-level text, tool calls as they start, terminal output, edit diffs |
| Permissions | Ask before edits / Accept edits / Plan mode (read-only) / Bypass; **Shift+Tab** cycles. Prompts offer *Yes*, *Yes for this session*, *No* (**Enter** / **Esc**) |
| Control | **Esc** interrupts the turn; typing while the agent works **steers** it (`agent.steer()`) |
| Commands | `/new [path]`, `/clear`, `/fork`, `/model [id]`, `/mode [mode]`, `/files`, `/journal`, `/cost`, `/compact`, `/help` |
| Sessions | Sidebar of durable sessions; switch freely, history is read back from the journal |
| Workspace | File tree and viewer that follow the agent's edits |
| Context | Context-window meter and per-session token totals |
| Durability | **Crash server (kill -9)** button; the supervisor restarts the server and fx-durable recovers the turn |

## Durability, concretely

- Kill the server mid-turn: on restart, fx-durable restores the pre-turn checkpoint and re-prompts the model with what
  the journal knows. The UI reconnects (SSE `Last-Event-ID`) and shows the recovered turn finishing.
- `bash` is `replay: "unsafe"`: an interrupted command becomes *outcome unknown* and is never re-run automatically.
- `write_file` and `edit_file` are replay-safe: both are idempotent (an edit that is already applied reports so).
- Read-only tools set `reuse: false`: after a crash they read the workspace again instead of returning what they saw
  before the agent's own later edits.
- Permission prompts run in the runtime's `beforeTool` hook, before fx-durable journals the call. A crash while a
  prompt is open leaves nothing half-started; the recovered turn asks again. Permission modes are saved in
  `.data/settings.json`, so a recovered turn runs under the mode you chose.
- Steering is journaled before it reaches the model, so a crash doesn't lose it: the recovered turn gets it too.
- A crash inside the `explore` subagent resumes the same child agent; it doesn't start a second one.
- `/fork` starts a new session from the latest checkpoint, with its own copy of the sample workspace.

## How it maps

| HarnessV1 | fx-durable |
|-----------|------------|
| `sessionId` | durable agent id (a new process attaches to the same journal) |
| `doPromptTurn` | `agent.submit()`, then the submission's events become stream parts |
| text streaming | the model transport tees the gateway stream (`TransportContext` says which agent and task) |
| built-in tools (`providerExecuted`) | `defineDurableTool` tools, executed and journaled by fx-durable |
| `doReadHistory` | the conversation rebuilt from the event log, tool outputs from `agent.task(id)` |
| `doSuspendTurn` / `doContinueTurn` | stop listening / re-attach to the event log from a sequence cursor |
| `doDetach` / `doStop` / `doDestroy` | stop listening; the journal stays in SQLite |

## Files

| File | Purpose |
|------|---------|
| [`lib/fx-durable-harness.ts`](lib/fx-durable-harness.ts) | The `HarnessV1` adapter |
| [`lib/tools.ts`](lib/tools.ts) | Coding tools, replay policies, system prompt |
| [`lib/live.ts`](lib/live.ts) | Live (non-durable) state: token deltas, permission prompts, modes |
| [`lib/runtime.ts`](lib/runtime.ts) | `DurableFx` + `HarnessAgent`, sessions, workspaces, streaming transport |
| [`lib/offline-script.ts`](lib/offline-script.ts) | The scripted model used without an API key |
| [`app/_components/`](app/_components) | The UI (AI Elements are vendored in `components/`) |
| [`app/api/`](app/api) | `chat`, `history`, `journal` (SSE), `sessions`, `session`, `approvals`, `cancel`, `files`, `config`, `crash` |
| [`scripts/supervise.mjs`](scripts/supervise.mjs) | Restarts `next dev` when it dies, like a process manager |

## Limits

- Host-executed tools (`HarnessAgent({ tools })`) are not supported: fx-durable runs and journals its own tools.
- No manual `/compact`; libfx manages its context and fx-durable checkpoints it after every turn.
- `bash` is not sandboxed. It runs on your machine, in the workspace, with your permission. Credentials (`*KEY`,
  `*TOKEN`, `*SECRET`) are removed from its environment.
- `FXD_DEBUG_STREAMS=1` saves each raw model response to `.data/streams/` for debugging.
