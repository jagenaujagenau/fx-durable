import { z } from "zod"
import { createChatSession, forkChatSession } from "@/lib/runtime"
import { listSessions } from "@/lib/session-info"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json({ sessions: await listSessions() })
}

const CreateSession = z.object({ cwd: z.string().optional(), model: z.string().optional(), forkFrom: z.string().optional() })

export async function POST(request: Request) {
  try {
    const { forkFrom, ...options } = CreateSession.parse(await request.json())
    return Response.json(forkFrom ? await forkChatSession(forkFrom) : await createChatSession(options))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
