import { randomUUID } from "node:crypto"
import { Journal } from "../durable/journal.js"
import { openSqliteStorage } from "../durable/sqlite/storage.js"

/**
 * The CLI is an observer/controller of the same durable state, not a
 * separate execution model: it opens the plain synchronous journal only.
 */
export const openJournal = (db: string): Journal =>
  new Journal({ storage: openSqliteStorage({ path: db }), nextId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}` })
