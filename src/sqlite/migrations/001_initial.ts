/**
 * Initial schema. Transactional semantics and unique constraints here are
 * correctness requirements; later migrations may extend but never weaken them.
 */
export const migration001 = {
  version: 1,
  name: "initial",
  sql: /* sql */ `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  model TEXT NOT NULL,
  cwd TEXT,
  state TEXT NOT NULL,
  state_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  request_id TEXT,
  content BLOB NOT NULL,
  state TEXT NOT NULL,
  result BLOB,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent_id, request_id)
);
CREATE INDEX submissions_agent_state ON submissions(agent_id, state, created_at);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  executor_id TEXT,
  base_checkpoint_seq INTEGER,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX turns_agent_state ON turns(agent_id, state);
-- One active turn per agent (v1). Enforced by the database, not just memory.
CREATE UNIQUE INDEX turns_one_active_per_agent ON turns(agent_id) WHERE state IN ('running', 'interrupted');

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_task_id TEXT,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  name TEXT,
  input BLOB,
  input_hash TEXT,
  output BLOB,
  error TEXT,
  replay_policy TEXT,
  idempotency_key TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  metadata BLOB,
  started_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX tasks_turn ON tasks(turn_id, started_at);
CREATE INDEX tasks_state ON tasks(state);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  sequence INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  model TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, sequence)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  submission_id TEXT,
  turn_id TEXT,
  task_id TEXT,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload BLOB,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, sequence)
);
CREATE INDEX events_submission ON events(submission_id, sequence);

-- Process liveness, used to decide whether a running turn's owner is gone.
CREATE TABLE executors (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  stopped_at INTEGER
);
`
} as const
