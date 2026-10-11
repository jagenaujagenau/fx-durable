import type { DatabaseSync } from "node:sqlite"
import { migration001 } from "./migrations/001_records.js"

export const migrations = [migration001] as const

/** The table that records applied migrations. Not `schema_migrations`, which fx-durable 0.2 used for another schema. */
const MIGRATIONS_TABLE = "fxd_migrations"

/**
 * Apply pending migrations atomically. Each migration and its version row
 * commit together, so a crash mid-migration leaves the previous version.
 * A database written by fx-durable 0.2 is refused: its conversations were
 * kept in libfx checkpoints that libfx sessions do not read.
 */
export const applyMigrations = (db: DatabaseSync): void => {
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get()
  if (legacy) {
    throw new Error("this database was written by fx-durable 0.2, which kept conversations in libfx checkpoints; open a new database")
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
  const row = db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM ${MIGRATIONS_TABLE}`).get()
  const current = Number(row?.v ?? 0)
  for (const m of migrations) {
    if (m.version <= current) continue
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(m.sql)
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`).run(m.version, m.name, Date.now())
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
}
