import { z } from "zod"
import { live, PERMISSION_MODES } from "@/lib/live"
import { setModel } from "@/lib/runtime"
import { sessionDetails } from "@/lib/session-info"

export const dynamic = "force-dynamic"

const idOf = (request: Request) => z.string().min(1).parse(new URL(request.url).searchParams.get("id"))

export async function GET(request: Request) {
  try {
    return Response.json(await sessionDetails(idOf(request)))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 })
  }
}

const UpdateSession = z.object({
  model: z.string().min(1).optional(),
  mode: z.enum(PERMISSION_MODES).optional()
})

export async function PATCH(request: Request) {
  const id = idOf(request)
  const update = UpdateSession.parse(await request.json())
  if (update.model) await setModel(id, update.model)
  if (update.mode) live.setMode(id, update.mode)
  return Response.json(await sessionDetails(id))
}
