/**
 * Finding abandoned calls: an interrupted task is abandoned unless a later
 * task retries it (`parent_task_id` points at it), so look that up by index.
 */
export const migration004 = {
  version: 4,
  name: "abandoned_calls",
  sql: /* sql */ `
CREATE INDEX tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
`
} as const
