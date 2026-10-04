/**
 * Runs `next dev` and starts it again whenever it dies, so the "Crash server"
 * button (kill -9) behaves like a production process manager restarting a
 * crashed instance. On restart, DurableFx.open() recovers the interrupted turn.
 */
import { spawn } from "node:child_process"

const next = new URL("../node_modules/.bin/next", import.meta.url).pathname
let stopping = false
let child

const start = () => {
  const startedAt = Date.now()
  child = spawn(next, ["dev", "--port", process.env.PORT ?? "3100"], { stdio: "inherit" })
  child.on("exit", (code, signal) => {
    // A server that dies right after starting (e.g. port in use) is not a crash: give up.
    if (stopping || Date.now() - startedAt < 5000) return process.exit(code ?? 0)
    console.log(`\n[supervise] server exited (${signal ?? `code ${code}`}); restarting…\n`)
    setTimeout(start, 300)
  })
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true
    child?.kill(signal)
  })
}

start()
