import { Submission } from "fx-durable"
import { z } from "zod"
import { runtime } from "@/lib/runtime"

export const dynamic = "force-dynamic"

/** Interrupt the session's running turn (Esc in Claude Code). */
export async function POST(request: Request) {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const { fx } = await runtime()
  const agent = await fx.attach(id)
  const running = (await agent.submissions(20)).filter((s) => s.state === "queued" || s.state === "running")
  await Promise.all(running.map((s) => new Submission(fx, s.id, id, s.requestId, false).cancel()))
  return Response.json({ cancelled: running.map((s) => s.id) })
}
