/**
 * The central thesis against the real system: a real model through the real
 * AI Gateway, the real libfx kernel, real tool processes, and `kill -9`.
 *
 * Opt-in: runs only when AI_GATEWAY_API_KEY is set (`pnpm test:live`).
 * FXD_TEST_MODEL picks the model (default anthropic/claude-sonnet-4.5).
 *
 * Hard assertions cover what fx-durable guarantees. What the model chooses to
 * do is logged, not asserted, because a real model is not deterministic.
 */
import { describe, expect, it } from "vitest"
import { crashAt, eventTypes, sandbox, type Sandbox } from "../crash/harness.js"

const LIVE = Boolean(process.env.AI_GATEWAY_API_KEY)
const TIMEOUT = 180_000

const DEPLOY_INSTRUCTIONS = [
  "You are a release bot. Your tools: read_file, deploy, check_deploy.",
  'To ship: call read_file with path "package.json", then call deploy with version "abc123" exactly once, then reply "Deployed abc123."',
  "If you are told that a previous deploy's outcome is unknown, do NOT call deploy.",
  'Instead call check_deploy with version "abc123" and report what is live in one sentence.'
].join("\n")

const TESTS_INSTRUCTIONS = [
  "You are a CI bot. Your tool: run_tests.",
  'Call run_tests with command "npm test" exactly once, then report the result in one sentence.'
].join("\n")

const live = (
  box: Sandbox,
  options: { scenario: string; instructions: string; prompt?: string; requestId?: string; crash?: ReturnType<typeof crashAt> }
) => {
  const env: Record<string, string> = {}
  env.FXD_TEST_LIVE = "1"
  env.FXD_TEST_INSTRUCTIONS = options.instructions
  if (options.prompt !== undefined) env.FXD_TEST_PROMPT = options.prompt
  return box.run({ scenario: options.scenario, requestId: options.requestId ?? "req-1", timeoutMs: TIMEOUT, env, crash: options.crash })
}

const note = (message: string) => process.stdout.write(`    [live] ${message}\n`)

describe.skipIf(!LIVE)("real AI Gateway + libfx + kill -9", () => {
  it(
    "unsafe effect happens, process dies before the result commits: outcome_unknown, no automatic replay",
    () => {
      const box = sandbox("deploy")
      const crashed = live(box, { scenario: "deploy", instructions: DEPLOY_INSTRUCTIONS, crash: crashAt("tool.after-execute", "deploy") })
      expect(crashed.signal, `the model never called deploy, so the crash point was not reached:\n${crashed.stdout}\n${crashed.stderr}`).toBe("SIGKILL")
      expect(box.count("deploy"), "the external effect happened before the crash").toBe(1)

      const recovered = live(box, { scenario: "deploy", instructions: DEPLOY_INSTRUCTIONS })
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(recovered.output?.ok, JSON.stringify(recovered.output)).toBe(true)

      // The uncertain effect is represented as unknown, in task state and history.
      const unknown = box.query("SELECT id FROM tasks WHERE name = 'deploy' AND state = 'outcome_unknown'")
      expect(unknown).toHaveLength(1)
      expect(box.query("SELECT id FROM events WHERE type = 'tool.outcome_unknown' AND task_id = ?", String(unknown[0]!.id))).toHaveLength(1)

      // Never replayed automatically.
      const types = eventTypes(box)
      expect(box.query("SELECT id FROM tasks WHERE name = 'deploy' AND parent_task_id IS NOT NULL AND attempt = 1")).toEqual([])
      expect(types.filter((t) => t === "tool.replayed")).toEqual([])

      // If the model asked to deploy again, the first repeat was refused before anything ran.
      const deploys = box.count("deploy")
      if (deploys > 1) {
        expect(types).toContain("tool.outcome_unknown_refused")
        const refusedAt = types.indexOf("tool.outcome_unknown_refused")
        const secondStart = box
          .query("SELECT sequence FROM events WHERE type = 'tool.started' AND task_id IN (SELECT id FROM tasks WHERE name = 'deploy') ORDER BY sequence")
          .map((row) => Number(row.sequence))[1]
        expect(secondStart).toBeGreaterThan(refusedAt + 1)
      }

      expect(box.query("SELECT id FROM tasks WHERE state IN ('running', 'pending')")).toEqual([])
      expect(box.query("SELECT COUNT(*) AS n FROM submissions").map((row) => Number(row.n))).toEqual([1])

      note(`deploy executions: ${deploys} (1 means the model did not redeploy)`)
      note(`model inspected state with check_deploy: ${box.count("check_deploy") > 0}`)
      note(`model tried to redeploy and was refused: ${types.includes("tool.outcome_unknown_refused")}`)
      note(`final answer: ${recovered.output?.result?.text ?? ""}`)
    },
    TIMEOUT * 2
  )

  it(
    "a safe tool killed mid-execution is replayed and the turn continues",
    () => {
      const box = sandbox("tests")
      const crashed = live(box, { scenario: "tests", instructions: TESTS_INSTRUCTIONS, crash: crashAt("test.during-safe-tool", "run_tests") })
      expect(crashed.signal, crashed.stdout + crashed.stderr).toBe("SIGKILL")
      const recovered = live(box, { scenario: "tests", instructions: TESTS_INSTRUCTIONS })
      expect(recovered.output?.ok, JSON.stringify(recovered.output)).toBe(true)
      expect(eventTypes(box)).toContain("tool.replayed")
      expect(box.query("SELECT id FROM tasks WHERE name = 'run_tests' AND state = 'completed'").length).toBeGreaterThanOrEqual(1)
      note(`run_tests executions: ${box.count("run_tests")}; answer: ${recovered.output?.result?.text ?? ""}`)
    },
    TIMEOUT * 2
  )

  it(
    "the conversation survives a process restart through the durable checkpoint",
    () => {
      const box = sandbox("chat")
      const instructions = "You are a terse assistant. Follow instructions exactly."
      const first = live(box, {
        scenario: "chat",
        instructions,
        requestId: "remember",
        prompt: "Remember this code word: PELICAN-42. Reply with only OK."
      })
      expect(first.output?.ok, JSON.stringify(first.output)).toBe(true)
      const second = live(box, {
        scenario: "chat",
        instructions,
        requestId: "recall",
        prompt: "What was the code word I gave you? Reply with only the code word."
      })
      expect(second.output?.ok, JSON.stringify(second.output)).toBe(true)
      expect(second.output?.result?.text ?? "").toContain("PELICAN-42")
    },
    TIMEOUT * 2
  )
})
