import { z } from "zod"
import { live } from "@/lib/live"

export const dynamic = "force-dynamic"

const Decision = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["allow", "allow-session", "deny"]),
  reason: z.string().optional()
})

export async function POST(request: Request) {
  const { approvalId, decision, reason } = Decision.parse(await request.json())
  const resolved = live.resolve(approvalId, decision, reason)
  return Response.json({ resolved }, { status: resolved ? 200 : 404 })
}
