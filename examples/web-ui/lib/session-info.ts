import { Schema } from "effect"
import type { DurableAgentRecord, SubmissionRecord } from "fx-durable"
import { live } from "./live"
import { runtime } from "./runtime"

export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly cwd: string | null
  readonly model: string
  readonly state: string
  readonly updatedAt: string
}

const isString = Schema.is(Schema.String)

const titleOf = (submissions: ReadonlyArray<SubmissionRecord>) => {
  const first = submissions.at(-1)
  if (!first) return "New session"
  const text = isString(first.content) ? first.content : first.content.map((b) => b.text).join(" ")
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** "Fork of …" for a fork that has no requests of its own yet. */
const forkTitle = async (id: string): Promise<string | null> => {
  const origin = live.forkOf(id)
  if (!origin) return null
  const { fx } = await runtime()
  const source = await fx.attach(origin.from).catch(() => null)
  return source ? `Fork of ${titleOf(await source.submissions(200))}` : null
}

const summarize = async (record: DurableAgentRecord): Promise<SessionSummary> => {
  const { fx } = await runtime()
  const agent = await fx.attach(record.id)
  const submissions = await agent.submissions(200)
  return {
    id: record.id,
    title: submissions.length === 0 ? ((await forkTitle(record.id)) ?? titleOf(submissions)) : titleOf(submissions),
    cwd: record.cwd,
    model: record.model,
    state: submissions.some((s) => s.state === "running") ? "running" : "idle",
    updatedAt: record.updatedAt.toISOString()
  }
}

export const listSessions = async () => {
  const { fx } = await runtime()
  // Subagents' child agents ("parent/tool/key") belong to their parent's tool call, not the sidebar.
  const agents = (await fx.listAgents()).filter((agent) => !agent.id.includes("/"))
  const summaries = await Promise.all(agents.map(summarize))
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export const sessionDetails = async (id: string) => {
  const { fx } = await runtime()
  const agent = await fx.attach(id)
  const record = await agent.info()
  const submissions = await agent.submissions(200)
  let inputTokens = 0
  let outputTokens = 0
  for (const submission of submissions) {
    inputTokens += submission.result?.usage?.inputTokens ?? 0
    outputTokens += submission.result?.usage?.outputTokens ?? 0
  }
  const running = submissions.find((s) => s.state === "running")
  return {
    ...(await summarize(record)),
    mode: live.modeOf(id),
    pendingApprovals: live.pending(id),
    usage: { inputTokens, outputTokens, turns: submissions.length },
    runningSubmissionId: running?.id ?? null
  }
}
