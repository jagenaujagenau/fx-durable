import { readdir, readFile, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { runtime } from "@/lib/runtime"

export const dynamic = "force-dynamic"

const IGNORED = new Set([".git", "node_modules", ".next", ".data"])
const MAX_ENTRIES = 2000
const MAX_FILE_BYTES = 512 * 1024

interface TreeNode {
  readonly name: string
  readonly path: string
  readonly children?: ReadonlyArray<TreeNode>
}

const walk = async (root: string, dir: string, budget: { left: number }): Promise<Array<TreeNode>> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nodes: Array<TreeNode> = []
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name) || budget.left-- <= 0) continue
    const absolute = join(dir, entry.name)
    const path = relative(root, absolute)
    nodes.push(entry.isDirectory() ? { name: entry.name, path, children: await walk(root, absolute, budget) } : { name: entry.name, path })
  }
  return nodes
}

/** The session's workspace: the file tree, or one file's content with ?path=. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const id = z.string().min(1).parse(params.get("id"))
  const { fx } = await runtime()
  const cwd = (await (await fx.attach(id)).info()).cwd
  if (!cwd) return Response.json({ error: "session has no workspace" }, { status: 404 })

  const path = params.get("path")
  if (path === null) return Response.json({ cwd, tree: await walk(cwd, cwd, { left: MAX_ENTRIES }) })

  const absolute = resolve(cwd, path)
  const fromRoot = relative(cwd, absolute)
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return Response.json({ error: "outside the workspace" }, { status: 400 })
  const info = await stat(absolute).catch(() => null)
  if (!info?.isFile()) return Response.json({ error: "not a file" }, { status: 404 })
  if (info.size > MAX_FILE_BYTES) return Response.json({ path, content: null, size: info.size })
  return Response.json({ path, content: await readFile(absolute, "utf8"), size: info.size })
}
