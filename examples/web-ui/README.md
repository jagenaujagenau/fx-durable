# fx-durable code

A local coding agent UI in the style of Claude Code, built from three pieces:

- **[AI SDK harness](https://vercel.com/changelog/fx-ai-sdk-harness-adapter)**: `HarnessAgent` drives the agent and
  streams to `useChat`.
- **fx-durable**: the harness adapter in [`lib/fx-durable-harness.ts`](lib/fx-durable-harness.ts) runs the fx kernel
  (libfx) in-process. libfx keeps each conversation as a durable session; fx-durable journals every tool call.
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
| Sessions | Sidebar of durable sessions; switch freely, history is read back from each agent's session |
| Workspace | File tree and viewer that follow the agent's edits |
| Context | Context-window meter and per-session token totals |
| Durability | **Crash server (kill -9)** button; the supervisor restarts the server and fx-durable recovers the turn |

## Durability, concretely

- Kill the server mid-turn: on restart, libfx continues the turn from its last step (completed tool calls keep their
  results). The UI reconnects (SSE `Last-Event-ID`) and shows the turn finishing.
- `bash` is `replay: "unsafe"`: a command a crash cut off becomes *outcome unknown* and is never run again
  automatically; the model is told it may have partly run.
- `write_file` and `edit_file` are replay-safe: both are idempotent (an edit that is already applied reports so).
  They and `bash` are `writes: true`, so libfx never runs them alongside other calls.
- Permission prompts run in the runtime's `beforeTool` hook, before fx-durable journals the call. A crash while a
  prompt is open leaves nothing half-started; the call asks again when the turn continues. Permission modes are
  saved in `.data/settings.json`, so a continued turn runs under the mode you chose.
- Steering is stored with the session before it reaches the model, so a crash doesn't lose it.
- A crash inside the `explore` subagent continues the same child agent; it doesn't start a second one.
- `/fork` starts a new session from the conversation as it is now, with its own copy of the sample workspace.

## How it maps

| HarnessV1 | fx-durable |
|-----------|------------|
| `sessionId` | durable agent id (a new process attaches to the same libfx session) |
| `doPromptTurn` | `agent.submit()`, then the turn's session stream lines become stream parts |
| text streaming | libfx's `text_delta` lines |
| built-in tools (`providerExecuted`) | `defineDurableTool` tools, executed and journaled by fx-durable |
| `doReadHistory` | the conversation read back from the session stream (`agent.events()`); a fork's starts with its source's |
| `doSuspendTurn` / `doContinueTurn` | stop listening / re-attach to the session stream from a cursor |
| `doDetach` / `doStop` / `doDestroy` | stop listening; the session stays in libfx's store |

## Files

| File | Purpose |
|------|---------|
| [`lib/fx-durable-harness.ts`](lib/fx-durable-harness.ts) | The `HarnessV1` adapter |
| [`lib/tools.ts`](lib/tools.ts) | Coding tools, replay policies, system prompt |
| [`lib/live.ts`](lib/live.ts) | Live (non-durable) state: permission prompts, modes, tool output, fork origins |
| [`lib/runtime.ts`](lib/runtime.ts) | `DurableFx` + `HarnessAgent`, sessions, workspaces |
| [`lib/offline-script.ts`](lib/offline-script.ts) | The scripted model used without an API key |
| [`app/_components/`](app/_components) | The UI (AI Elements are vendored in `components/`) |
| [`app/api/`](app/api) | `chat`, `history`, `journal` (SSE), `sessions`, `session`, `approvals`, `cancel`, `files`, `config`, `crash` |
| [`scripts/supervise.mjs`](scripts/supervise.mjs) | Restarts `next dev` when it dies, like a process manager |

## Limits

- Host-executed tools (`HarnessAgent({ tools })`) are not supported: fx-durable runs and journals its own tools.
- No manual `/compact`; libfx manages its context.
- `bash` is not sandboxed. It runs on your machine, in the workspace, with your permission. Credentials (`*KEY`,
  `*TOKEN`, `*SECRET`) are removed from its environment.
