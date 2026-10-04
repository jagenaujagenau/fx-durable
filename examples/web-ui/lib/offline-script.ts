import type { Script, ScriptedResponse } from "fx-durable/testing"

/**
 * The model used when AI_GATEWAY_API_KEY is not set. It speaks the AI Gateway
 * protocol, so the real libfx kernel, tools, and permission prompts all run;
 * only the decisions are scripted. It knows the sample workspace.
 */
export const offlineScript: Script = (req): ScriptedResponse => {
  const text = req.userText.toLowerCase()
  const results = req.toolResults.map((r) => r.toolName)
  const count = (name: string) => results.filter((n) => n === name).length
  const last = req.toolResults.at(-1)

  // The explore subagent: its requests offer read-only tools, no bash.
  if (!req.tools.includes("bash")) {
    if (count("list_files") === 0) return { text: "Looking around.", toolCalls: [{ name: "list_files", input: {} }] }
    if (count("read_file") === 0) return { toolCalls: [{ name: "read_file", input: { path: "src/cart.js" } }] }
    return {
      text: "`src/cart.js` exports `subtotal`, `applyDiscount` and `total`; `test/cart.test.js` covers them with 4 tests. `subtotal` (src/cart.js:4) ignores `quantity`."
    }
  }

  if (text.includes("explain") || text.includes("explore")) {
    const explored = req.toolResults.find((r) => r.toolName === "explore")
    if (!explored) {
      return {
        text: "I'll send a subagent to look around, so this conversation stays focused.",
        toolCalls: [{ name: "explore", input: { task: "Summarize this project: its modules, their exports, and its tests. Note anything that looks wrong." } }]
      }
    }
    return {
      text: [
        "Here's what the subagent found:",
        "",
        "- **`src/cart.js`**: `subtotal`, `applyDiscount`, `total` for a shopping cart (prices in cents).",
        "- **`test/cart.test.js`**: 4 tests with Node's built-in runner (`npm test`).",
        "- **Suspicious:** `subtotal` ignores `quantity`, so two tests should fail. Ask me to fix them."
      ].join("\n")
    }
  }

  if (last?.isError && last.output.includes("denied")) {
    return { text: `You denied \`${last.toolName}\`, so I stopped there. Tell me how you'd like to proceed.` }
  }

  if (text.includes("fix") || text.includes("test")) {
    if (count("todo_write") === 0) {
      return {
        text: "I'll run the tests, find the cause of any failures, fix it, and verify.",
        toolCalls: [
          {
            name: "todo_write",
            input: {
              todos: [
                { content: "Run the test suite", status: "in_progress" },
                { content: "Find the cause of the failures", status: "pending" },
                { content: "Fix the bug", status: "pending" },
                { content: "Re-run the tests", status: "pending" }
              ]
            }
          }
        ]
      }
    }
    if (count("bash") === 0) return { toolCalls: [{ name: "bash", input: { command: "npm test", description: "Run the test suite" } }] }
    if (count("read_file") === 0) {
      return {
        text: "Two tests fail: `subtotal` returns 350 instead of 500, and `total` is off by the same factor. Reading the implementation.",
        toolCalls: [{ name: "read_file", input: { path: "src/cart.js" } }]
      }
    }
    if (count("edit_file") === 0) {
      return {
        text: "`subtotal` sums `item.price` but ignores `item.quantity`. Fixing it.",
        toolCalls: [
          {
            name: "edit_file",
            input: {
              path: "src/cart.js",
              old_string: "return items.reduce((sum, item) => sum + item.price, 0)",
              new_string: "return items.reduce((sum, item) => sum + item.price * item.quantity, 0)"
            }
          }
        ]
      }
    }
    if (count("bash") === 1) {
      return {
        toolCalls: [
          {
            name: "todo_write",
            input: {
              todos: [
                { content: "Run the test suite", status: "completed" },
                { content: "Find the cause of the failures", status: "completed" },
                { content: "Fix the bug", status: "completed" },
                { content: "Re-run the tests", status: "in_progress" }
              ]
            }
          },
          { name: "bash", input: { command: "npm test", description: "Re-run the test suite" } }
        ]
      }
    }
    return {
      text: [
        "All 4 tests pass now.",
        "",
        "**Cause:** `subtotal` in `src/cart.js:4` added each item's `price` once, ignoring `quantity`.",
        "",
        "```diff",
        "- return items.reduce((sum, item) => sum + item.price, 0)",
        "+ return items.reduce((sum, item) => sum + item.price * item.quantity, 0)",
        "```",
        "",
        "`total` was wrong for the same reason, so that one fix covers both failures."
      ].join("\n")
    }
  }

  if (count("list_files") === 0) {
    return { text: "Let me look at the project.", toolCalls: [{ name: "list_files", input: {} }] }
  }
  return {
    text: [
      "_(offline scripted model — set `AI_GATEWAY_API_KEY` for a real one)_",
      "",
      "This workspace is a small **cart** module (`src/cart.js`) with tests in `test/cart.test.js`.",
      "",
      "Try: **fix the failing tests**."
    ].join("\n")
  }
}
