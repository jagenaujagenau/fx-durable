import { Context, Effect, Layer } from "effect"

/**
 * Deterministic crash injection. Failure testing is a first-class feature:
 * every boundary that matters for recovery has a named crash point.
 */
export const CRASH_POINTS = [
  "submission.after-persist",
  "turn.after-start",
  "model.before-request",
  "model.during-stream",
  "model.after-response",
  "tool.before-persist",
  "tool.after-persist",
  "tool.during-execute",
  "tool.after-execute",
  "tool.after-result-persist",
  "checkpoint.before-write",
  "checkpoint.during-write",
  "checkpoint.after-write",
  "recovery.started",
  "recovery.after-classify",
  "recovery.during-replay",
  "recovery.before-continue"
] as const

export type CrashPoint = (typeof CRASH_POINTS)[number]

export interface CrashContext {
  /** Tool name for tool points, model id for model points. */
  readonly name?: string | undefined
}

export interface CrashInjectorInterface {
  readonly hit: (point: CrashPoint | (string & {}), context?: CrashContext) => Effect.Effect<void>
}

export class CrashInjector extends Context.Service<CrashInjector, CrashInjectorInterface>()(
  "fx-durable/CrashInjector"
) {
  /** Production: crash points are no-ops. */
  static readonly noop = Layer.succeed(CrashInjector, CrashInjector.of({ hit: () => Effect.void }))

  /** Fire `onCrash` when `matches` returns true for a point. */
  static readonly make = (options: CrashPlan & { readonly onCrash: (point: string) => void }) =>
    Layer.sync(CrashInjector, () => {
      const counts = new Map<string, number>()
      return CrashInjector.of({
        hit: (point, context) =>
          Effect.sync(() => {
            if (point !== options.point) return
            if (options.name !== undefined && context?.name !== options.name) return
            const n = (counts.get(point) ?? 0) + 1
            counts.set(point, n)
            if (n === (options.occurrence ?? 1)) options.onCrash(point)
          })
      })
    })

  /**
   * Read a crash plan from the environment and terminate the process with
   * SIGKILL at the matching point — no finalizers, no flushes, exactly like
   * a power cut from the runtime's point of view.
   */
  static readonly fromEnv = (env: NodeJS.ProcessEnv = process.env) => {
    const plan = crashPlanFromEnv(env)
    if (!plan) return CrashInjector.noop
    return CrashInjector.make({ ...plan, onCrash: killNow })
  }
}

export interface CrashPlan {
  readonly point: string
  readonly name?: string | undefined
  readonly occurrence?: number | undefined
}

export const crashPlanFromEnv = (env: NodeJS.ProcessEnv): CrashPlan | null => {
  const point = env.FXD_CRASH_AT
  if (!point) return null
  return {
    point,
    name: env.FXD_CRASH_NAME || undefined,
    occurrence: env.FXD_CRASH_OCCURRENCE ? Number(env.FXD_CRASH_OCCURRENCE) : undefined
  }
}

export const crashEnv = (plan: CrashPlan) => {
  const env: Record<string, string> = {}
  env.FXD_CRASH_AT = plan.point
  if (plan.name) env.FXD_CRASH_NAME = plan.name
  if (plan.occurrence) env.FXD_CRASH_OCCURRENCE = String(plan.occurrence)
  return env
}

export const killNow = (point: string): never => {
  if (process.env.FXD_CRASH_QUIET !== "1") process.stderr.write(`\n[fx-durable] crash injected at ${point}\n`)
  process.kill(process.pid, "SIGKILL")
  // SIGKILL is delivered asynchronously on some platforms; never continue.
  while (true) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
}

/**
 * Hit a crash point from inside application code (e.g. a tool body) when the
 * process was started with a matching `FXD_CRASH_AT` plan.
 */
export const crashPoint = (point: string, name?: string): void => {
  const plan = crashPlanFromEnv(process.env)
  if (!plan || plan.point !== point) return
  if (plan.name !== undefined && plan.name !== name) return
  killNow(point)
}
