import { isJsonString } from "./json.js"
import type { SubmissionContent } from "./schema.js"

/**
 * Context resets and compaction, the parts that are plain data.
 *
 * libfx keeps the conversation in its checkpoint and takes instructions anew
 * every time an agent is created, without storing them. So a new context is
 * a fresh libfx agent (no checkpoint), and a summary of the old one travels
 * in the instructions, where the model sees it on every request until the
 * next reset replaces it.
 */

/** Automatic compaction for a runtime's agents. */
export interface CompactionOptions {
  /**
   * Compact once a model request's context (input plus output tokens) reaches
   * this size. The compaction runs after the turn that crossed it, before the
   * next queued request.
   */
  readonly maxContextTokens: number
  /** Extra guidance for the summary, e.g. what this kind of agent must not forget. */
  readonly instructions?: string
}

export const contentText = (content: SubmissionContent): string =>
  isJsonString(content) ? content : content.map((block) => block.text).join("\n")

/** The instructions an agent runs with: its runtime's, then the summary of earlier context. */
export const instructionsWithSummary = (instructions: string | undefined, summary: string | null | undefined): string | undefined => {
  if (!summary) return instructions
  const block = [
    "<previous_context>",
    "Earlier parts of this conversation were replaced by this summary. Continue from it; do not repeat finished work.",
    "",
    summary,
    "</previous_context>"
  ].join("\n")
  return instructions ? `${instructions}\n\n${block}` : block
}

/** The request that asks the model for a compaction summary. */
export const compactionPrompt = (extra: string): string =>
  [
    "Summarize this conversation so that you could continue the work from the summary alone; the conversation itself will be removed.",
    "Include, specifically (names, paths, values, decisions):",
    "- what the user asked for and still expects, in their words where it matters;",
    "- what was done, what was decided and why;",
    "- the current state: files, resources, and anything changed outside this conversation;",
    "- open problems and the next steps.",
    "If the conversation began from an earlier summary, fold it in.",
    "Reply with the summary only. Do not call tools.",
    extra ? `\nAlso: ${extra}` : ""
  ].join("\n")
