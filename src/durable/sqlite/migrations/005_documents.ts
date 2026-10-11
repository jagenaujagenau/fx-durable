/**
 * Typed documents: application state stored with the journal and written in
 * its transactions. `owner` is the agent id, or '' for a global document.
 * Rewindable documents keep every value in `document_revisions`.
 */
export const migration005 = {
  version: 5,
  name: "documents",
  sql: /* sql */ `
CREATE TABLE documents (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  value BLOB NOT NULL,
  history TEXT NOT NULL,
  fork TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, kind)
);

CREATE TABLE document_revisions (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  version INTEGER NOT NULL,
  value BLOB NOT NULL,
  history TEXT NOT NULL,
  fork TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, kind, revision)
);
`
} as const
