import { isJsonObject, jsonField, jsonText, type Json } from "../core/json.js"
import type { DurableEvent, TaskRecord } from "../core/schema.js"

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: string) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text)
export const dim = paint("2")
export const bold = paint("1")
export const green = paint("32")
export const yellow = paint("33")
export const red = paint("31")
export const cyan = paint("36")

export const table = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)))
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]! + 2)).join("").trimEnd()).join("\n")
}

export const duration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return ""
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

const short = (value: Json | undefined, max = 60) => {
  const text = jsonText(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A one-line human label for a tool call, e.g. `read package.json`, `npm test`. */
export const toolLabel = (tool: string | null | undefined, input: Json | undefined): string => {
  const field = (key: string) => jsonText(jsonField(input, key))
  switch (tool) {
    case "read_file":
      return `read ${field("path")}`
    case "edit_file":
    case "write_file":
      return `edit ${field("path")}`
    case "bash":
      return field("command") || "bash"
    case "deploy":
      return `deploy ${field("environment") || field("version")}`.trim()
    case "check_deployment":
      return `inspect ${field("environment") || "deployment"}`
    default: {
      const hasInput = input !== undefined && input !== null && (!isJsonObject(input) || Object.keys(input).length > 0)
      return `${tool ?? "tool"} ${hasInput ? short(input, 40) : ""}`.trim()
    }
  }
}

export const taskLabel = (task: TaskRecord): string =>
  task.type === "tool" ? `${task.name}` : task.type === "model" ? "model" : task.type

/** Render one durable event as a log line (for `fxd events`). */
export const eventLine = (event: DurableEvent): string => {
  const time = event.createdAt.toISOString().slice(11, 23)
  const detail = Object.keys(event.payload).length ? dim(short(event.payload, 100)) : ""
  const color = event.type.includes("outcome_unknown") || event.type.endsWith("failed")
    ? yellow
    : event.type.endsWith("completed")
      ? green
      : (s: string) => s
  return `${dim(String(event.sequence).padStart(5))} ${dim(time)} ${color(event.type.padEnd(26))} ${detail}`
}
