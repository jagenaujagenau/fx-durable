/**
 * Tools calling tools. A nested call is a tool task whose `caller_task_id` is
 * the tool task that made it, under `call_key` among that caller's calls.
 * (`parent_task_id` keeps its meaning: the task this one replays or retries.)
 */
export const migration003 = {
  version: 3,
  name: "nested_calls",
  sql: /* sql */ `
ALTER TABLE tasks ADD COLUMN caller_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN call_key TEXT;
CREATE INDEX tasks_caller ON tasks(caller_task_id) WHERE caller_task_id IS NOT NULL;
`
} as const
