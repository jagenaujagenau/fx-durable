import { executorGone } from "../domain/executors.js"
import { SystemClock, type Clock } from "./clock.js"
import type { Storage } from "./storage.js"

/**
 * Process liveness, kept apart from the Journal on purpose. Executor rows are
 * not domain state: they belong to no state machine, produce no events, and
 * are never written in the same transaction as a turn or task. A heartbeat
 * just overwrites a timestamp every few seconds. Recovery reads them to decide
 * whether a running turn's owner is gone.
 */
export class ExecutorRegistry {
  readonly #storage: Storage
  readonly #clock: Clock

  constructor(storage: Storage, clock: Clock = SystemClock) {
    this.#storage = storage
    this.#clock = clock
  }

  register(id: string, pid: number, host: string): void {
    const at = new Date(this.#clock.now())
    this.#storage.registerExecutor({ id, pid, hostname: host, startedAt: at, heartbeatAt: at, stoppedAt: null })
  }

  heartbeat(id: string): void {
    this.#storage.heartbeatExecutor(id, new Date(this.#clock.now()))
  }

  /** A clean shutdown: the executor's unfinished turns become recoverable immediately. */
  stop(id: string): void {
    this.#storage.stopExecutor(id, new Date(this.#clock.now()))
  }

  /** Is the executor gone (stopped, its process dead, or silent too long)? `self` is never gone. */
  isGone(id: string | null, self: string | null, staleAfter?: number): boolean {
    if (id === null) return true
    return executorGone(this.#storage.getExecutor(id), new Date(this.#clock.now()), self, staleAfter)
  }
}
