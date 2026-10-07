CREATE TABLE IF NOT EXISTS furin_sync_mutations (
  namespace TEXT NOT NULL,
  mutation_key TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in-progress', 'succeeded')),
  response_status INTEGER,
  response_headers TEXT,
  response_body BLOB,
  lease_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  CONSTRAINT furin_sync_mutations_succeeded_response_check CHECK (
    state <> 'succeeded'
    OR (
      response_status IS NOT NULL
      AND response_headers IS NOT NULL
      AND response_body IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  PRIMARY KEY (namespace, mutation_key),
  UNIQUE (mutation_id)
);

CREATE TRIGGER IF NOT EXISTS furin_sync_mutations_succeeded_response_insert
  BEFORE INSERT ON furin_sync_mutations
  WHEN NEW.state = 'succeeded'
    AND (
      NEW.response_status IS NULL
      OR NEW.response_headers IS NULL
      OR NEW.response_body IS NULL
      OR NEW.completed_at IS NULL
    )
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: furin_sync_mutations_succeeded_response_check');
END;

CREATE TRIGGER IF NOT EXISTS furin_sync_mutations_succeeded_response_update
  BEFORE UPDATE ON furin_sync_mutations
  WHEN NEW.state = 'succeeded'
    AND (
      NEW.response_status IS NULL
      OR NEW.response_headers IS NULL
      OR NEW.response_body IS NULL
      OR NEW.completed_at IS NULL
    )
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: furin_sync_mutations_succeeded_response_check');
END;

CREATE TABLE IF NOT EXISTS furin_sync_streams (
  namespace TEXT PRIMARY KEY,
  current_cursor INTEGER NOT NULL DEFAULT 0,
  oldest_cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS furin_sync_changes (
  namespace TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  invalidations TEXT NOT NULL,
  principal_hash TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, cursor)
);

CREATE INDEX IF NOT EXISTS furin_sync_mutations_expiry_idx
  ON furin_sync_mutations (expires_at);

DROP INDEX IF EXISTS furin_sync_changes_created_idx;
