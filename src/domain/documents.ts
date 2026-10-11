import { isJsonObject, type JsonObject } from "./json.js"
import type { DocumentForkPolicy, DocumentHistory, DocumentRecord } from "./schema.js"

/**
 * Typed documents: application state (a todo list, a plan, settings) stored
 * with the journal. A tool's writes commit in the same transaction as its
 * result, so they happen exactly when the call is recorded as completed: a
 * call that fails, or is cut off by a crash, writes nothing, and a replayed
 * call does not write twice.
 */

export type DocumentScope = "agent" | "global"

interface DefinitionBase<T extends JsonObject> {
  /** Stable name of the stored document, e.g. `"app.todos"`. */
  readonly kind: string
  /** Version of the value's shape, from 1. Raise it with `migrate` when the shape changes. */
  readonly version: number
  /** The value of a document that was never written. */
  readonly initial: () => T
  /** Bring a value stored by an older version up to date. Runs on read; the next write stores the result. */
  readonly migrate?: (value: JsonObject, fromVersion: number) => T
}

export interface AgentDocumentDefinition<T extends JsonObject> extends DefinitionBase<T> {
  /** One document per agent. */
  readonly scope: "agent"
  /**
   * `"latest"` (default) keeps the current value. `"rewindable"` keeps every
   * value, so you can read the document as of a checkpoint and forks can
   * start from that value.
   */
  readonly history?: DocumentHistory
  /**
   * What a fork starts with: `"copy"` (default) the current value,
   * `"initial"` the initial value, or `"asOf"` (rewindable only) the value
   * the document had at the checkpoint the fork starts from.
   */
  readonly fork?: DocumentForkPolicy
}

export interface GlobalDocumentDefinition<T extends JsonObject> extends DefinitionBase<T> {
  /** One document for the whole runtime, shared by every agent. */
  readonly scope: "global"
}

export interface DurableDocument<T extends JsonObject, S extends DocumentScope = DocumentScope> {
  readonly _tag: "DurableDocument"
  readonly kind: string
  readonly version: number
  readonly scope: S
  readonly history: DocumentHistory
  readonly fork: DocumentForkPolicy
  readonly initial: () => T
  readonly migrate: ((value: JsonObject, fromVersion: number) => T) | null
}

export type AgentDocument<T extends JsonObject> = DurableDocument<T, "agent">
export type GlobalDocument<T extends JsonObject> = DurableDocument<T, "global">

/** Change a document: edit the draft in place, or return a new value. */
export type DocumentUpdate<T extends JsonObject> = (draft: T) => T | void

const KIND = /^[a-zA-Z0-9_.:-]{1,128}$/

/** Declare a typed document. */
export function defineDocument<T extends JsonObject>(definition: AgentDocumentDefinition<T>): AgentDocument<T>
export function defineDocument<T extends JsonObject>(definition: GlobalDocumentDefinition<T>): GlobalDocument<T>
export function defineDocument<T extends JsonObject>(
  definition: AgentDocumentDefinition<T> | GlobalDocumentDefinition<T>
): DurableDocument<T> {
  if (!KIND.test(definition.kind)) throw new TypeError(`invalid document kind: ${definition.kind}`)
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new TypeError(`document ${definition.kind}: version must be a positive integer`)
  }
  const base = {
    _tag: "DurableDocument" as const,
    kind: definition.kind,
    version: definition.version,
    initial: definition.initial,
    migrate: definition.migrate ?? null
  }
  if (definition.scope === "global") return { ...base, scope: "global", history: "latest", fork: "copy" }
  const history = definition.history ?? "latest"
  const fork = definition.fork ?? "copy"
  if (fork === "asOf" && history !== "rewindable") {
    throw new TypeError(`document ${definition.kind}: fork: "asOf" requires history: "rewindable"`)
  }
  return { ...base, scope: "agent", history, fork }
}

/** The value stored in `record`, brought up to the definition's version; the initial value if never written. */
export const documentValue = <T extends JsonObject>(document: DurableDocument<T>, record: DocumentRecord | null): T => {
  if (!record) return document.initial()
  if (record.version > document.version) {
    throw new Error(`document ${document.kind} was stored by version ${record.version}, newer than ${document.version}`)
  }
  if (record.version === document.version) {
    // SAFETY: the value was written through this definition's version, whose updates are checked to produce a T.
    return structuredClone(record.value) as T
  }
  if (!document.migrate) {
    throw new Error(`document ${document.kind} was stored by version ${record.version} and needs a migrate function`)
  }
  return document.migrate(structuredClone(record.value), record.version)
}

/**
 * Retype a value produced by this document's own updates (or its initial
 * value), which were checked to produce its type.
 */
export const ownValue = <T extends JsonObject>(_document: DurableDocument<T>, value: JsonObject): T =>
  // SAFETY: callers pass only values that came out of `initial`, `migrate`, or `applyUpdate` of this same document.
  value as T

/** Apply one update to a copy of `current`. The result is normalized to JSON (as `JSON.stringify` would store it). */
export const applyUpdate = <T extends JsonObject>(document: DurableDocument<T>, current: T, update: DocumentUpdate<T>): T => {
  const draft = structuredClone(current)
  const returned: unknown = update(draft)
  if (returned instanceof Promise) throw new TypeError(`document ${document.kind}: an update must be synchronous`)
  const result: unknown = JSON.parse(JSON.stringify(returned ?? draft) ?? "null")
  if (!isJsonObject(result)) throw new TypeError(`document ${document.kind}: an update must produce a JSON object`)
  // SAFETY: the update is typed to produce a T; the check above confirms it is still a JSON object after normalization.
  return result as T
}

/** An update that threw; the transaction it ran in is rolled back. */
export class DocumentUpdateFailed extends Error {
  constructor(
    readonly kind: string,
    override readonly cause: unknown
  ) {
    super(`update of document ${kind} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "DocumentUpdateFailed"
  }
}
