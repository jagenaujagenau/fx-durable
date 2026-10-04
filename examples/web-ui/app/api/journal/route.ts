import { live } from "@/lib/live"
import { runtime } from "@/lib/runtime"

export const dynamic = "force-dynamic"

/**
 * One SSE stream per session:
 * - default events: the agent's durable event log, with `id:` = sequence, so
 *   EventSource resumes from Last-Event-ID after a crash and restart;
 * - `event: live`: permission prompts and mode changes (not durable).
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const id = url.searchParams.get("id")
  if (!id) return new Response("missing id", { status: 400 })
  const after = Number(request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0)

  const { fx } = await runtime()
  // A subagent's child agent is created a moment after its tool call starts; give it a few seconds.
  let agent = await fx.attach(id).catch(() => null)
  for (let i = 0; !agent && id.includes("/") && i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    agent = await fx.attach(id).catch(() => null)
  }
  if (!agent) return new Response("unknown session", { status: 404 })
  const encoder = new TextEncoder()
  let unsubscribe = () => {}

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          // stream already closed
        }
      }
      send(`event: hello\ndata: ${JSON.stringify({ pid: process.pid })}\n\n`)
      for (const approval of live.pending(id)) send(`event: live\ndata: ${JSON.stringify({ type: "approval-requested", approval })}\n\n`)
      unsubscribe = live.subscribe(id, (event) => {
        if (event.type !== "text-delta") send(`event: live\ndata: ${JSON.stringify(event)}\n\n`)
      })
      try {
        for await (const event of agent.events({ after })) {
          if (request.signal.aborted) break
          const data = { sequence: event.sequence, type: event.type, taskId: event.taskId, payload: event.payload, at: event.createdAt }
          send(`id: ${event.sequence}\ndata: ${JSON.stringify(data)}\n\n`)
        }
      } catch {
        // client went away
      }
      unsubscribe()
      controller.close()
    },
    cancel() {
      unsubscribe()
    }
  })
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } })
}
