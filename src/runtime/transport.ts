import { Option, Schema } from "effect"
import type { FxFetch } from "libfx"

/**
 * The transport libfx uses for model requests, with one repair.
 *
 * libfx's native backend crashes the process on a `tool-call` whose `input`
 * JSON contains line breaks (vercel-labs/fx#1215), which Claude Sonnet 4.5
 * and Haiku 4.5 send when they pretty-print arrays of objects. The input is
 * re-serialized on one line before libfx sees it; its meaning is unchanged.
 */

const MODEL_ENDPOINT = /\/ai\/language-model$/

const ToolCallPart = Schema.Struct({ type: Schema.Literal("tool-call"), input: Schema.String })
const decodeToolCall = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCallPart))
const decodeJsonRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** One SSE line, with a multi-line tool-call input made single-line. Other lines pass through. */
export const normalizeLine = (line: string): string => {
  if (!line.startsWith("data:") || !line.includes("tool-call")) return line
  const raw = line.slice(5).trim()
  const call = decodeToolCall(raw)
  if (Option.isNone(call) || !call.value.input.includes("\n")) return line
  const part = decodeJsonRecord(raw)
  const input = decodeJson(call.value.input)
  if (Option.isNone(part) || Option.isNone(input)) return line
  return `data: ${JSON.stringify({ ...part.value, input: JSON.stringify(input.value) })}`
}

/** Line-buffered rewrite of an SSE byte stream with `normalizeLine`. */
const lineRewriter = () => {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const end = buffer.lastIndexOf("\n")
      if (end < 0) return
      const complete = buffer.slice(0, end + 1)
      buffer = buffer.slice(end + 1)
      controller.enqueue(encoder.encode(complete.split("\n").map(normalizeLine).join("\n")))
    },
    flush(controller) {
      const rest = buffer + decoder.decode()
      if (rest) controller.enqueue(encoder.encode(normalizeLine(rest)))
    }
  })
}

/** `fetch` (the global one by default) with model responses repaired as above. */
export const repairedFetch =
  (fetch: FxFetch = (input, init) => globalThis.fetch(input, init)): FxFetch =>
  async (input, init) => {
    const response = await fetch(input, init)
    if (!MODEL_ENDPOINT.test(new URL(input).pathname) || !response.body) return response
    return new Response(response.body.pipeThrough(lineRewriter()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
