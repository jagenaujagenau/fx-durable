import { Schema } from "effect"

/**
 * JSON is the contract for everything fx-durable persists on behalf of the
 * application: submission content, tool inputs and outputs, event payloads.
 * Values are validated as JSON where they enter the system.
 */
export type Json = Schema.Json
export type JsonObject = Schema.JsonObject

export const isJsonObject = Schema.is(Schema.JsonObject)
export const isJsonString = Schema.is(Schema.String)

/** Read a field of a JSON value that may or may not be an object. */
export const jsonField = (value: Json | undefined, key: string): Json | undefined =>
  value !== undefined && isJsonObject(value) ? value[key] : undefined

/** Render a JSON value as text: strings as-is, everything else as JSON. */
export const jsonText = (value: Json | undefined): string =>
  value === undefined ? "" : isJsonString(value) ? value : JSON.stringify(value)

const canonical = (value: Json): Json => {
  if (isJsonObject(value)) {
    const sorted: Record<string, Json> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key] ?? null)
    return sorted
  }
  if (Array.isArray(value)) return value.map(canonical)
  return value
}

/** Canonical JSON: object keys sorted, so equal values serialize equally. */
export const canonicalJson = (value: Json): string => JSON.stringify(canonical(value))
