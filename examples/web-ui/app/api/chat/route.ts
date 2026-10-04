import { validateUIMessages } from "ai"
import { z } from "zod"
import { runtime, sessionFor, UnknownSessionError } from "@/lib/runtime"

const ChatRequest = z.object({ id: z.string().min(1), messages: z.array(z.unknown()) })

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const body = ChatRequest.parse(await request.json())
  const id = body.id
  const messages = await validateUIMessages({ messages: body.messages })
  const last = messages.at(-1)
  const prompt = last?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ?? ""

  const { agent } = await runtime()
  const session = await sessionFor(id).catch((error: Error) => (error instanceof UnknownSessionError ? null : Promise.reject(error)))
  if (!session) return Response.json({ error: "unknown session" }, { status: 404 })
  // No abortSignal: closing the tab does not cancel the turn. It is a durable
  // submission and keeps running; the client reads the result from history.
  const result = await agent.stream({ session, prompt })
  return result.toUIMessageStreamResponse({ originalMessages: messages })
}
