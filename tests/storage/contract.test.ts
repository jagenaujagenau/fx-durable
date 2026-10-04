import { describe, expect, it } from "vitest"
import { openSqliteStorage } from "../../src/durable/sqlite/storage.js"
import { storageContract } from "../../src/testing/index.js"
import { tempDb } from "../helpers.js"

describe("storage contract: SQLite", () => {
  for (const check of storageContract) {
    it(check.name, () => {
      const storage = openSqliteStorage({ path: tempDb() })
      try {
        check.run(storage)
      } finally {
        storage.close()
      }
    })
  }
})

describe("storage contract: catches broken implementations", () => {
  type SqliteStorage = ReturnType<typeof openSqliteStorage>
  /** The contract cases that fail for a storage patched by `patch` (fresh storage per case). */
  const failing = (patch: (storage: SqliteStorage) => Partial<SqliteStorage>) =>
    storageContract
      .filter((check) => {
        const storage = openSqliteStorage({ path: tempDb() })
        try {
          check.run({ ...storage, ...patch(storage) })
          return false
        } catch {
          return true
        } finally {
          storage.close()
        }
      })
      .map((check) => check.name.split(".")[0])

  it("a transaction without rollback fails the atomicity checks", () => {
    expect(failing(() => ({ transaction: <A>(fn: () => A) => fn() }))).toEqual(["3", "2", "4", "7"])
  })

  it("afterCommit that runs eagerly fails check 7", () => {
    expect(failing(() => ({ afterCommit: (fn: () => void) => fn() }))).toEqual(["7"])
  })
})
