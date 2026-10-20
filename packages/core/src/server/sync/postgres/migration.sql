CREATE SCHEMA IF NOT EXISTS furin_sync;

CREATE TABLE IF NOT EXISTS furin_sync.mutations (
  namespace text NOT NULL,
  mutation_key text NOT NULL,
  mutation_id uuid NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('in-progress', 'succeeded')),
  response_status integer,
  response_headers jsonb,
  response_body bytea,
  lease_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'furin_sync_mutations_succeeded_response_check'
      AND conrelid = 'furin_sync.mutations'::regclass
  ) THEN
    ALTER TABLE furin_sync.mutations
      ADD CONSTRAINT furin_sync_mutations_succeeded_response_check CHECK (
        state <> 'succeeded'
        OR (
          response_status IS NOT NULL
          AND response_headers IS NOT NULL
          AND response_body IS NOT NULL
          AND completed_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS furin_sync.streams (
  namespace text PRIMARY KEY,
  current_cursor bigint NOT NULL DEFAULT 0,
  oldest_cursor bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS furin_sync.changes (
  namespace text NOT NULL,
  cursor bigint NOT NULL,
  invalidations jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, cursor)
);

CREATE INDEX IF NOT EXISTS furin_sync_mutations_expiry_idx
  ON furin_sync.mutations (expires_at);

ALTER TABLE furin_sync.changes ADD COLUMN IF NOT EXISTS principal_hash text;
