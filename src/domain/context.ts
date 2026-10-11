/**
 * Resets and handoffs, the parts that are plain data.
 *
 * libfx keeps each conversation in a session and takes instructions anew
 * with every request. So a new context is a new session, and a handoff
 * summary of the old one travels in the instructions, where the model sees it
 * on every request until the next reset replaces it.
 */

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
