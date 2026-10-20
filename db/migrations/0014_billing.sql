-- Lecturer billing (pilot): a lecturer pays GH₵25 to run sessions. Students never pay.
--
-- Model: pay-to-extend, not card auto-renew (Mobile Money, the common method here, does not do
-- reliable automatic recurring). Each successful payment adds a month to current_period_end.
--
-- Access to run a session = billing_exempt  OR  still inside the 14-day trial (from the lecturer's
-- e-mail verification)  OR  an unexpired subscription period (plus a short grace). The arithmetic
-- lives in the application; this schema just stores the facts.

-- A comp: full access with no trial clock and no payment. Operator-set only (the app role cannot
-- change it), so a lecturer can never exempt themselves. Used for the team's own test accounts and
-- any deliberate free access (a pilot department, a demo).
ALTER TABLE users ADD COLUMN billing_exempt boolean NOT NULL DEFAULT false;

-- One current subscription period per lecturer. current_period_end moves forward as they pay.
CREATE TABLE subscriptions (
  lecturer_id           uuid PRIMARY KEY REFERENCES users (id),
  current_period_end    timestamptz NOT NULL,
  paystack_customer_code text,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Every settled payment, append-only. The Paystack reference is unique so a webhook that is
-- delivered more than once extends the period exactly once.
CREATE TABLE subscription_payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lecturer_id        uuid NOT NULL REFERENCES users (id),
  paystack_reference text NOT NULL UNIQUE,
  amount_minor       integer NOT NULL CHECK (amount_minor > 0),
  currency           text NOT NULL,
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  paid_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT subscription_payments_period CHECK (period_end > period_start)
);
CREATE INDEX subscription_payments_lecturer_idx ON subscription_payments (lecturer_id, paid_at);
