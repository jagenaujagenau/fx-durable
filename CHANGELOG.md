# Changelog

## Unreleased

fx-durable now depends on libfx 0.0.14, the stable release with durable sessions, instead of a dev build. fx-durable's
API does not change.

### Breaking

- **Conversations from 0.3 do not carry over.** libfx 0.0.14 deletes session stores written by the dev build 0.3 used
  (their storage layout changed), and a session older than a day cannot be prompted again. Opening a 0.3 database
  moves every agent to a new session on its next request. An agent waiting to start from a checkpoint (a fork, or a
  change of tools) keeps it. Requests that were running fail with "send the request again", and their running tool
  calls get an unknown outcome. Agents, documents, usage, and finished requests are kept.

### Fixed

- A request over libfx's input limit (8 MiB of JSON) fails with a `ModelError`. Before, it stayed running and every
  later open of the database failed while trying to resume it.

### Known libfx issues

- With `local()` durability, a steer stored a millisecond or so before a running tool returns misses that turn and
  runs as a turn of its own ([vercel-labs/fx#1342](https://github.com/vercel-labs/fx/issues/1342)).
- A crash in the first moments of a call to a tool that may run twice can lose the call; fx-durable still matches the
  model's new call to the lost one.

## 0.3.0

fx-durable is rebuilt on libfx's durable sessions (the next libfx release; until it ships, fx-durable pins
`libfx@0.0.13-dev.1432.g1df91f0b4ebf`). libfx now keeps each conversation itself: it stores every step of a turn,
continues a turn a crash cut off, queues requests, and replays events. fx-durable drops its own versions of those and
keeps what libfx does not do.

### Breaking

- **New storage.** fx-durable 0.2 databases are refused (their conversations lived in libfx checkpoints that libfx
  sessions don't read); open a new one. `Storage` now holds agents, requests, a tool-call journal, and documents; the
  storage contract checks it. libfx keeps conversations in session stores: by default a directory per tool set next
  to the SQLite file. `DurableFx.open({ durability })` takes a libfx durability, or a function from a store's name to
  one.
- **Recovery is libfx's.** A crashed turn continues from its last step instead of being re-prompted with a summary.
  Opening fx-durable prompts every unfinished request again under its `messageId`.
- **Events are libfx's stream lines.** `agent.events({ after })` reads the agent's session from a `cursor`;
  `submission.events()` gives the events of a turn this process follows. The fx-durable event log is gone.
- **Removed:** the `fxd` CLI and demo; compaction (`agent.compact()`, `RuntimeDefinition.compaction`); the turn,
  model-call, and checkpoint journal; `whenBusy: "reject"`; `agent.currentTurn()` and `agent.task()` (use
  `agent.toolCalls()`); tool options `reuse`, `resumeOnCall`, and `abandon` (libfx runs interrupted calls again
  itself); `RuntimeDefinition.createMcpClients`; rewindable documents and forking from an earlier request.
- `DurableToolContext` has `sessionId`, `executionId`, and `submissionId` instead of `turnId` and `taskId`.
  `ToolCall.caller` names the calling call's id. `ToolExecutionError` and `UnknownOutcomeError` carry `callId`.
- `usage()` totals finished turns (`turns` instead of `requests` and `failedRequests`).

### Added

- **A tool-call journal keyed by libfx's `executionId`.** Every tool call is journaled before it runs and its result
  after. When libfx runs a call again after a crash, a completed call answers from the journal, a safe or idempotent
  one runs again (with the same idempotency key), and an unsafe one is recorded as `outcome_unknown`. Unsafe tools
  are declared to libfx as not idempotent, so libfx never runs them twice.
- **Tools calling tools** (`context.executeTool(name, input, { key })`), journaled under their caller and answered
  from the journal when the caller runs again; `callers: "model" | "tools" | "both"`.
- **Documents** (`defineDocument`): typed JSON per agent or global, written by tools in the same transaction as their
  result, versioned with `migrate`, watched with `agent.watchDocument()`, and copied to forks by policy.
- **Extensions** (`defineExtension`): tools, instructions (rendered before each request, e.g. from documents), and
  hooks. Runtimes list defaults, agents choose their own, and `fx.installExtension()` reloads one by name. An agent
  whose tools change continues its conversation in a new session.
- `writes: true` on tools that must not run alongside others; the coding tools that write set it.
- `fx-durable/tools`: `createCodingTools()` (`read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep`,
  `bash`).
- `openMemoryStorage()`, `agent.usage()` / `fx.usage()` with prices, `fx.taskGraph()` (running requests and tool
  calls with what each runs for), `agent.toolCalls(sessionId, executionId)`.
- `scriptedModel` requests have `allToolResults`, for scripts that must survive libfx's resume messages.
- `tests/libfx/`: the libfx behaviors fx-durable relies on, checked against libfx alone.

### Fixed

- A tool call whose input JSON has line breaks no longer crashes the process: fx-durable re-serializes it before
  libfx's native backend sees it (vercel-labs/fx#1215).

## 0.2.0

### Breaking

- `Storage` gains `getCheckpoint(agentId, sequence)`. Custom storage implementations must add it (the SQLite
  storage and the storage contract include it).

### Added

- **Steering:** `agent.steer(text)` adds guidance to the running turn. It is journaled (`turn.steered`) before
  libfx receives it, and replayed into the recovery prompt after a crash. Guidance for an idle agent, or one that
  misses its turn, becomes a new submission.
- **Tool hooks:** `RuntimeDefinition.hooks` with `beforeTool` (block or rewrite a call, before its intent is
  journaled, so a crash during a permission prompt leaves no `outcome_unknown`) and `afterTool` (replace a result).
- **Progress:** `DurableToolContext.progress(chunk)`, and partial model text, kept in the running task's
  `metadata.progress` for viewers that attach mid-call.
- **Reject when busy:** `submit(content, { whenBusy: "reject" })` rejects with `AgentBusyError` instead of queueing.
- **Subagents:** `defineSubagent({ name, description, runtime, model })`, a tool that delegates to a child durable
  agent. A crash resumes the same child and request.
- **`resumeOnCall`** tool option (idempotent tools): not replayed during recovery; retried with the original
  idempotency key when the recovered turn calls it again.
- **Forks:** `agent.fork(id, { after, checkpoint, model, runtime, cwd })` starts a new agent from a checkpoint.
- **`reuse: false`** tool option (replay-safe tools): after a crash, run again instead of returning the journaled
  result, for tools that observe changing state.
- `agent.task(id)`: one journaled tool or model call with its input and output.
- `TransportContext`: model requests pass `{ agentId, submissionId, turnId, taskId, model }` to the transport.
- New events: `turn.steered`, `tool.blocked`, `agent.forked`. New errors: `ToolBlockedError`, `AgentBusyError`,
  `AgentExistsError`.

### Fixed

- A model call is journaled when its stream's `finish` part arrives. libfx can stop reading there, so a turn could
  complete before its last model call was recorded.
- Tool-call inputs with line breaks (pretty-printed JSON) are made single-line before libfx reads them; libfx
  0.0.12 failed the turn with "Unexpected end of JSON input".

## 0.1.0

First release.
