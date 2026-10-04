import type { Json } from "../core/json.js"
import type { ReplayPolicyName } from "../core/schema.js"

/**
 * How an interrupted tool call may be handled after a crash.
 *
 *   safe        → replay
 *   idempotent  → retry with the same idempotency key
 *   unsafe      → outcome_unknown, never replayed automatically
 */
export type ReplayPolicy =
  | "safe"
  | "unsafe"
  | {
      readonly strategy: "idempotent"
      /** Derive the stable key passed to the downstream system. Defaults to the task id. */
      readonly key?: (context: { readonly taskId: string; readonly input: Json }) => string
    }

export const policyName = (policy: ReplayPolicy): ReplayPolicyName =>
  policy === "safe" || policy === "unsafe" ? policy : "idempotent"

export const idempotencyKeyFor = (policy: ReplayPolicy, taskId: string, input: Json): string | null => {
  if (policy === "safe" || policy === "unsafe") return null
  return policy.key ? policy.key({ taskId, input }) : taskId
}

export type RecoveryAction = "replay" | "retry_with_same_key" | "mark_outcome_unknown"

/** Classification of an interrupted tool task, decided from its persisted policy. */
export const recoveryActionFor = (policy: ReplayPolicyName): RecoveryAction => {
  switch (policy) {
    case "safe":
      return "replay"
    case "idempotent":
      return "retry_with_same_key"
    case "unsafe":
      return "mark_outcome_unknown"
  }
}
