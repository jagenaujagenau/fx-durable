import { z } from "zod"
import { runtime } from "@/lib/runtime"

export const dynamic = "force-dynamic"

const Steer = z.object({ id: z.string().min(1), text: z.string().min(1) })

/**
 * Guidance for the running turn (typing while the agent works). libfx stores
 * it with the session and hands it to the model at its next request; with no
 * turn running, it goes to the next one.
 */
export async function POST(request: Request) {
  const { id, text } = Steer.parse(await request.json())
  const { fx } = await runtime()
  await (await fx.attach(id)).steer(text)
  return Response.json({ steered: true })
}
