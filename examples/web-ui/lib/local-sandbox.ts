import { spawn as spawnProcess } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { Readable } from "node:stream"
import type { Experimental_SandboxProcess as SandboxProcess, Experimental_SandboxSession as SandboxSession } from "@ai-sdk/provider-utils"

/**
 * A "sandbox" that is just a directory on this machine. HarnessAgent needs a
 * SandboxSession to create a per-session working directory; fx-durable runs
 * its tools in-process, so a host directory is enough for a local example.
 * Not an isolation boundary.
 */
export const localSandbox = (root: string): SandboxSession => {
  const at = (path: string) => resolve(root, path)

  const spawn = async (options: {
    command: string
    workingDirectory?: string
    env?: Record<string, string>
    abortSignal?: AbortSignal
  }): Promise<SandboxProcess> => {
    await mkdir(root, { recursive: true })
    const child = spawnProcess("sh", ["-c", options.command], {
      cwd: options.workingDirectory ? at(options.workingDirectory) : root,
      env: { ...process.env, HOME: root, ...options.env },
      signal: options.abortSignal
    })
    const exited = new Promise<{ exitCode: number }>((done, fail) => {
      child.once("error", fail)
      child.once("close", (code) => done({ exitCode: code ?? 1 }))
    })
    return {
      pid: child.pid,
      // SAFETY: the child's stdio streams carry raw bytes (no encoding set), so the web streams yield Uint8Array chunks.
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      // SAFETY: as above.
      stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill: async () => {
        child.kill()
      }
    }
  }

  const readBinaryFile = async ({ path }: { path: string }) => {
    try {
      return new Uint8Array(await readFile(at(path)))
    } catch {
      return null
    }
  }

  const writeBinaryFile = async ({ path, content }: { path: string; content: Uint8Array }) => {
    await mkdir(dirname(at(path)), { recursive: true })
    await writeFile(at(path), content)
  }

  return {
    description: `A local directory on the host machine: ${root}`,
    spawn,
    run: async (options) => {
      const child = await spawn(options)
      const [stdout, stderr, { exitCode }] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.wait()
      ])
      return { exitCode, stdout, stderr }
    },
    readFile: async (options) => {
      const bytes = await readBinaryFile(options)
      return bytes === null ? null : new Response(bytes).body!
    },
    readBinaryFile,
    readTextFile: async ({ path, startLine, endLine }) => {
      const bytes = await readBinaryFile({ path })
      if (bytes === null) return null
      const text = new TextDecoder().decode(bytes)
      if (startLine === undefined && endLine === undefined) return text
      return text
        .split("\n")
        .slice((startLine ?? 1) - 1, endLine)
        .join("\n")
    },
    writeFile: async ({ path, content }) => writeBinaryFile({ path, content: new Uint8Array(await new Response(content).arrayBuffer()) }),
    writeBinaryFile,
    writeTextFile: ({ path, content }) => writeBinaryFile({ path, content: new TextEncoder().encode(content) })
  }
}
