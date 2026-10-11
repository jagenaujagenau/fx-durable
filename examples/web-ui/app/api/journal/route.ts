import type { FxStreamLine, TurnUsage } from "fx-durable"
import { live } from "@/lib/live"
import { runtime } from "@/lib/runtime"

export const dynamic = "force-dynamic"

/**
 * One SSE stream per session:
 * - default events: the agent's libfx session stream, one event per step
 *   (tokens are folded into the step that produced them), with `id:` = the
 *   line's cursor, so EventSource resumes from Last-Event-ID after a crash;
 * - `event: live`: permission prompts, mode changes, tool output (not durable).
 */

interface JournalEvent {
  readonly sequence: number
  readonly type: string
  readonly taskId: string | null
  readonly at: string
  readonly payload: {
    readonly tool?: string
    readonly text?: string
    readonly error?: string
    readonly usage?: TurnUsage
  }
}

/** Folds a session's lines into the events the journal view shows. */
const journal = () => {
  let text = ""
  const at = () => new Date().toISOString()
  /** The model's text since its last tool call, as one step event. */
  const flushText = (sequence: number): Array<JournalEvent> => {
    if (text.length === 0) return []
    const event = { sequence, type: "model.completed", taskId: null, at: at(), payload: { text } }
    text = ""
    return [event]
  }
  return (line: FxStreamLine): Array<JournalEvent> => {
    const sequence = line.cursor ?? 0
    switch (line.type) {
      case "turn_start":
        return [{ sequence, type: "submission.started", taskId: null, at: at(), payload: { text: line.input } }]
      case "turn_resume":
        return [{ sequence, type: "turn.recovered", taskId: null, at: at(), payload: {} }]
      case "user_message":
        return [...flushText(sequence - 0.5), { sequence, type: "turn.steered", taskId: null, at: at(), payload: { text: line.text } }]
      case "text_delta":
        text += line.delta
        return []
      case "tool_start":
        return [...flushText(sequence - 0.5), { sequence, type: "tool.started", taskId: line.id, at: at(), payload: { tool: line.name } }]
      case "tool_end":
        return [
          {
            sequence,
            type: line.isError ? "tool.failed" : "tool.completed",
            taskId: line.id,
            at: at(),
            payload: line.isError ? { tool: line.name, error: line.content } : { tool: line.name }
          }
        ]
      case "turn_end": {
        const type = line.stopReason === "cancelled" ? "submission.cancelled" : line.stopReason === "error" || line.stopReason === "unknown" ? "submission.failed" : "submission.completed"
        return [...flushText(sequence - 0.5), { sequence, type, taskId: null, at: at(), payload: { usage: line.usage, error: line.error?.message } }]
      }
      default:
        return []
    }
  }
}

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
  // An agent's session exists from its first request; until then there is nothing to stream.
  for (let i = 0; !(await agent.info()).sessionId && i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 200))
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
      unsubscribe = live.subscribe(id, (event) => send(`event: live\ndata: ${JSON.stringify(event)}\n\n`))
      const fold = journal()
      try {
        for await (const line of agent.events({ after })) {
          if (request.signal.aborted) break
          // `id:` is the line's cursor, so a reconnect resumes right after it.
          for (const event of fold(line)) send(`id: ${line.cursor ?? 0}\ndata: ${JSON.stringify(event)}\n\n`)
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
