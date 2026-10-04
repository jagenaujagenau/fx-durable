import type { UIMessage } from "ai"
import { sessionFor, UnknownSessionError } from "@/lib/runtime"

export const dynamic = "force-dynamic"

/** The conversation as fx-durable journaled it, as AI SDK UI messages. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id")
  if (!id) return Response.json({ error: "missing id" }, { status: 400 })
  const session = await sessionFor(id).catch((error: Error) => (error instanceof UnknownSessionError ? null : Promise.reject(error)))
  if (!session) return Response.json({ error: "unknown session" }, { status: 404 })
  const { messages } = await session.readHistory()

  const ui: Array<UIMessage> = messages.flatMap((message, index): Array<UIMessage> => {
    if (message.role === "user") {
      return [{ id: `h${index}`, role: "user", parts: message.content.flatMap((p) => (p.type === "text" ? [{ type: "text" as const, text: p.text }] : [])) }]
    }
    if (message.role !== "assistant") return []
    const results = new Map(message.content.flatMap((p) => (p.type === "tool-result" ? [[p.toolCallId, p] as const] : [])))
    const parts: UIMessage["parts"] = []
    for (const part of message.content) {
      if (part.type === "text") parts.push({ type: "text", text: part.text })
      if (part.type === "tool-call") {
        const result = results.get(part.toolCallId)
        const value = !result || result.output.type === "execution-denied" ? null : result.output.value
        const failed = result?.output.type === "error-text"
        parts.push(
          failed
            ? { type: "dynamic-tool", toolName: part.toolName, toolCallId: part.toolCallId, state: "output-error", input: part.input, errorText: String(value) }
            : {
                type: "dynamic-tool",
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                state: "output-available",
                input: part.input,
                output: value
              }
        )
      }
    }
    return [{ id: `h${index}`, role: "assistant", parts }]
  })
  return Response.json({ messages: ui })
}
