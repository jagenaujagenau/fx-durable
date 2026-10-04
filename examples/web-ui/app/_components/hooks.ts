"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Config, Hello, JournalEvent, LiveEvent, SessionDetails, SessionList, type PendingApproval, type PermissionMode, type SessionSummary } from "./schemas"

const TERMINAL = new Set(["submission.completed", "submission.failed", "submission.cancelled"])

const readJson = async (response: Response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))

/** Server identity, polled. A pid change means the server crashed and restarted. */
export const useServer = (onRestart: (pid: number) => void) => {
  const [config, setConfig] = useState<Config | null>(null)
  const [online, setOnline] = useState(true)
  const pid = useRef<number | null>(null)
  const restart = useRef(onRestart)
  restart.current = onRestart

  useEffect(() => {
    let cancelled = false
    try {
      const stored = sessionStorage.getItem("fxd-pid")
      if (stored) pid.current = Number(stored)
    } catch {}
    const poll = async () => {
      try {
        const next = Config.parse(await readJson(await fetch("/api/config", { cache: "no-store" })))
        if (cancelled) return
        setOnline(true)
        setConfig(next)
        if (pid.current !== null && pid.current !== next.pid) restart.current(next.pid)
        pid.current = next.pid
        try {
          sessionStorage.setItem("fxd-pid", String(next.pid))
        } catch {}
      } catch {
        if (!cancelled) setOnline(false)
      }
    }
    void poll()
    const timer = setInterval(poll, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return { config, online }
}

export const useSessions = () => {
  const [sessions, setSessions] = useState<Array<SessionSummary>>([])
  const refresh = useCallback(async () => {
    try {
      setSessions(SessionList.parse(await readJson(await fetch("/api/sessions", { cache: "no-store" }))).sessions)
    } catch {
      // server restarting
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { sessions, refresh }
}

export const useSessionDetails = (id: string | null) => {
  const [details, setDetails] = useState<SessionDetails | null>(null)
  const [missing, setMissing] = useState(false)
  const refresh = useCallback(async () => {
    if (!id) return setDetails(null)
    try {
      const response = await fetch(`/api/session?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      setMissing(response.status === 404)
      setDetails(SessionDetails.parse(await readJson(response)))
    } catch {
      // server restarting, or an unknown session
    }
  }, [id])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const update = useCallback(
    async (patch: { model?: string; mode?: PermissionMode }) => {
      if (!id) return
      const response = await fetch(`/api/session?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      })
      setDetails(SessionDetails.parse(await readJson(response)))
    },
    [id]
  )
  return { details, missing, refresh, update }
}

/**
 * The session's journal and live events over one EventSource. EventSource
 * reconnects by itself after a crash and resumes from Last-Event-ID.
 */
export const useSessionStream = (id: string | null, onSettled: () => void) => {
  const [events, setEvents] = useState<Array<JournalEvent>>([])
  const [approvals, setApprovals] = useState<Array<PendingApproval>>([])
  const [mode, setMode] = useState<PermissionMode | null>(null)
  // Live output of running tools (bash), by task id = tool call id.
  const [progress, setProgress] = useState<ReadonlyMap<string, string>>(new Map())
  const [connected, setConnected] = useState(false)
  const settled = useRef(onSettled)
  settled.current = onSettled

  useEffect(() => {
    setEvents([])
    setApprovals([])
    setMode(null)
    setProgress(new Map())
    if (!id) return
    const source = new EventSource(`/api/journal?id=${encodeURIComponent(id)}`)
    source.addEventListener("hello", (message) => {
      Hello.parse(JSON.parse(message.data))
      setConnected(true)
      // Pending prompts are re-sent on every connect; start from a clean slate.
      setApprovals([])
    })
    source.onerror = () => setConnected(false)
    source.onmessage = (message) => {
      const event = JournalEvent.parse(JSON.parse(message.data))
      setEvents((previous) => (previous.some((e) => e.sequence === event.sequence) ? previous : [...previous, event].slice(-1000)))
      if (TERMINAL.has(event.type)) settled.current()
    }
    source.addEventListener("live", (message) => {
      const event = LiveEvent.parse(JSON.parse(message.data))
      if (event.type === "approval-requested") {
        setApprovals((previous) => (previous.some((a) => a.approvalId === event.approval.approvalId) ? previous : [...previous, event.approval]))
      } else if (event.type === "approval-resolved") {
        setApprovals((previous) => previous.filter((a) => a.approvalId !== event.approvalId))
      } else if (event.type === "tool-progress") {
        setProgress((previous) => new Map(previous).set(event.taskId, ((previous.get(event.taskId) ?? "") + event.chunk).slice(-20_000)))
      } else {
        setMode(event.mode)
      }
    })
    return () => source.close()
  }, [id])

  let running = false
  let contextTokens = 0
  for (const event of events) {
    if (event.type === "submission.started") running = true
    if (TERMINAL.has(event.type)) running = false
    if (event.type === "model.completed") contextTokens = (event.payload.usage?.inputTokens ?? 0) + (event.payload.usage?.outputTokens ?? 0)
  }

  return { events, approvals, mode, running, contextTokens, connected, progress }
}
