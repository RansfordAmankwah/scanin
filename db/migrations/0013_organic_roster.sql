-- Organic roster building: a lecturer can add a student to the class list directly, so a roster can
-- grow from whoever the lecturer confirms rather than requiring an upfront CSV import.
--
-- A lecturer-added entry has no import. Everything else about roster_entries is unchanged: the
-- active-ID and active-email unique indexes still prevent duplicates, and roster_links still points
-- at entries through the same composite foreign key.

ALTER TABLE roster_entries ALTER COLUMN import_id DROP NOT NULL;

-- A retired entry can still be superseded; an imported entry still carries its import. The only
-- change is that import_id may now be NULL, meaning "added directly by a lecturer, not imported".
COMMENT ON COLUMN roster_entries.import_id IS
  'The import this entry came from, or NULL when a lecturer added the student to the class list directly.';
