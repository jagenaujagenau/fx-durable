import { z } from "zod"
import { createChatSession } from "@/lib/runtime"
import { listSessions } from "@/lib/session-info"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json({ sessions: await listSessions() })
}

const CreateSession = z.object({ cwd: z.string().optional(), model: z.string().optional() })

export async function POST(request: Request) {
  try {
    return Response.json(await createChatSession(CreateSession.parse(await request.json())))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
