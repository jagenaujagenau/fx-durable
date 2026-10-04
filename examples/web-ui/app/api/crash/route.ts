export const dynamic = "force-dynamic"

/** kill -9 this server process. No cleanup, no graceful shutdown. */
export async function POST() {
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 50)
  return Response.json({ killed: process.pid })
}
