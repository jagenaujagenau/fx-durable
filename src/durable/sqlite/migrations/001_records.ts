/**
 * fx-durable's records around libfx sessions: agents (and the session each
 * is in), the requests made to them, the tool-call journal keyed by libfx's
 * `executionId`, and documents. libfx stores the conversations themselves.
 */
export const migration001 = {
  version: 1,
  name: "records",
  sql: /* sql */ `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  model TEXT NOT NULL,
  cwd TEXT,
  session_id TEXT,
  session_store TEXT,
  summary TEXT,
  start_checkpoint BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE submissions (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  id TEXT NOT NULL,
  request_id TEXT,
  session_id TEXT NOT NULL,
  session_store TEXT NOT NULL,
  model TEXT NOT NULL,
  content BLOB NOT NULL,
  state TEXT NOT NULL,
  result BLOB,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, id)
);
CREATE INDEX submissions_running ON submissions(state) WHERE state = 'running';
CREATE INDEX submissions_agent_created ON submissions(agent_id, created_at);

CREATE TABLE tool_calls (
  session_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  call_key TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  submission_id TEXT,
  name TEXT NOT NULL,
  input BLOB,
  replay_policy TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL,
  output BLOB,
  error TEXT,
  attempts INTEGER NOT NULL,
  progress TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (session_id, execution_id, call_key)
);
CREATE INDEX tool_calls_running ON tool_calls(state) WHERE state = 'running';

CREATE TABLE documents (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  value BLOB NOT NULL,
  fork TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, kind)
);
`
} as const
