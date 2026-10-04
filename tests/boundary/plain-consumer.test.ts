/**
 * fx-durable from an application that does not use Effect: nothing here
 * imports `effect`. Tools are validated with Zod, a hand-written Standard
 * Schema validator, or a plain JSON Schema.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  DurableFx,
  SubmissionError,
  defineDurableTool,
  sqlite,
  type StandardSchemaV1
} from "../../src/index.js"
import { scriptedModel, type Script } from "../../src/testing/index.js"
import { tempDb } from "../helpers.js"

describe("using fx-durable without Effect", () => {
  it("validates tool input with Zod and derives the model's JSON Schema from it", async () => {
    const seen: Array<{ city: string; days: number }> = []
    const forecast = defineDurableTool({
      name: "forecast",
      replay: "safe",
      inputSchema: z.object({ city: z.string(), days: z.number().int().min(1).max(7) }),
      execute: (input) => {
        seen.push(input)
        return { city: input.city, outlook: "sunny" }
      }
    })
    expect(forecast.jsonSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city", "days"]
    })

    const script: Script = (req) => {
      if (req.step === 0) return { toolCalls: [{ name: "forecast", input: { city: "Lima", days: 30 } }] }
      if (req.step === 1) return { toolCalls: [{ name: "forecast", input: { city: "Lima", days: 3 } }] }
      return { text: req.toolResults.map((r) => `${r.isError ? "error" : "ok"}: ${r.output}`).join("\n") }
    }
    const fx = await DurableFx.open({
      storage: sqlite(tempDb()),
      runtimes: { weather: { tools: [forecast] } },
      fetch: scriptedModel(script),
      crash: "off"
    })
    const agent = await fx.agent("forecaster", { runtime: "weather", model: "test/model" })
    const result = await (await agent.submit("Weather in Lima?")).result()
    const [invalid, valid] = result.text.split("\n")
    expect(invalid).toMatch(/^error: invalid input for forecast: days: /)
    expect(valid).toBe('ok: {"city":"Lima","outlook":"sunny"}')
    expect(seen).toEqual([{ city: "Lima", days: 3 }])
    await fx.close()
  })

  it("accepts any Standard Schema validator; without a JSON Schema converter, jsonSchema is required", () => {
    const positive: StandardSchemaV1<{ n: number }> = {
      "~standard": {
        version: 1,
        vendor: "hand-written",
        validate: (value) => {
          const n = new Map(Object.entries(value instanceof Object ? value : {})).get("n")
          return Number.isFinite(n) && Number(n) > 0 ? { value: { n: Number(n) } } : { issues: [{ message: "n must be positive", path: ["n"] }] }
        }
      }
    }
    expect(() =>
      defineDurableTool({ name: "double", replay: "safe", inputSchema: positive, execute: ({ n }) => n * 2 })
    ).toThrow(/pass `jsonSchema`/)
    const double = defineDurableTool({
      name: "double",
      replay: "safe",
      inputSchema: positive,
      jsonSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      execute: ({ n }) => n * 2
    })
    expect(double.jsonSchema.required).toEqual(["n"])
  })

  it("plain JSON Schema tools receive the model's JSON input", async () => {
    const echo = defineDurableTool({
      name: "echo",
      replay: "safe",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      execute: (input) => input
    })
    const fx = await DurableFx.open({
      storage: sqlite(tempDb()),
      runtimes: { chat: { tools: [echo] } },
      fetch: scriptedModel((req) =>
        req.toolResults.length ? { text: req.toolResults[0]!.output } : { toolCalls: [{ name: "echo", input: { text: "hi" } }] }
      ),
      crash: "off"
    })
    const agent = await fx.agent("echo", { runtime: "chat", model: "test/model" })
    expect((await (await agent.submit("say hi")).result()).text).toBe('{"text":"hi"}')
    await fx.close()
  })

  it("failures are plain Error instances with a _tag", async () => {
    const fx = await DurableFx.open({
      storage: sqlite(tempDb()),
      runtimes: { chat: {} },
      fetch: async () => {
        throw new TypeError("network down")
      },
      crash: "off"
    })
    const agent = await fx.agent("a", { runtime: "chat", model: "test/model" })
    const error = await (await agent.submit("hi")).result().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(SubmissionError)
    expect(error).toMatchObject({ _tag: "SubmissionError", state: "failed" })
    await fx.close()
  })

  it("an instance not created by DurableFx.open() is not open", async () => {
    await expect(new DurableFx().listAgents()).rejects.toThrow(/not open/)
  })

  it("the published types of the main entry expose no Effect runtime types", () => {
    const out = mkdtempSync(join(tmpdir(), "fxd-dts-"))
    const root = resolve(import.meta.dirname, "../..")
    const tsc = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", root, "--emitDeclarationOnly", "--outDir", out], {
      encoding: "utf8"
    })
    expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0)
    const facade = readFileSync(join(out, "core/durable-fx.d.ts"), "utf8")
    const publicPart = facade.slice(facade.indexOf("export interface DurableFxOptions"), facade.indexOf("/** Effect-native overrides"))
      + facade.slice(facade.indexOf("export declare class DurableFx"))
    expect(publicPart).not.toMatch(/\b(Effect|Layer|Stream|ManagedRuntime|Context)\./)
    const index = readFileSync(join(out, "index.d.ts"), "utf8")
    expect(index).not.toMatch(/durableFxLayer|openDurableFx|DurableFxLayers/)
    const sqliteConfig = readFileSync(join(out, "sqlite/storage.d.ts"), "utf8")
    expect(sqliteConfig.slice(sqliteConfig.indexOf("export interface SqliteStorageConfig"))).not.toMatch(/Layer/)
  })
})

