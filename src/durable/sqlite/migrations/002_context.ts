/**
 * Context resets and compaction. A checkpoint can carry a context summary,
 * and a submission has a kind: a request for the model (`input`), or a
 * context operation (`reset`, `compaction`) queued like one.
 */
export const migration002 = {
  version: 2,
  name: "context",
  sql: /* sql */ `
ALTER TABLE checkpoints ADD COLUMN summary TEXT;
ALTER TABLE submissions ADD COLUMN kind TEXT NOT NULL DEFAULT 'input';
`
} as const
