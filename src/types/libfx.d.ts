// Ambient declarations for the parts of libfx 0.0.12 fx-durable uses.
// libfx ships without TypeScript declarations; these describe its documented
// contract and the behavior observed against it.
declare module "libfx" {
  import type { Schema } from "effect"

  type Json = Schema.Json
  type JsonObject = Schema.JsonObject
  type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  export interface FxTool {
    readonly name: string
    readonly description: string
    readonly inputSchema: JsonObject
    /** Receives the model's JSON arguments; object results reach the model as JSON text. */
    readonly execute: (input: Json, context: { readonly signal: AbortSignal }) => Promise<Json>
  }

  export interface CreateFxAgentOptions {
    apiKey: string
    model?: string
    backend?: "auto" | "native" | "wasm"
    fetch?: Transport
    instructions?: string
    tools?: ReadonlyArray<FxTool>
    checkpoint?: Uint8Array
  }

  export type FxTurnEvent =
    | { readonly type: "text_delta"; readonly delta: string }
    | { readonly type: "reasoning_delta"; readonly delta: string }
    | { readonly type: "tool_start"; readonly id: string; readonly name: string; readonly input?: Json }
    | { readonly type: "tool_end"; readonly id: string; readonly name: string; readonly isError?: boolean }
    | { readonly type: "user_message"; readonly text: string }

  export interface FxTurnResult {
    readonly stopReason: string
    /** Absent fields happen in practice (e.g. `usage: {}` for a refused request). */
    readonly usage?: {
      readonly inputTokens?: number
      readonly outputTokens?: number
      readonly reasoningTokens?: number
    }
  }

  export interface FxTurn extends AsyncIterable<FxTurnEvent> {
    readonly result: Promise<FxTurnResult>
    cancel(): void
  }

  export interface FxAgent {
    prompt(input: string | ReadonlyArray<{ readonly type: "text"; readonly text: string }>, options?: { readonly signal?: AbortSignal }): FxTurn
    checkpoint(): Promise<Uint8Array>
    close(): Promise<void>
  }

  export function createFxAgent(options: CreateFxAgentOptions): Promise<FxAgent>
}

declare module "libfx/mcp" {
  import type { Schema } from "effect"
  import type { FxTool } from "libfx"

  /** A Zod-style result schema, as the MCP SDK accepts for `callTool`. */
  export interface McpResultSchema {
    parse(input: never): object
  }

  /** The MCP TypeScript SDK v1 client surface libfx calls. */
  export interface McpClient {
    callTool(
      params: { readonly name: string; readonly arguments?: Schema.JsonObject },
      resultSchema?: McpResultSchema,
      options?: { readonly signal?: AbortSignal }
    ): Promise<object>
    listTools(params?: { readonly cursor?: string }): Promise<object>
  }

  export interface McpAdapterOptions {
    prefix?: string
    resources?: ReadonlyArray<string>
    prompts?: ReadonlyArray<string>
  }

  export interface McpAdapter {
    readonly tools: ReadonlyArray<FxTool>
    readonly instructions?: string
    close(): Promise<void>
  }

  export function createMcpAdapter(client: McpClient, options?: McpAdapterOptions): Promise<McpAdapter>
}
