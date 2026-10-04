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

const summarize = async (record: DurableAgentRecord): Promise<SessionSummary> => {
  const { fx } = await runtime()
  const submissions = await (await fx.attach(record.id)).submissions(200)
  return {
    id: record.id,
    title: titleOf(submissions),
    cwd: record.cwd,
    model: record.model,
    state: record.state,
    updatedAt: record.updatedAt.toISOString()
  }
}

export const listSessions = async () => {
  const { fx } = await runtime()
  const agents = await fx.listAgents()
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
  const running = submissions.find((s) => s.state === "queued" || s.state === "running")
  return {
    ...(await summarize(record)),
    mode: live.modeOf(id),
    pendingApprovals: live.pending(id),
    usage: { inputTokens, outputTokens, turns: submissions.length },
    runningSubmissionId: running?.id ?? null
  }
}
