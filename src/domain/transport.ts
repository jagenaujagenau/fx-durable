/**
 * Which durable model call a request belongs to. fx-durable passes it as a
 * third argument to model requests, so a transport can route the response
 * (for example, stream text deltas to the agent's live viewers).
 */
export interface TransportContext {
  readonly agentId: string
  readonly submissionId: string
  readonly turnId: string
  /** The `model` task journaling this request. */
  readonly taskId: string
  readonly model: string
}

/**
 * The HTTP transport libfx uses for model requests (the shape of `fetch`).
 * Model requests made during a turn also receive a `TransportContext`.
 */
export type Transport = (input: RequestInfo | URL, init?: RequestInit, context?: TransportContext) => Promise<Response>
