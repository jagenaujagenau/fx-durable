import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { isJsonString, jsonText, type JsonObject } from "../domain/json.js"
import type { FxFetch } from "libfx"

/**
 * A scripted language model that speaks the AI Gateway streaming protocol
 * libfx uses. Passed as `DurableFx.open({ fetch })`, it lets the real libfx
 * kernel (agent loop, tool calls, durable sessions) run deterministically
 * offline: for the crash suite and examples, without an API key.
 *
 * Tool call ids are unique across processes, as a provider's are: libfx
 * identifies a call by its id when it continues a turn after a crash.
 */

export interface ScriptedToolResult {
  readonly toolName: string
  readonly output: string
  readonly isError: boolean
}

export interface ScriptedRequest {
  /** Text of the most recent user message (the submission or recovery prompt). */
  readonly userText: string
  /** Tool results since that user message, in order. */
  readonly toolResults: ReadonlyArray<ScriptedToolResult>
  /**
   * Every tool result in the conversation, in order. When libfx continues a
   * turn after a crash it adds its own user messages, so scripts that should
   * survive a crash decide from these.
   */
  readonly allToolResults: ReadonlyArray<ScriptedToolResult>
  /** Number of model steps already taken since that user message. */
  readonly step: number
  readonly tools: ReadonlyArray<string>
  readonly model: string
  /** Gateway prompt messages (decoded), for advanced scripts. */
  readonly messages: ReadonlyArray<GatewayMessage>
}

export interface ScriptedResponse {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly input: JsonObject }>
  /** Token usage to report. Defaults to small made-up counts with no cache or reasoning tokens. */
  readonly usage?: ScriptedUsage
}

/** Token counts in the gateway's terms: `input` includes cache reads and writes, `output` includes reasoning. */
export interface ScriptedUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly reasoning?: number
}

export type Script = (request: ScriptedRequest) => ScriptedResponse | Promise<ScriptedResponse>

export interface ScriptedModelOptions {
  /** Delay before the response starts, in ms. */
  readonly latencyMs?: number
  /** Delay between streamed chunks, in ms. */
  readonly chunkDelayMs?: number
}

// The subset of the gateway request this model reads. Extra fields are ignored.
const ContentPart = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  output: Schema.optional(Schema.Struct({ type: Schema.String, value: Schema.optional(Schema.Json) }))
})
// System messages carry their content as a plain string.
const GatewayMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(ContentPart)])
})
export type GatewayMessage = typeof GatewayMessage.Type
const GatewayRequest = Schema.fromJsonString(
  Schema.Struct({
    prompt: Schema.Array(GatewayMessage),
    tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String })))
  })
)
const decodeRequest = Schema.decodeUnknownSync(GatewayRequest)

const usage = ({ input, output, cacheRead = 0, cacheWrite = 0, reasoning = 0 }: ScriptedUsage) => ({
  inputTokens: { total: input, noCache: input - cacheRead - cacheWrite, cacheRead, cacheWrite },
  outputTokens: { total: output, text: output - reasoning, reasoning }
})


const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isErrorOutput = (type: string) => type === "error-text" || type === "error-json"

const partsOf = (message: GatewayMessage | undefined) =>
  message === undefined || isJsonString(message.content) ? [] : message.content

const parseRequest = (body: string, model: string): ScriptedRequest => {
  const parsed = decodeRequest(body)
  const messages = parsed.prompt
  const lastUser = messages.findLastIndex((m) => m.role === "user")
  const userText =
    lastUser >= 0 ? partsOf(messages[lastUser]).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n") : ""
  const after = messages.slice(lastUser + 1)
  const resultsIn = (list: ReadonlyArray<GatewayMessage>) => {
    const results: Array<ScriptedToolResult> = []
    for (const m of list) {
      if (m.role !== "tool") continue
      for (const c of partsOf(m)) {
        if (c.type !== "tool-result" || c.toolName === undefined) continue
        results.push({
          toolName: c.toolName,
          output: c.output ? jsonText(c.output.value) : "",
          isError: c.output !== undefined && isErrorOutput(c.output.type)
        })
      }
    }
    return results
  }
  return {
    userText,
    toolResults: resultsIn(after),
    allToolResults: resultsIn(messages),
    step: after.filter((m) => m.role === "assistant").length,
    tools: (parsed.tools ?? []).map((t) => t.name),
    model,
    messages
  }
}

const encodeParts = (response: ScriptedResponse, step: number) => {
  const parts: Array<unknown> = [{ type: "stream-start", warnings: [] }]
  if (response.text) {
    const id = `text_${step}`
    parts.push({ type: "text-start", id })
    // Stream text in a few pieces so consumers see a real stream.
    const pieces = response.text.match(/.{1,24}/gs) ?? [response.text]
    for (const delta of pieces) parts.push({ type: "text-delta", id, delta })
    parts.push({ type: "text-end", id })
  }
  for (const call of response.toolCalls ?? []) {
    const id = `call_${randomUUID().replaceAll("-", "")}`
    const input = JSON.stringify(call.input)
    parts.push({ type: "tool-input-start", id, toolName: call.name })
    parts.push({ type: "tool-input-delta", id, delta: input })
    parts.push({ type: "tool-input-end", id })
    parts.push({ type: "tool-call", toolCallId: id, toolName: call.name, input })
  }
  const hasTools = (response.toolCalls?.length ?? 0) > 0
  parts.push({
    type: "finish",
    finishReason: hasTools ? { unified: "tool-calls", raw: "tool_use" } : { unified: "stop", raw: "end_turn" },
    usage: usage(
      response.usage ?? {
        input: 100 + step * 10,
        output: Math.max(1, Math.ceil((response.text?.length ?? 0) / 4)) + (hasTools ? 20 : 0)
      }
    )
  })
  return parts
}

/** Build a `fetch` implementation that answers model requests from `script`. */
export const scriptedModel = (script: Script, options: ScriptedModelOptions = {}): FxFetch => {
  const fake: FxFetch = async (input, init) => {
    const path = new URL(input).pathname
    // The model catalog: empty, so libfx assumes nothing about the scripted model.
    if (path.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } })
    if (!path.endsWith("/ai/language-model")) return new Response(JSON.stringify({ error: "not available offline" }), { status: 404 })
    const headers = new Headers(init?.headers)
    const model = headers.get("ai-language-model-id") ?? "scripted"
    const raw = await new Response(init?.body ?? null).text()
    const request = parseRequest(raw, model)
    if (options.latencyMs) await sleep(options.latencyMs)
    const response = await script(request)
    const parts = encodeParts(response, request.step)
    const encoder = new TextEncoder()
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const part of parts) {
          if (signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"))
            return
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`))
          if (options.chunkDelayMs) await sleep(options.chunkDelayMs)
        }
        controller.close()
      }
    })
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  return fake
}
