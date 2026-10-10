-- Trigram matching, used ONLY to suggest roster candidates to a lecturer. Similarity never links or
-- confirms anything on its own.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX roster_entries_active_name_trgm_idx
  ON roster_entries USING gin (lower(full_name) gin_trgm_ops)
  WHERE retired_at IS NULL;
