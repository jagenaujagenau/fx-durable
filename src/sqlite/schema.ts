import type { DatabaseSync } from "node:sqlite"
import { migration001 } from "./migrations/001_initial.js"

export const migrations = [migration001] as const

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
