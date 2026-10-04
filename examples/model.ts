import { scriptedModel, type Script } from "fx-durable/testing"

/**
 * Use the real AI Gateway when AI_GATEWAY_API_KEY is set; otherwise a
 * scripted model so every example runs offline.
 */
export const modelTransport = (script: Script) =>
  process.env.AI_GATEWAY_API_KEY ? {} : { fetch: scriptedModel(script, { latencyMs: 300 }) }

export const MODEL = process.env.FXD_MODEL ?? "anthropic/claude-sonnet-4.5"
