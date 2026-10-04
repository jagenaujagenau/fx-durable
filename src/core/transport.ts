/** The HTTP transport libfx uses for model requests (the shape of `fetch`). */
export type Transport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
