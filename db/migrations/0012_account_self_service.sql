-- Account self-service: forgot-password reset, change-email, and self-requested deletion.
--
-- Principles:
--   * Password reset reuses the existing account_tokens table with purpose 'PASSWORD_RESET'
--     (the enum value already exists from 0001); no new table is needed.
--   * Changing an e-mail is now allowed for the application role, but it resets email_verified_at
--     so the new address must be re-verified before it counts as verified.
--   * Deletion is a request, not an immediate erase. The account is disabled at once and marked
--     with deletion_requested_at; the retention role performs the irreversible ordered-cascade
--     erase after a grace period. This keeps the "the app never DELETEs" guarantee intact.

-- When the account owner asked for deletion. NULL means no pending request. The account is also set
-- to status = 'DISABLED' at the same time, so it is locked out immediately during the grace period.
ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;

-- Retention scans for due deletions by this column; keep that scan cheap.
CREATE INDEX users_deletion_requested_idx
  ON users (deletion_requested_at) WHERE deletion_requested_at IS NOT NULL;
