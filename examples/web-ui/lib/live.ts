import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import type { Json } from "fx-durable"

/**
 * In-process, non-durable state that viewers see live: token deltas,
 * permission prompts, and each session's permission mode. The durable record
 * of what happened is fx-durable's journal; this is only what is happening now.
 */

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions"
export const PERMISSION_MODES: ReadonlyArray<PermissionMode> = ["default", "acceptEdits", "plan", "bypassPermissions"]

export type ToolCategory = "read" | "edit" | "exec"

export interface PendingApproval {
  readonly approvalId: string
  readonly agentId: string
  readonly tool: string
  readonly category: ToolCategory
  readonly input: Json
  readonly requestedAt: string
}

export type ApprovalDecision = "allow" | "allow-session" | "deny"

export type LiveEvent =
  | { readonly type: "text-delta"; readonly taskId: string; readonly delta: string }
  | { readonly type: "approval-requested"; readonly approval: PendingApproval }
  | { readonly type: "approval-resolved"; readonly approvalId: string; readonly decision: ApprovalDecision }
  | { readonly type: "mode-changed"; readonly mode: PermissionMode }

type Listener = (event: LiveEvent) => void

interface Waiting {
  readonly approval: PendingApproval
  readonly settle: (decision: ApprovalDecision, reason?: string) => void
}

const Settings = z.object({ modes: z.record(z.string(), z.enum(["default", "acceptEdits", "plan", "bypassPermissions"])) })

class Live {
  #settingsFile: string | null = null
  readonly #listeners = new Map<string, Set<Listener>>()
  readonly #approvals = new Map<string, Waiting>()
  readonly #modes = new Map<string, PermissionMode>()
  readonly #allowed = new Map<string, Set<string>>()

  subscribe(agentId: string, listener: Listener): () => void {
    const set = this.#listeners.get(agentId) ?? new Set()
    set.add(listener)
    this.#listeners.set(agentId, set)
    return () => set.delete(listener)
  }

  publish(agentId: string, event: LiveEvent): void {
    for (const listener of this.#listeners.get(agentId) ?? []) listener(event)
  }

  /**
   * Keep permission modes in a file, so a recovered turn runs under the mode
   * the user chose. Call before opening DurableFx: recovery runs during open().
   */
  persistTo(file: string): void {
    this.#settingsFile = file
    try {
      const saved = Settings.parse(JSON.parse(readFileSync(file, "utf8")))
      for (const [agentId, mode] of Object.entries(saved.modes)) this.#modes.set(agentId, mode)
    } catch {
      // first run, or an unreadable file: start from defaults
    }
  }

  modeOf(agentId: string): PermissionMode {
    return this.#modes.get(agentId) ?? "default"
  }

  setMode(agentId: string, mode: PermissionMode): void {
    this.#modes.set(agentId, mode)
    if (this.#settingsFile) {
      mkdirSync(dirname(this.#settingsFile), { recursive: true })
      writeFileSync(this.#settingsFile, JSON.stringify({ modes: Object.fromEntries(this.#modes) }, null, 2))
    }
    this.publish(agentId, { type: "mode-changed", mode })
  }

  pending(agentId: string): Array<PendingApproval> {
    return [...this.#approvals.values()].filter((w) => w.approval.agentId === agentId).map((w) => w.approval)
  }

  /**
   * Decide whether a tool call may run, asking the user when the session's
   * permission mode requires it. Rejects when the call is not allowed; the
   * message is what the model sees as the tool error.
   */
  async authorize(agentId: string, tool: string, category: ToolCategory, input: Json, signal: AbortSignal): Promise<void> {
    if (category === "read") return
    const mode = this.modeOf(agentId)
    if (mode === "plan") {
      throw new Error("Plan mode is on: do not modify files or run commands. Investigate with read-only tools, then present your plan.")
    }
    if (mode === "bypassPermissions") return
    if (mode === "acceptEdits" && category === "edit") return
    if (this.#allowed.get(agentId)?.has(tool)) return

    const approval: PendingApproval = { approvalId: randomUUID(), agentId, tool, category, input, requestedAt: new Date().toISOString() }
    const { decision, reason } = await new Promise<{ decision: ApprovalDecision; reason?: string }>((resolve, reject) => {
      const onAbort = () => {
        this.#approvals.delete(approval.approvalId)
        reject(new Error("tool call cancelled while waiting for permission"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.#approvals.set(approval.approvalId, {
        approval,
        settle: (settled, why) => {
          signal.removeEventListener("abort", onAbort)
          resolve({ decision: settled, reason: why })
        }
      })
      this.publish(agentId, { type: "approval-requested", approval })
    })
    if (decision === "deny") {
      throw new Error(`The user denied this ${tool} call${reason ? `: ${reason}` : "."} Do not retry it; ask the user how to proceed.`)
    }
    if (decision === "allow-session") {
      const set = this.#allowed.get(agentId) ?? new Set()
      set.add(tool)
      this.#allowed.set(agentId, set)
    }
  }

  resolve(approvalId: string, decision: ApprovalDecision, reason?: string): boolean {
    const waiting = this.#approvals.get(approvalId)
    if (!waiting) return false
    this.#approvals.delete(approvalId)
    waiting.settle(decision, reason)
    this.publish(waiting.approval.agentId, { type: "approval-resolved", approvalId, decision })
    return true
  }
}

declare global {
  // Next dev reloads modules; keep one bus per process.
  var fxDurableLive: Live | undefined
}

export const live = (globalThis.fxDurableLive ??= new Live())
