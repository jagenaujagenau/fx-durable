import { z } from "zod"
import { runtime } from "@/lib/runtime"

export const dynamic = "force-dynamic"

const Steer = z.object({ id: z.string().min(1), text: z.string().min(1) })

/**
 * Guidance for the running turn (typing while the agent works). fx-durable
 * journals it and libfx hands it to the model at the next safe boundary; if no
 * turn is running it becomes a new request.
 */
export async function POST(request: Request) {
  const { id, text } = Steer.parse(await request.json())
  const { fx } = await runtime()
  const submission = await (await fx.attach(id)).steer(text)
  return Response.json({ submissionId: submission.id, created: submission.created })
}
