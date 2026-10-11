# Changelog

## Unreleased

### Breaking

- Custom `Storage` implementations must persist `TaskRecord.callerTaskId` and `callKey` (nested tool calls). SQLite
  migrates itself (migration 3); the storage contract checks them.
- `Storage` gains `abandonedTasks()`: interrupted tool tasks of ended turns that no task retries. SQLite adds an
  index for it (migration 4); the storage contract checks it.
- `DurableTool` has an `abandon` field (null unless set), and `AgentSupervisor` (`fx-durable/effect`) an `abandon`
  method.
- `ToolCall` (hooks) has a `caller` field, and `ToolExecutor.execute`/`replay` (`fx-durable/effect`) take the
  agent's tools.
- Custom `Storage` implementations must persist two new fields: `SubmissionRecord.kind` (`"input"`, `"reset"` or
  `"compaction"`) and `AgentCheckpoint.summary` (string or null). SQLite storage migrates itself (migration 2), and
  the storage contract checks both.

### Changed

- An idempotent call cut off by `fx.close()` is now recorded as `interrupted`, as after a crash, so the recovered
  turn retries it with the same key. It used to be recorded as `outcome_unknown`: a repeat call was refused once,
  then ran with a new key, and for a subagent that started a second child.
- A tool's abort signal carries a reason: `"cancelled"`, or `"executor_lost"` when the process is stopping.
- **A storage error now closes fx-durable** instead of being logged and retried. The call that hit it rejects with
  the `StorageError`; calls that were waiting or come later reject with the new `DurableFxFailedError`. Reopening
  recovers from what was committed.
- A duplicate `requestId` that loses a race to another process is resolved in the Journal, so it never surfaces as a
  storage error.

### Fixed

- `fx.close()` cancelled running subagents: the subagent tool cancelled its child whenever its signal aborted, and
  stopping aborts in-flight calls. The child now keeps running, and the call resumes it after the restart.

### Added

- **Tools calling tools:** `context.executeTool(name, input, { key })`. A nested call is a durable task owned by its
  caller, with hooks and its own replay policy; a caller that runs again after a crash gets its journaled nested
  calls back by key. Calls left running when the caller returns are aborted. Two crash-matrix cases cover it.
- **Abandoned calls:** when a turn ends without calling an interrupted call again, the tool's `abandon` hook runs
  (at the next `resume()` if the process died first, retried until it succeeds) and the call is recorded as
  cancelled (`tool.abandoned`). Subagents use it to cancel the child's request, so a recovered turn that moves on
  leaves no orphaned subagent running.
- `agent.submission(requestId)`: the submission made with that request id, or null.
- `callers: "model" | "tools" | "both"` on tools; `"tools"` tools are not offered to the model.
- `fx.taskGraph()`: running work across agents with owner links (nested calls, subagents), plus queued requests.
- **Reset and handoff:** `agent.reset({ summary? })` starts a new context. With a summary, the model sees it in its
  instructions until the next reset. Queued like a request; recorded as `context.reset`.
- **Compaction:** `agent.compact({ instructions? })` asks the model for a summary and continues from it. It is a
  journaled turn (crash-safe, counted in `usage()`), with the agent's tools visible but not runnable.
  `RuntimeDefinition.compaction: { maxContextTokens, instructions? }` compacts automatically, before the next queued
  request.
- Steering sent during a reset or compaction is submitted as a new request instead of joining it.

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
