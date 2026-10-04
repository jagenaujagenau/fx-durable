import { hostname } from "node:os"
import type { UnknownOutcomeReason } from "./schema.js"
import type { ExecutorRecord } from "./storage.js"

/** Executor liveness: decides whether a running turn's owning process is gone. */

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/** Same host: ask the OS. Other hosts: heartbeat silence beyond `staleAfter`. */
export const executorGone = (record: ExecutorRecord | null, at: Date, self: string | null, staleAfter = 30_000): boolean => {
  if (!record) return true
  if (record.stoppedAt) return true
  if (record.id === self) return false
  if (record.hostname === hostname()) {
    // A different executor in our own pid is a previous incarnation of this process image.
    if (record.pid === process.pid) return true
    return !pidAlive(record.pid)
  }
  return at.getTime() - record.heartbeatAt.getTime() > staleAfter
}

export const lostReason = (record: ExecutorRecord | null): UnknownOutcomeReason =>
  record && record.hostname !== hostname() && !record.stoppedAt ? "executor_lost" : "process_terminated"
