import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DurableFx, sqlite, type DurableFxOptions } from "../src/index.js"
import { scriptedModel, type Script } from "../src/testing/index.js"
import { Journal } from "../src/durable/journal.js"
import { openSqliteStorage } from "../src/durable/sqlite/storage.js"

export const tempDb = (name = "fx.db") => join(mkdtempSync(join(tmpdir(), "fxd-test-")), name)

/** Open fx-durable on a SQLite database (sessions in files beside it) with a scripted model. */
export const openFx = (db: string, script: Script, options: Partial<DurableFxOptions> = {}) =>
  DurableFx.open({
    storage: sqlite(db),
    fetch: scriptedModel(script),
    crash: "off",
    ...options
  })

/**
 * The plain synchronous journal over a fresh SQLite database (no Effect),
 * plus the raw storage behind it for test setup and assertions.
 */
export const openTestJournal = (db: string) => {
  const storage = openSqliteStorage({ path: db })
  return { journal: new Journal({ storage }), storage }
}

export const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}
