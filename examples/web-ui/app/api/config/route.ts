import { DEFAULT_MODEL, MODELS, OFFLINE, runtime } from "@/lib/runtime"

export const dynamic = "force-dynamic"

/** Server identity and options. A changed pid tells the UI the server restarted. */
export async function GET() {
  await runtime() // opening recovers interrupted turns
  return Response.json({ pid: process.pid, offline: OFFLINE, defaultModel: DEFAULT_MODEL, models: MODELS })
}
