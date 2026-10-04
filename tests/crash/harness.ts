import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync, type SQLOutputValue } from "node:sqlite"
import { Option, Schema } from "effect"
import { crashEnv, type CrashPlan } from "../../src/runtime/crash.js"

const FIXTURE = resolve(import.meta.dirname, "../fixtures/agent-process.ts")

/** The JSON line the fixture prints when it finishes. */
const ProcessOutput = Schema.Struct({
  ok: Schema.Boolean,
  submissionId: Schema.String,
  result: Schema.optional(Schema.Struct({ text: Schema.String })),
  error: Schema.optional(Schema.String)
})
type ProcessOutput = typeof ProcessOutput.Type
const decodeOutput = Schema.decodeUnknownOption(Schema.fromJsonString(ProcessOutput))

/** One external side effect recorded by a fixture tool. */
const LedgerEntry = Schema.Struct({ effect: Schema.String, detail: Schema.JsonObject, pid: Schema.Number })
type LedgerEntry = typeof LedgerEntry.Type
const decodeLedgerEntry = Schema.decodeUnknownSync(Schema.fromJsonString(LedgerEntry))

export type Row = Record<string, SQLOutputValue>

export interface RunResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly output: ProcessOutput | null
}

export interface Sandbox {
  readonly dir: string
  readonly db: string
  readonly ledger: string
  run(options?: {
    crash?: CrashPlan
    scenario?: string
    requestId?: string
    env?: Record<string, string>
    timeoutMs?: number
  }): RunResult
  ledgerEntries(): Array<LedgerEntry>
  count(effect: string): number
  query(sql: string, ...params: Array<string | number>): Array<Row>
}

/** `crashAt("tool.after-execute")` — a crash plan for the next process run. */
export const crashAt = (point: string, name?: string, occurrence?: number): CrashPlan => ({ point, name, occurrence })

export const sandbox = (scenario = "deploy"): Sandbox => {
  const dir = mkdtempSync(join(tmpdir(), "fxd-crash-"))
  const db = join(dir, "fx.db")
  const ledger = join(dir, "ledger.jsonl")
  const self: Sandbox = {
    dir,
    db,
    ledger,
    run(options = {}) {
      const env = {
        ...process.env,
        FXD_TEST_DB: db,
        FXD_TEST_LEDGER: ledger,
        FXD_TEST_SCENARIO: options.scenario ?? scenario,
        FXD_TEST_REQUEST_ID: options.requestId ?? "req-1",
        FXD_CRASH_QUIET: "1"
      }
      if (options.crash) Object.assign(env, crashEnv(options.crash))
      Object.assign(env, options.env)
      const child = spawnSync(process.execPath, ["--import", "tsx", FIXTURE], {
        env,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 60_000
      })
      const line = child.stdout.trim().split("\n").filter(Boolean).pop() ?? ""
      const output = Option.getOrNull(decodeOutput(line))
      return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, output }
    },
    ledgerEntries() {
      if (!existsSync(ledger)) return []
      return readFileSync(ledger, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeLedgerEntry(line))
    },
    count(effect) {
      return self.ledgerEntries().filter((e) => e.effect === effect).length
    },
    query(sql: string, ...params: Array<string | number>) {
      const handle = new DatabaseSync(db, { readOnly: true })
      try {
        return handle.prepare(sql).all(...params)
      } finally {
        handle.close()
      }
    }
  }
  return self
}

/** Invariants that must hold after any crash + successful recovery. */
export const assertInvariants = (box: Sandbox, expect: typeof import("vitest").expect) => {
  // submission requestId never creates duplicate logical work
  const subs = box.query("SELECT COUNT(*) AS n FROM submissions WHERE request_id = 'req-1'")
  expect(subs[0]!.n).toBe(1)
  // unsafe effect occurs <= 1 time automatically
  expect(box.count("deploy")).toBeLessThanOrEqual(1)
  // nothing left running
  const open = box.query("SELECT id, type, state FROM tasks WHERE state IN ('running', 'pending')")
  expect(open).toEqual([])
  const activeTurns = box.query("SELECT id FROM turns WHERE state IN ('running', 'interrupted')")
  expect(activeTurns).toEqual([])
  // unknown external state is represented as unknown — in task state AND event history
  const unknown = box.query("SELECT id FROM tasks WHERE state = 'outcome_unknown'")
  for (const task of unknown) {
    const events = box.query("SELECT id FROM events WHERE type = 'tool.outcome_unknown' AND task_id = ?", String(task.id))
    expect(events.length).toBe(1)
  }
  // checkpoints are contiguous and one per completed turn
  const seqs = box.query("SELECT sequence FROM checkpoints ORDER BY sequence").map((r) => Number(r.sequence))
  expect(seqs).toEqual(seqs.map((_, i) => i + 1))
  const completedTurns = box.query("SELECT COUNT(*) AS n FROM turns WHERE state = 'completed'")
  expect(seqs.length).toBe(completedTurns[0]!.n)
  // event sequences are gap-free per agent
  const events = box.query("SELECT sequence FROM events WHERE agent_id = 'engineer' ORDER BY sequence")
  expect(events.map((e) => Number(e.sequence))).toEqual(events.map((_, i) => i + 1))
}

export const eventTypes = (box: Sandbox): Array<string> =>
  box.query("SELECT type FROM events ORDER BY sequence").map((e) => String(e.type))
