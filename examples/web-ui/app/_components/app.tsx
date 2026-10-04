"use client"

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, isToolUIPart, validateUIMessages, type UIMessage } from "ai"
import {
  FilesIcon,
  FolderIcon,
  HistoryIcon,
  MessageSquarePlusIcon,
  PanelRightIcon,
  ShieldIcon,
  SkullIcon,
  SparklesIcon
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { Context, ContextContent, ContextContentBody, ContextContentHeader, ContextInputUsage, ContextOutputUsage, ContextTrigger } from "@/components/ai-elements/context"
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger
} from "@/components/ai-elements/model-selector"
import { PromptInput, PromptInputBody, PromptInputButton, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "@/components/ai-elements/prompt-input"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useServer, useSessionDetails, useSessionStream, useSessions } from "./hooks"
import { ApiError, CreatedSession, HistoryResponse, SessionList, TodoInput, type Config, type PermissionMode, type SessionSummary, type Todo } from "./schemas"
import { SidePanel, type PanelTab } from "./side-panel"
import { approvalFor, ToolCall, TodoList, type ApprovalDecision } from "./tool-call"

const MODES: ReadonlyArray<{ id: PermissionMode; label: string; hint: string }> = [
  { id: "default", label: "Ask before edits", hint: "Asks before editing files or running commands" },
  { id: "acceptEdits", label: "⏵⏵ Accept edits", hint: "Edits files without asking; still asks before commands" },
  { id: "plan", label: "⏸ Plan mode", hint: "Read-only: investigates and proposes a plan" },
  { id: "bypassPermissions", label: "⏵⏵ Bypass permissions", hint: "Never asks. Use in throwaway workspaces" }
]

const COMMANDS: ReadonlyArray<{ name: string; args?: string; description: string }> = [
  { name: "/new", args: "[path]", description: "Start a new session (optionally in an existing directory)" },
  { name: "/clear", description: "Start a fresh session in the same workspace" },
  { name: "/model", args: "[id]", description: "Switch model" },
  { name: "/mode", args: "[default|acceptEdits|plan|bypassPermissions]", description: "Set the permission mode" },
  { name: "/files", description: "Show the workspace files" },
  { name: "/journal", description: "Show the durable event journal" },
  { name: "/cost", description: "Token usage for this session" },
  { name: "/compact", description: "Compact the context" },
  { name: "/help", description: "List commands and shortcuts" }
]

const SUGGESTIONS = ["Fix the failing tests", "Explain this project", "Add a removeItem(items, sku) function with tests"]

const relativeTime = (iso: string) => {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

const storage = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {}
  }
}

const createSession = async (options: { cwd?: string; model?: string }) => {
  const response = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(options) })
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(ApiError.safeParse(body).data?.error ?? `HTTP ${response.status}`)
  return CreatedSession.parse(body)
}

// One in-flight "create the first session" per page, even under React's double effects.
let booting: Promise<unknown> | null = null

// ---------------------------------------------------------------------------

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [banner, setBannerState] = useState<string | null>(null)
  // Next dev reloads the page right after a restart; keep the notice across that reload.
  const setBanner = useCallback((text: string | null) => {
    setBannerState(text)
    try {
      if (text) sessionStorage.setItem("fxd-banner", text)
      else sessionStorage.removeItem("fxd-banner")
    } catch {}
  }, [])
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("fxd-banner")
      if (saved) setBannerState(saved)
    } catch {}
  }, [])
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const { sessions, refresh: refreshSessions } = useSessions()
  const [restarts, setRestarts] = useState(0)
  const { config, online } = useServer((pid) => {
    setBanner(`The server restarted (pid ${pid}). fx-durable recovered every interrupted turn from the journal.`)
    setRestarts((n) => n + 1)
    void refreshSessions()
  })

  const select = useCallback((id: string) => {
    storage.set("fxd-session", id)
    setSessionId(id)
  }, [])

  const startSession = useCallback(
    async (options: { cwd?: string; model?: string } = {}) => {
      const created = await createSession(options)
      await refreshSessions()
      select(created.id)
      return created
    },
    [refreshSessions, select]
  )

  // Reopen the last session (or the most recent one); start one only if there are none.
  const configLoaded = config !== null
  useEffect(() => {
    if (!configLoaded) return
    let cancelled = false
    void (async () => {
      const stored = storage.get("fxd-session")
      if (stored && (await fetch(`/api/session?id=${encodeURIComponent(stored)}`, { cache: "no-store" })).ok) {
        if (!cancelled) select(stored)
        return
      }
      const existing = SessionList.parse(await (await fetch("/api/sessions", { cache: "no-store" })).json()).sessions[0]
      if (cancelled) return
      if (existing) select(existing.id)
      else await (booting ??= startSession().finally(() => (booting = null)))
    })()
    return () => {
      cancelled = true
    }
  }, [configLoaded, select, startSession])

  // The selected session vanished: open the most recent one, or start a new one.
  const recover = useCallback(() => {
    void (async () => {
      const existing = SessionList.parse(await (await fetch("/api/sessions", { cache: "no-store" })).json()).sessions.find((s) => s.id !== sessionId)
      if (existing) select(existing.id)
      else await startSession()
    })()
  }, [sessionId, select, startSession])

  const crash = async () => {
    setBanner(null)
    await fetch("/api/crash", { method: "POST" }).catch(() => undefined)
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        onSelect={select}
        onNew={() => setNewSessionOpen(true)}
        config={config}
        online={online}
        onCrash={crash}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {banner && (
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="border-teal-500/30 border-b bg-teal-500/10 px-4 py-2 text-left text-sm"
          >
            {banner} <span className="text-muted-foreground">(dismiss)</span>
          </button>
        )}
        {!online && <div className="border-red-500/30 border-b bg-red-500/10 px-4 py-2 text-sm">Server is down — waiting for it to restart…</div>}
        {sessionId && config ? (
          <ChatView
            key={sessionId}
            sessionId={sessionId}
            config={config}
            online={online}
            restarts={restarts}
            onSessionsChanged={refreshSessions}
            onNewSession={startSession}
            onMissing={recover}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Shimmer>Starting…</Shimmer>
          </div>
        )}
      </main>
      <NewSessionDialog
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        config={config}
        onCreate={async (options) => {
          await startSession(options)
          setNewSessionOpen(false)
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  config,
  online,
  onCrash
}: {
  sessions: ReadonlyArray<SessionSummary>
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  config: Config | null
  online: boolean
  onCrash: () => void
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/30 md:flex">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="grid size-7 place-items-center rounded-md bg-foreground font-bold font-mono text-background text-xs">fx</div>
        <div className="min-w-0">
          <div className="font-semibold text-sm leading-tight">fx-durable code</div>
          <div className="text-muted-foreground text-xs">AI SDK harness · durable</div>
        </div>
      </div>
      <div className="px-3">
        <Button variant="outline" className="w-full justify-start gap-2" onClick={onNew}>
          <MessageSquarePlusIcon className="size-4" /> New session
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-1.5 px-4 text-muted-foreground text-xs">
        <HistoryIcon className="size-3.5" /> Sessions
      </div>
      <nav className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelect(session.id)}
            className={cn(
              "w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
              session.id === activeId && "bg-accent"
            )}
          >
            <div className="flex items-center gap-1.5">
              {session.state === "running" && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-blue-500" />}
              <span className="truncate text-sm">{session.title}</span>
            </div>
            <div className="truncate text-muted-foreground text-xs">
              {relativeTime(session.updatedAt)} · {session.model.split("/").at(-1)}
            </div>
          </button>
        ))}
      </nav>
      <div className="space-y-2 border-t p-3">
        <div className="flex items-center gap-2 text-muted-foreground text-xs tabular-nums">
          <span className={cn("size-2 rounded-full", online ? "bg-emerald-500" : "animate-pulse bg-red-500")} />
          {online ? `server pid ${config?.pid ?? "…"}` : "server down"}
          {config?.offline && <span className="ml-auto rounded bg-muted px-1.5 py-0.5">offline model</span>}
        </div>
        <Button variant="destructive" size="sm" className="w-full gap-2" disabled={!online} onClick={onCrash}>
          <SkullIcon className="size-4" /> Crash server (kill -9)
        </Button>
      </div>
    </aside>
  )
}

function NewSessionDialog({
  open,
  onOpenChange,
  config,
  onCreate
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: Config | null
  onCreate: (options: { cwd?: string; model?: string }) => Promise<void>
}) {
  const [cwd, setCwd] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onCreate(cwd.trim() ? { cwd: cwd.trim() } : {})
      setCwd("")
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Leave the path empty to get a copy of the sample project. Or point the agent at a directory on this machine
            {config?.offline ? "" : " (it will be able to edit files and run commands there, with your permission)"}.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="/path/to/your/project (optional)"
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void submit()}
          className="font-mono"
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <DialogFooter>
          <Button onClick={() => void submit()} disabled={busy}>
            <FolderIcon className="size-4" /> Start session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------

interface Notice {
  readonly after: number
  readonly text: string
}

const latestTodos = (messages: ReadonlyArray<UIMessage>): Array<Todo> | null => {
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (isToolUIPart(part) && (part.type === "tool-todo_write" || (part.type === "dynamic-tool" && part.toolName === "todo_write"))) {
        const parsed = TodoInput.safeParse(part.input)
        if (parsed.success) return parsed.data.todos
      }
    }
  }
  return null
}

function ChatView({
  sessionId,
  config,
  online,
  restarts,
  onSessionsChanged,
  onNewSession,
  onMissing
}: {
  sessionId: string
  config: Config
  online: boolean
  restarts: number
  onMissing: () => void
  onSessionsChanged: () => Promise<void>
  onNewSession: (options?: { cwd?: string; model?: string }) => Promise<{ id: string; cwd: string }>
}) {
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), [])
  const { messages, sendMessage, setMessages, status, clearError, error } = useChat({ id: sessionId, transport })
  const { details, missing, refresh: refreshDetails, update } = useSessionDetails(sessionId)
  // The session no longer exists (e.g. its data was deleted): move on.
  useEffect(() => {
    if (missing) onMissing()
  }, [missing, onMissing])
  const [input, setInput] = useState("")
  const [notices, setNotices] = useState<Array<Notice>>([])
  const [queue, setQueue] = useState<Array<string>>([])
  const [panel, setPanel] = useState<PanelTab | null>(() => (storage.get("fxd-panel") === "none" ? null : storage.get("fxd-panel") === "journal" ? "journal" : "files"))
  const [modelOpen, setModelOpen] = useState(false)
  const statusRef = useRef(status)
  statusRef.current = status

  const loadHistory = useCallback(async () => {
    const response = await fetch(`/api/history?id=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
    if (!response.ok) return
    const raw = HistoryResponse.parse(await response.json()).messages
    const history = raw.length === 0 ? [] : await validateUIMessages({ messages: raw })
    // Never replace what this tab is streaming right now (including the message just sent).
    if (statusRef.current === "submitted" || statusRef.current === "streaming") return
    clearError()
    setMessages(history)
  }, [sessionId, clearError, setMessages])

  const stream = useSessionStream(sessionId, () => {
    void refreshDetails()
    void onSessionsChanged()
    // A turn can finish without this tab streaming it (after a crash, or from
    // another tab). Pick up the result from the journal.
    if (statusRef.current !== "streaming" && statusRef.current !== "submitted") void loadHistory()
  })

  useEffect(() => {
    void loadHistory()
  }, [loadHistory, restarts])

  const mode = stream.mode ?? details?.mode ?? "default"
  const busy = status === "submitted" || status === "streaming" || stream.running
  const notice = (text: string) => setNotices((previous) => [...previous, { after: messages.length, text }])

  // Send queued messages once the agent is idle, like Claude Code.
  useEffect(() => {
    if (busy || queue.length === 0 || !online) return
    const [next, ...rest] = queue
    setQueue(rest)
    if (next) void sendMessage({ text: next })
  }, [busy, queue, online, sendMessage])

  const setMode = (next: PermissionMode) => void update({ mode: next })
  const cycleMode = () => {
    const index = MODES.findIndex((m) => m.id === mode)
    setMode(MODES[(index + 1) % MODES.length]?.id ?? "default")
  }

  const decide = useCallback(async (approvalId: string, decision: ApprovalDecision) => {
    await fetch("/api/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId, decision }) })
  }, [])

  const interrupt = useCallback(async () => {
    setQueue([])
    await fetch("/api/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sessionId }) })
  }, [sessionId])

  const openPanel = (tab: PanelTab | null) => {
    setPanel(tab)
    storage.set("fxd-panel", tab ?? "none")
  }

  const runCommand = async (line: string) => {
    const [name, ...rest] = line.trim().split(/\s+/)
    const arg = rest.join(" ")
    switch (name) {
      case "/new":
        await onNewSession(arg ? { cwd: arg } : {}).catch((failure: Error) => notice(failure.message))
        return
      case "/clear":
        await onNewSession(details?.cwd && !details.cwd.includes("/.data/workspaces/") ? { cwd: details.cwd } : {})
        return
      case "/model":
        if (arg) {
          await update({ model: arg })
          notice(`Model set to ${arg}.`)
        } else setModelOpen(true)
        return
      case "/mode": {
        const found = MODES.find((m) => m.id === arg)
        if (found) setMode(found.id)
        else cycleMode()
        return
      }
      case "/files":
        return openPanel("files")
      case "/journal":
        return openPanel("journal")
      case "/cost":
        await refreshDetails()
        notice(
          details
            ? `This session: ${details.usage.turns} turns · ${details.usage.inputTokens.toLocaleString()} input tokens · ${details.usage.outputTokens.toLocaleString()} output tokens · model ${details.model}.`
            : "No usage yet."
        )
        return
      case "/compact":
        notice("Compaction is not available: libfx manages the context itself, and fx-durable checkpoints it after every turn.")
        return
      default:
        notice(
          [
            "Commands: " + COMMANDS.map((c) => `${c.name}${c.args ? ` ${c.args}` : ""}`).join(" · "),
            "Shortcuts: Enter send · Shift+Enter newline · Shift+Tab cycle permission mode · Esc interrupt (or deny a permission prompt) · type while the agent works to queue a message"
          ].join("\n")
        )
    }
  }

  const submit = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setInput("")
    if (trimmed.startsWith("/")) return void runCommand(trimmed)
    if (busy || !online) return setQueue((previous) => [...previous, trimmed])
    void sendMessage({ text: trimmed })
  }

  // Esc interrupts (or denies a pending permission prompt); Enter approves when the prompt is focused-out.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const first = stream.approvals[0]
      const typing = event.target instanceof HTMLTextAreaElement && event.target.value.length > 0
      if (event.key === "Escape") {
        if (first) void decide(first.approvalId, "deny")
        else if (busy) void interrupt()
      } else if (event.key === "Enter" && first && !typing && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault()
        void decide(first.approvalId, "allow")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [stream.approvals, busy, decide, interrupt])

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault()
      cycleMode()
    }
  }

  const todos = latestTodos(messages)
  const showTodos = todos !== null && busy
  const commandMatches = input.startsWith("/") && !input.includes(" ") ? COMMANDS.filter((c) => c.name.startsWith(input)) : []
  const fileVersion = stream.events.filter((e) => e.type === "tool.completed" && ["write_file", "edit_file", "bash"].includes(e.payload.tool ?? "")).length
  // Approvals that match no visible tool card (e.g. after a reload) are shown on their own.
  const orphanApprovals = stream.approvals.filter(
    (approval) => !messages.some((m) => m.parts.some((part) => isToolUIPart(part) && approvalFor(part, [approval]) !== undefined))
  )
  const model = details?.model ?? config.defaultModel
  const modelInfo = config.models.find((m) => m.id === model)

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-sm">{details?.title ?? "…"}</div>
            <code className="block truncate text-muted-foreground text-xs" title={details?.cwd ?? ""}>
              {details?.cwd}
            </code>
          </div>
          <Context maxTokens={200_000} usedTokens={stream.contextTokens} usage={undefined}>
            <ContextTrigger />
            <ContextContent>
              <ContextContentHeader />
              <ContextContentBody>
                <ContextInputUsage />
                <ContextOutputUsage />
                <p className="text-muted-foreground text-xs">
                  Session total: {(details?.usage.inputTokens ?? 0).toLocaleString()} in · {(details?.usage.outputTokens ?? 0).toLocaleString()} out
                </p>
              </ContextContentBody>
            </ContextContent>
          </Context>
          <Button size="icon-sm" variant={panel === "files" ? "secondary" : "ghost"} aria-label="Files" onClick={() => openPanel(panel === "files" ? null : "files")}>
            <FilesIcon />
          </Button>
          <Button size="icon-sm" variant={panel === "journal" ? "secondary" : "ghost"} aria-label="Journal" onClick={() => openPanel(panel === "journal" ? null : "journal")}>
            <PanelRightIcon />
          </Button>
        </header>

        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
            {messages.length === 0 && notices.length === 0 ? (
              <ConversationEmptyState
                icon={<SparklesIcon className="size-8" />}
                title="What should we build?"
                description="The agent reads, edits and runs code in this workspace. Every step is journaled: kill the server mid-task and it picks up where it left off."
              >
                <div className="mt-6 flex flex-col items-center gap-3">
                  <SparklesIcon className="size-8 text-muted-foreground" />
                  <h2 className="font-semibold text-lg">What should we build?</h2>
                  <p className="max-w-md text-balance text-center text-muted-foreground text-sm">
                    The agent reads, edits and runs code in this workspace. Every step is journaled: kill the server mid-task and it
                    picks up where it left off.
                  </p>
                  <Suggestions className="mt-2 justify-center">
                    {SUGGESTIONS.map((suggestion) => (
                      <Suggestion key={suggestion} suggestion={suggestion} onClick={(value) => submit(value)} />
                    ))}
                  </Suggestions>
                </div>
              </ConversationEmptyState>
            ) : (
              messages.map((message, index) => (
                <div key={message.id} className="space-y-6">
                  <Message from={message.role}>
                    <MessageContent className={message.role === "assistant" ? "w-full" : undefined}>
                      {message.parts.map((part, i) => {
                        if (part.type === "text") {
                          return message.role === "assistant" ? (
                            <MessageResponse key={i}>{part.text}</MessageResponse>
                          ) : (
                            <p key={i} className="whitespace-pre-wrap">
                              {part.text}
                            </p>
                          )
                        }
                        if (isToolUIPart(part)) return <ToolCall key={i} part={part} approval={approvalFor(part, stream.approvals)} onDecide={decide} />
                        return null
                      })}
                    </MessageContent>
                  </Message>
                  {notices
                    .filter((n) => n.after === index + 1)
                    .map((n, i) => (
                      <NoticeLine key={i} text={n.text} />
                    ))}
                </div>
              ))
            )}
            {messages.length === 0 && notices.map((n, i) => <NoticeLine key={i} text={n.text} />)}
            {orphanApprovals.map((approval) => (
              <div key={approval.approvalId} className="rounded-md border p-3">
                <p className="mb-2 font-mono text-xs">
                  {approval.tool} {JSON.stringify(approval.input)}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void decide(approval.approvalId, "allow")}>
                    Allow
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void decide(approval.approvalId, "deny")}>
                    Deny
                  </Button>
                </div>
              </div>
            ))}
            {busy && status !== "streaming" && (
              <Shimmer className="text-sm">{stream.running && status !== "submitted" ? "Working (durably)… Esc to interrupt" : "Thinking…"}</Shimmer>
            )}
            {status === "streaming" && <Shimmer className="text-muted-foreground text-xs">Esc to interrupt</Shimmer>}
            {error && !stream.running && <NoticeLine text={`The connection to this turn was lost (${error.message}). It keeps running on the server; the result will appear here.`} />}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="mx-auto w-full max-w-3xl px-4 pb-4">
          {showTodos && todos && (
            <div className="mb-2 rounded-lg border bg-card px-3 py-2">
              <TodoList todos={todos} />
            </div>
          )}
          {queue.length > 0 && (
            <div className="mb-2 space-y-1">
              {queue.map((queued, i) => (
                <div key={i} className="truncate rounded-md border border-dashed px-3 py-1.5 text-muted-foreground text-sm">
                  Queued: {queued}
                </div>
              ))}
            </div>
          )}
          {commandMatches.length > 0 && (
            <div className="mb-2 overflow-hidden rounded-lg border bg-popover shadow-sm">
              {commandMatches.map((command) => (
                <button
                  key={command.name}
                  type="button"
                  className="flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => (command.args ? setInput(`${command.name} `) : submit(command.name))}
                >
                  <span className="font-mono">{command.name}</span>
                  <span className="text-muted-foreground text-xs">{command.description}</span>
                </button>
              ))}
            </div>
          )}
          <PromptInput onSubmit={(message) => submit(message.text)}>
            <PromptInputBody>
              <PromptInputTextarea
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
                onKeyDown={onTextareaKeyDown}
                placeholder={busy ? "The agent is working. Type to queue a message…" : "Ask the agent to change, run or explain code. / for commands"}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <PromptInputButton onClick={cycleMode} title={`${MODES.find((m) => m.id === mode)?.hint} (Shift+Tab to cycle)`}>
                  <ShieldIcon className="size-4" />
                  <span className={cn(mode === "bypassPermissions" && "text-red-600", mode === "plan" && "text-teal-600", mode === "acceptEdits" && "text-violet-600")}>
                    {MODES.find((m) => m.id === mode)?.label}
                  </span>
                </PromptInputButton>
                <ModelSelector open={modelOpen} onOpenChange={setModelOpen}>
                  <ModelSelectorTrigger asChild>
                    <PromptInputButton>
                      {modelInfo && <ModelSelectorLogo provider={modelInfo.provider} />}
                      <span>{modelInfo?.name ?? model}</span>
                    </PromptInputButton>
                  </ModelSelectorTrigger>
                  <ModelSelectorContent title="Model">
                    <ModelSelectorInput placeholder="Search models…" />
                    <ModelSelectorList>
                      <ModelSelectorEmpty>No model found.</ModelSelectorEmpty>
                      <ModelSelectorGroup heading={config.offline ? "Offline: the scripted model answers regardless" : "AI Gateway"}>
                        {config.models.map((m) => (
                          <ModelSelectorItem
                            key={m.id}
                            value={m.id}
                            onSelect={() => {
                              void update({ model: m.id })
                              setModelOpen(false)
                            }}
                          >
                            <ModelSelectorLogo provider={m.provider} />
                            <ModelSelectorName>{m.name}</ModelSelectorName>
                            {m.id === model && <span className="ml-auto text-muted-foreground text-xs">current</span>}
                          </ModelSelectorItem>
                        ))}
                      </ModelSelectorGroup>
                    </ModelSelectorList>
                  </ModelSelectorContent>
                </ModelSelector>
              </PromptInputTools>
              <PromptInputSubmit
                status={busy ? "streaming" : status === "error" ? "ready" : status}
                onStop={() => void interrupt()}
                disabled={!online || (!busy && input.trim().length === 0)}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
      {panel && <SidePanel sessionId={sessionId} tab={panel} onTabChange={openPanel} events={stream.events} fileVersion={fileVersion} className="hidden w-[420px] shrink-0 lg:flex" />}
    </div>
  )
}

const NoticeLine = ({ text }: { text: string }) => (
  <div className="whitespace-pre-wrap rounded-md border-muted-foreground/30 border-l-2 bg-muted/40 px-3 py-2 text-muted-foreground text-sm">{text}</div>
)
