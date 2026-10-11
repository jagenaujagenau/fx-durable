import type { Json } from "../domain/json.js"
import type { ReplayPolicyName } from "../domain/schema.js"

/**
 * What fx-durable does when a crash cut off a call and libfx runs it again:
 *
 *   safe        → run it again
 *   idempotent  → run it again with the same idempotency key
 *   unsafe      → outcome_unknown: the model is told it may have run, and it
 *                 is never run again automatically
 *
 * A call that completed is never run again, whatever its policy: its result
 * comes from the journal.
 */
export type ReplayPolicy =
  | "safe"
  | "unsafe"
  | {
      readonly strategy: "idempotent"
      /** Derive the stable key passed to the downstream system. Defaults to the call's id. */
      readonly key?: (context: { readonly callId: string; readonly input: Json }) => string
    }

export const policyName = (policy: ReplayPolicy): ReplayPolicyName =>
  policy === "safe" || policy === "unsafe" ? policy : "idempotent"

/** `callId` is stable across runs of one call: its session, libfx `executionId`, and nested key. */
export const idempotencyKeyFor = (policy: ReplayPolicy, callId: string, input: Json): string | null => {
  if (policy === "safe" || policy === "unsafe") return null
  return policy.key ? policy.key({ callId, input }) : callId
}
