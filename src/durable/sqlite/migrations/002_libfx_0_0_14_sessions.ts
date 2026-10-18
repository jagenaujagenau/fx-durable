/**
 * fx-durable 0.3 ran on a libfx dev build whose session stores libfx 0.0.14
 * deletes on open (their storage layout changed). Every agent starts a new
 * session on its next request; an agent waiting to start one from a
 * checkpoint (a fork, or a change of tools) keeps it, since 0.0.14 reads those
 * checkpoints. Requests left running cannot continue, so they fail, and their
 * running tool calls get an unknown outcome.
 */
export const migration002 = {
  version: 2,
  name: "libfx-0.0.14-sessions",
  sql: /* sql */ `
UPDATE agents
SET session_id = NULL, session_store = NULL
WHERE session_id IS NOT NULL;

UPDATE tool_calls
SET state = 'outcome_unknown',
    error = 'outcome unknown: libfx 0.0.14 cannot continue sessions from fx-durable 0.3',
    completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE state = 'running';

UPDATE submissions
SET state = 'failed',
    error = 'libfx 0.0.14 cannot continue sessions from fx-durable 0.3; send the request again'
WHERE state = 'running';
`
} as const
