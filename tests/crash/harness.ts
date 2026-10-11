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
  run(options?: { crash?: CrashPlan; env?: Record<string, string>; timeoutMs?: number }): RunResult
  ledgerEntries(): Array<LedgerEntry>
  count(effect: string): number
  query(sql: string, ...params: Array<string | number>): Array<Row>
}

/** `crashAt("tool.after-execute", "deploy")`: a crash plan for the next process run. */
export const crashAt = (point: string, name?: string, occurrence?: number): CrashPlan => ({ point, name, occurrence })

export const sandbox = (scenario: string): Sandbox => {
  const dir = mkdtempSync(join(tmpdir(), "fxd-crash-"))
  const db = join(dir, "fx.db")
  const ledger = join(dir, "ledger.jsonl")
  const self: Sandbox = {
    dir,
    db,
    run(options = {}) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FXD_TEST_DB: db,
        FXD_TEST_LEDGER: ledger,
        FXD_TEST_SCENARIO: scenario,
        FXD_CRASH_QUIET: "1"
      }
      if (options.crash) Object.assign(env, crashEnv(options.crash))
      Object.assign(env, options.env)
      const child = spawnSync(process.execPath, ["--import", "tsx", FIXTURE], { env, encoding: "utf8", timeout: options.timeoutMs ?? 60_000 })
      const line = child.stdout.trim().split("\n").filter(Boolean).pop() ?? ""
      return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, output: Option.getOrNull(decodeOutput(line)) }
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
    query(sql, ...params) {
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

/** Invariants that must hold after any crash and successful recovery. */
export const assertInvariants = (box: Sandbox, expect: typeof import("vitest").expect) => {
  // A requestId never creates duplicate logical work.
  expect(box.query("SELECT COUNT(*) AS n FROM submissions WHERE request_id = 'req-1'")[0]!.n).toBe(1)
  // An unsafe effect occurs at most once automatically.
  expect(box.count("deploy")).toBeLessThanOrEqual(1)
  // Nothing is left running.
  expect(box.query("SELECT id FROM submissions WHERE state = 'running'")).toEqual([])
  expect(box.query("SELECT name, call_key FROM tool_calls WHERE state = 'running'")).toEqual([])
}

export const toolCalls = (box: Sandbox) =>
  box.query("SELECT name, call_key, state, attempts FROM tool_calls ORDER BY rowid").map((r) => ({
    name: String(r.name),
    key: String(r.call_key),
    state: String(r.state),
    attempts: Number(r.attempts)
  }))
