"use client"

import { RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block"
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { FileContent, FileTreeResponse, type FileNode, type JournalEvent } from "./schemas"
import { languageOf } from "./tool-call"

export type PanelTab = "files" | "journal"

const Tree = ({ nodes }: { nodes: ReadonlyArray<FileNode> }) => (
  <>
    {nodes.map((node) =>
      node.children ? (
        <FileTreeFolder key={node.path} path={node.path} name={node.name}>
          <Tree nodes={node.children} />
        </FileTreeFolder>
      ) : (
        <FileTreeFile key={node.path} path={node.path} name={node.name} />
      )
    )}
  </>
)

const Files = ({ sessionId, version }: { sessionId: string; version: number }) => {
  const [tree, setTree] = useState<{ cwd: string; tree: ReadonlyArray<FileNode> } | null>(null)
  const [selected, setSelected] = useState<string | undefined>()
  const [file, setFile] = useState<FileContent | null>(null)

  const load = useCallback(async () => {
    const response = await fetch(`/api/files?id=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
    if (response.ok) setTree(FileTreeResponse.parse(await response.json()))
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load, version])

  useEffect(() => {
    if (!selected) return setFile(null)
    let cancelled = false
    void (async () => {
      const response = await fetch(`/api/files?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(selected)}`, { cache: "no-store" })
      if (!cancelled) setFile(response.ok ? FileContent.parse(await response.json()) : null)
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, selected, version])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <code className="min-w-0 flex-1 truncate text-muted-foreground text-xs" title={tree?.cwd}>
          {tree?.cwd}
        </code>
        <Button size="icon-sm" variant="ghost" onClick={() => void load()} aria-label="Refresh files">
          <RefreshCwIcon />
        </Button>
      </div>
      <div className="max-h-[40%] min-h-24 overflow-auto">
        {tree && (
          <FileTree selectedPath={selected} onSelect={setSelected} className="border-0 bg-transparent">
            <Tree nodes={tree.tree} />
          </FileTree>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {file?.content !== null && file !== null ? (
          <CodeBlock code={file.content} language={languageOf(file.path)} showLineNumbers>
            <CodeBlockCopyButton />
          </CodeBlock>
        ) : file ? (
          <p className="p-3 text-muted-foreground text-sm">File too large to preview ({file.size} bytes).</p>
        ) : (
          <p className="p-3 text-muted-foreground text-sm">Select a file to view it. The view follows the agent&apos;s edits.</p>
        )}
      </div>
    </div>
  )
}

const tone = (type: string) => {
  if (type.startsWith("recovery") || type === "turn.recovered" || type === "tool.replayed" || type === "tool.reused") return "text-teal-600 dark:text-teal-400 font-semibold"
  if (type.endsWith("interrupted") || type.includes("outcome_unknown")) return "text-amber-600 dark:text-amber-400 font-semibold"
  if (type.endsWith("failed") || type.endsWith("cancelled")) return "text-red-600 dark:text-red-400 font-semibold"
  if (type.startsWith("tool")) return "text-violet-600 dark:text-violet-400"
  if (type.startsWith("model")) return "text-blue-600 dark:text-blue-400"
  return "text-muted-foreground"
}

const detail = ({ type, payload }: JournalEvent) => {
  if (payload.tool !== undefined) return `${payload.tool}${payload.replay !== undefined ? ` · replay ${String(payload.replay)}` : ""}`
  if (type === "model.completed" && payload.text !== undefined) return payload.text.slice(0, 80)
  if (payload.attempt !== undefined && (type === "turn.started" || type === "turn.recovered")) return `attempt ${payload.attempt}`
  return payload.reason ?? payload.error ?? ""
}

const Journal = ({ events }: { events: ReadonlyArray<JournalEvent> }) => (
  <ol className="h-full overflow-auto font-mono text-[11.5px] leading-5">
    {events
      .slice()
      .reverse()
      .map((event) => (
        <li key={event.sequence} className="grid grid-cols-[3rem_auto_1fr] gap-2 px-1">
          <span className="text-right text-muted-foreground tabular-nums">#{event.sequence}</span>
          <span className={tone(event.type)}>{event.type}</span>
          <span className="truncate text-muted-foreground">{detail(event)}</span>
        </li>
      ))}
  </ol>
)

export const SidePanel = ({
  sessionId,
  tab,
  onTabChange,
  events,
  fileVersion,
  className
}: {
  sessionId: string
  tab: PanelTab
  onTabChange: (tab: PanelTab) => void
  events: ReadonlyArray<JournalEvent>
  fileVersion: number
  className?: string
}) => (
  <aside className={cn("flex min-h-0 flex-col border-l bg-muted/20", className)}>
    <Tabs value={tab} onValueChange={(value) => onTabChange(value === "journal" ? "journal" : "files")} className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="journal">Journal · {events.length}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="files" className="min-h-0 flex-1 p-2">
        <Files sessionId={sessionId} version={fileVersion} />
      </TabsContent>
      <TabsContent value="journal" className="min-h-0 flex-1 p-2">
        <Journal events={events} />
      </TabsContent>
    </Tabs>
  </aside>
)
