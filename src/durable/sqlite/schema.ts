import type { DatabaseSync } from "node:sqlite"
import { migration001 } from "./migrations/001_initial.js"
import { migration002 } from "./migrations/002_context.js"
import { migration003 } from "./migrations/003_nested_calls.js"
import { migration004 } from "./migrations/004_abandoned_calls.js"
import { migration005 } from "./migrations/005_documents.js"

export const migrations = [migration001, migration002, migration003, migration004, migration005] as const

/**
 * Apply pending migrations atomically. Each migration and its version row
 * commit together, so a crash mid-migration leaves the previous version.
 */
export const applyMigrations = (db: DatabaseSync): void => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)"
  )
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get()
  const current = Number(row?.v ?? 0)
  for (const m of migrations) {
    if (m.version <= current) continue
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(m.sql)
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        Date.now()
      )
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
}
