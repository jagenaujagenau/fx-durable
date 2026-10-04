#!/usr/bin/env node
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { Effect, Option, Stream } from "effect"
import { EventLog } from "../core/events.js"
import { decodeModelTaskMetadata } from "../core/model.js"
import { journalRecover } from "../core/recovery.js"
import type { TaskRecord, TurnRecord } from "../core/schema.js"
import { Storage } from "../core/storage.js"
import { openJournal, type Journal } from "./journal.js"
import { bold, cyan, dim, duration, eventLine, green, red, table, taskLabel, toolLabel, yellow } from "./render.js"

const HELP = `fxd — inspect and control fx-durable agents

Usage:
  fxd agents                       List agents and what they are doing
  fxd inspect <agent>              Agent state, current turn and task journal
  fxd events <agent> [--after N] [--follow]
                                   Durable event log (reconnectable by cursor)
  fxd trace <agent> [--turn ID]    Execution trace of a turn
  fxd recover                      Classify work interrupted by dead processes
  fxd cancel <submission-id>       Request cancellation (cooperative)
  fxd demo [--reset] [--crash-at POINT[:NAME]]
                                   The killer demo: crash it, restart it

Options:
  --db PATH                        Database (default: $FXD_DB or ./fx.db)
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    after: { type: "string" },
    follow: { type: "boolean", short: "f" },
    turn: { type: "string" },
    reset: { type: "boolean" },
    "crash-at": { type: "string" },
    fast: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  }
})

const [command, ...args] = positionals
const dbPath = resolve(values.db ?? process.env.FXD_DB ?? "fx.db")

const requireDb = () => {
  if (!existsSync(dbPath)) {
    process.stderr.write(`no fx-durable database at ${dbPath} (use --db)\n`)
    process.exit(1)
  }
  return openJournal(dbPath)
}

const currentTask = (tasks: ReadonlyArray<TaskRecord>): TaskRecord | null =>
  [...tasks].reverse().find((t) => t.state === "running" && t.type !== "turn") ?? null

const agents = async (journal: Journal) => {
  const rows = await journal.run(
    Effect.gen(function* () {
      const storage = yield* Storage
      const out: Array<Array<string>> = [["NAME", "STATE", "CURRENT TASK"]]
      for (const agent of yield* storage.listAgents()) {
        const turn = yield* storage.activeTurn(agent.id)
        const task = turn ? currentTask(yield* storage.tasksForTurn(turn.id)) : null
        const state = agent.state === "idle" ? agent.state : agent.state === "running" ? green(agent.state) : yellow(agent.state)
        out.push([agent.id, state, task ? taskLabel(task) : "-"])
      }
      return out
    })
  )
  if (rows.length === 1) console.log(dim("no agents"))
  else console.log(table(rows))
}

const renderTurn = (turn: TurnRecord, tasks: ReadonlyArray<TaskRecord>) => {
  const lines: Array<string> = []
  const visible = tasks.filter((t) => t.type === "tool" || t.type === "model")
  visible.forEach((task, i) => {
    const last = i === visible.length - 1
    const branch = last ? "└──" : "├──"
    const state =
      task.state === "completed"
        ? green("✓")
        : task.state === "running"
          ? cyan("●")
          : task.state === "outcome_unknown"
            ? yellow("⚠ outcome unknown")
            : task.state === "failed"
              ? red("✗")
              : dim(task.state)
    const name = task.type === "tool" ? `tool:${task.name}` : "model"
    const replay = task.parentTaskId ? dim(" (replay)") : ""
    lines.push(`${branch} ${name} ${state}${replay}`)
    if (task.type === "tool") lines.push(`${last ? "    " : "│   "}└── ${dim(toolLabel(task.name, task.input))}`)
  })
  return [`Turn ${dim(turn.id)} attempt ${turn.attempt} ${turn.state}`, ...lines].join("\n")
}

const inspect = async (journal: Journal, id: string) => {
  const output = await journal.run(
    Effect.gen(function* () {
      const storage = yield* Storage
      const agent = yield* storage.getAgent(id)
      if (!agent) return null
      const turn = yield* storage.activeTurn(id)
      const tasks = turn ? yield* storage.tasksForTurn(turn.id) : []
      const checkpoint = yield* storage.latestCheckpoint(id)
      const submissions = yield* storage.listSubmissions(id, 5)
      return { agent, turn, tasks, checkpoint, submissions }
    })
  )
  if (!output) {
    console.error(`no agent ${id}`)
    process.exitCode = 1
    return
  }
  const { agent, turn, tasks, checkpoint, submissions } = output
  console.log(
    table([
      ["Agent", agent.id],
      ["State", agent.state + (agent.stateReason ? dim(` (${agent.stateReason})`) : "")],
      ["Runtime", agent.runtimeId],
      ["Model", agent.model],
      ["Cwd", agent.cwd ?? "-"],
      ["Checkpoint", checkpoint ? `#${checkpoint.sequence} ${dim(checkpoint.createdAt.toISOString())}` : "-"]
    ])
  )
  console.log()
  if (turn) {
    console.log(bold("Current turn"))
    console.log(renderTurn(turn, tasks))
    const unknown = tasks.filter((t) => t.state === "outcome_unknown")
    for (const task of unknown) {
      console.log()
      console.log(yellow(`⚠ ${task.name} ${JSON.stringify(task.input)}: outcome unknown — will not be replayed automatically`))
    }
  } else {
    console.log(dim("No active turn"))
  }
  if (submissions.length) {
    console.log()
    console.log(bold("Recent submissions"))
    console.log(
      table([
        ["ID", "REQUEST", "STATE", "CREATED"],
        ...submissions.map((s) => [s.id, s.requestId ?? "-", s.state, s.createdAt.toISOString()])
      ])
    )
  }
}

const events = async (journal: Journal, id: string) => {
  const after = values.after ? Number(values.after) : 0
  await journal.run(
    Effect.gen(function* () {
      const log = yield* EventLog
      if (!values.follow) {
        for (const event of yield* log.history(id, after)) console.log(eventLine(event))
        return
      }
      // Followers in other processes see committed events via the durable log.
      yield* log.subscribe(id, { after, pollInterval: 250 }).pipe(Stream.runForEach((e) => Effect.sync(() => console.log(eventLine(e)))))
    })
  )
}

const trace = async (journal: Journal, id: string) => {
  const result = await journal.run(
    Effect.gen(function* () {
      const storage = yield* Storage
      const turns = yield* storage.listTurns(id, 50)
      const turn = values.turn ? turns.find((t) => t.id === values.turn) : turns[0]
      if (!turn) return null
      return { turn, tasks: yield* storage.tasksForTurn(turn.id), index: turns.length - turns.indexOf(turn) }
    })
  )
  if (!result) {
    console.error(`no turns for ${id}`)
    return
  }
  const { turn, tasks, index } = result
  console.log(`${bold(`TURN #${index}`)} ${dim(turn.id)} ${turn.state} ${dim(`attempts: ${turn.attempt}`)}`)
  const steps = tasks.filter((t) => t.type === "tool" || t.type === "model")
  steps.forEach((task, i) => {
    const last = i === steps.length - 1
    const ms = task.completedAt && task.startedAt ? task.completedAt.getTime() - task.startedAt.getTime() : null
    const name = task.type === "tool" ? (task.name ?? "tool") : "model"
    const flags = [
      task.parentTaskId ? "replay" : null,
      task.state !== "completed" ? task.state : null,
      task.attempt > 1 ? `attempt ${task.attempt}` : null
    ].filter(Boolean)
    const meta = task.type === "model" ? Option.getOrNull(decodeModelTaskMetadata(task.metadata)) : null
    const tokens = meta?.inputTokens ? dim(` ${meta.inputTokens}→${meta.outputTokens ?? 0} tok`) : ""
    console.log(
      `${last ? "└─" : "├─"} ${name.padEnd(22)} ${duration(ms).padStart(7)}${tokens}${flags.length ? " " + yellow(flags.join(", ")) : ""}`
    )
    if (task.type === "tool") console.log(`${last ? "  " : "│ "}  └─ ${dim(toolLabel(task.name, task.input))}`)
  })
}

const recover = async (journal: Journal) => {
  const classified = await journal.run(journalRecover)
  if (classified.length === 0) {
    console.log(dim("nothing to recover: no interrupted turns owned by dead processes"))
    return
  }
  for (const c of classified) {
    console.log(`${c.agentId}: turn ${dim(c.turnId)} marked interrupted`)
    for (const id of c.unknown) console.log(yellow(`  ⚠ task ${id}: outcome unknown (will not be replayed)`))
  }
  console.log(dim("The application continues these turns on its next resume()."))
}

const cancel = async (journal: Journal, id: string) => {
  await journal.run(
    Effect.gen(function* () {
      const storage = yield* Storage
      const submission = yield* storage.getSubmission(id)
      if (!submission) return yield* Effect.fail(new Error(`no submission ${id}`))
      yield* storage.updateSubmission(id, { cancelRequested: true }, new Date())
    })
  )
  console.log(`cancellation requested for ${id}; the owning process stops at the next task boundary`)
}

const main = async () => {
  if (values.help || !command) {
    console.log(HELP)
    return
  }
  if (command === "demo") {
    const { runDemo } = await import("./demo.js")
    await runDemo({ reset: values.reset ?? false, crashAt: values["crash-at"], fast: values.fast ?? false })
    return
  }
  const journal = requireDb()
  try {
    switch (command) {
      case "agents":
        await agents(journal)
        break
      case "inspect":
        await inspect(journal, args[0] ?? "")
        break
      case "events":
        await events(journal, args[0] ?? "")
        break
      case "trace":
        await trace(journal, args[0] ?? "")
        break
      case "recover":
        await recover(journal)
        break
      case "cancel":
        await cancel(journal, args[0] ?? "")
        break
      default:
        console.error(`unknown command: ${command}\n`)
        console.log(HELP)
        process.exitCode = 1
    }
  } finally {
    await journal.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
