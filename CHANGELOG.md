# Changelog

## Unreleased

### Changed

- **A storage error now closes fx-durable** instead of being logged and retried. The call that hit it rejects with
  the `StorageError`; calls that were waiting or come later reject with the new `DurableFxFailedError`. Reopening
  recovers from what was committed.
- A duplicate `requestId` that loses a race to another process is resolved in the Journal, so it never surfaces as a
  storage error.

### Added

- `fx.closed`: settles with `{ reason: "closed" }` after `close()`, or `{ reason: "failed", error }` after a storage
  error. `DatabaseInterface.onFailure` (`fx-durable/effect`) reports the first storage error.
- `agent.usage({ prices })` and `fx.usage({ prices })`: token and cost totals per model, folded from the event log.
  `model.completed` events now also record `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens`.
- `fx-durable/tools`: `createCodingTools()` with `read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep`,
  and `bash`, with replay policies chosen per tool.
- `DurableToolContext.cwd`: the agent's working directory.
- `openMemoryStorage()`: in-memory `Storage` that passes the storage contract (except durability).
- `ScriptedResponse.usage` in `fx-durable/testing`, to script token counts.
- `tests/libfx/`: the libfx checkpoint behavior fx-durable relies on (restoring with other tools, instructions, or
  model; the v1 checkpoint format), so a libfx upgrade that changes it fails the suite.

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
