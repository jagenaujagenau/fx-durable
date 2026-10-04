import { isJsonString, jsonText, type Json } from "./json.js"
import type { SubmissionContent, SubmissionRecord, TaskRecord, TurnRecord } from "./schema.js"

/** Pure helpers for reasoning about journaled tool calls. */

export const unknownOutcomeNotice = (tool: string, input: Json): string =>
  [
    `The previous \`${tool}\` operation was interrupted.`,
    `Input: ${JSON.stringify(input)}`,
    "It may or may not have completed successfully.",
    "Do not repeat it blindly.",
    "Inspect the current system state before deciding what to do."
  ].join("\n")

/** Follow replay/re-execution children to the task that currently decides a call's outcome. */
export const effectiveTask = (task: TaskRecord, all: ReadonlyArray<TaskRecord>): TaskRecord => {
  let current = task
  while (true) {
    const children = all.filter((t) => t.parentTaskId === current.id && t.type === "tool")
    const latest = children[children.length - 1]
    if (!latest) return current
    current = latest
  }
}

const contentText = (content: SubmissionContent): string =>
  isJsonString(content) ? content : content.map((block) => block.text).join("\n")

const preview = (value: Json, max = 2000): string => {
  const text = jsonText(value)
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text
}

/**
 * The prompt for a recovery attempt: the original request plus everything the
 * journal knows about the interrupted attempt(s). Completed work is listed so
 * it is not repeated; uncertain unsafe effects are called out explicitly.
 */
export const buildRecoveryPrompt = (
  submission: SubmissionRecord,
  turn: TurnRecord,
  tasks: ReadonlyArray<TaskRecord>,
  steering: ReadonlyArray<string> = []
): string => {
  const lines: Array<string> = [
    "[fx-durable recovery]",
    `The process running this turn stopped before it finished (attempt ${turn.attempt - 1}).`,
    "The conversation was restored to the start of this turn.",
    "",
    "Original request:",
    contentText(submission.content),
    ""
  ]
  if (steering.length > 0) {
    lines.push("Guidance the user added while the turn ran (still applies):")
    for (const text of steering) lines.push(`- ${text}`)
    lines.push("")
  }
  const originals = tasks.filter((t) => t.type === "tool" && t.parentTaskId === null)
  const unknown: Array<string> = []
  if (originals.length > 0) {
    lines.push("Tool calls already journaled for this turn:")
    for (const original of originals) {
      const effective = effectiveTask(original, tasks)
      const call = `${original.name} ${preview(original.input, 300)}`
      const replayed = effective.id !== original.id && original.state === "interrupted" ? " (interrupted, replayed automatically: replay-safe)" : ""
      switch (effective.state) {
        case "completed":
          lines.push(`- ${call} → completed${replayed}. Result: ${preview(effective.output)}`)
          break
        case "failed":
          lines.push(`- ${call} → failed${replayed}: ${effective.error ?? "error"}`)
          break
        case "outcome_unknown":
          lines.push(`- ${call} → OUTCOME UNKNOWN`)
          unknown.push(unknownOutcomeNotice(original.name ?? "tool", original.input))
          break
        case "cancelled":
          lines.push(`- ${call} → cancelled`)
          break
        default:
          lines.push(
            effective.replayPolicy === "idempotent"
              ? `- ${call} → interrupted. Call it again with the same input to resume it.`
              : `- ${call} → interrupted (not replayed)`
          )
      }
    }
    lines.push("")
    lines.push(
      "Calling a completed tool again with the same input returns the journaled result without re-executing it, except read-only tools that observe current state: those run again."
    )
    lines.push("")
  }
  for (const notice of unknown) {
    lines.push("⚠ Interrupted external operation")
    lines.push(notice)
    lines.push("")
  }
  lines.push("Continue the original request from here.")
  return lines.join("\n")
}
