# ScanIn

A campus attendance tracker with QR check-in. A lecturer starts a class session and shows a QR code that refreshes every 30 seconds. Students sign in on their phones and scan it. The database and backend are the source of truth.

- Two roles only: **lecturer** and **student**. There is no admin dashboard; an operator CLI handles provisioning.
- One effective attendance record per student per session, enforced by the database.
- Identity uncertainty is explicit: matches to the class list are _provisional_, _needs review_, _confirmed_ or _rejected_, and a lecturer decides.
- No biometrics, no precise location, and nothing is written to official university systems.
- Exports to CSV, Excel, PDF and Word.
- Retention purge and an optional tamper-evident audit checkpoint.

## Layout

| Path              | What it is                                                    |
| ----------------- | ------------------------------------------------------------- |
| `apps/api`        | Fastify 5 API (TypeScript, Node 22, PostgreSQL via `pg`, zod) |
| `apps/web`        | React 19 + Vite PWA, served by the API in production          |
| `packages/shared` | Types and constants shared by both                            |
| `db`              | Plain SQL migrations and the least-privilege `grants.sql`     |
| `e2e`             | Playwright real-browser tests against the production build    |

## Requirements

- Node 22 or newer
- pnpm 10
- PostgreSQL 16 or newer (developed against 18)

## Getting started

```sh
pnpm install
cp .env.example .env        # then fill in the values; see the comments in the file
```

You need a local PostgreSQL with a role that has `CREATEDB` and `CREATEROLE`. Put its connection strings in `.env` (`DATABASE_URL` and `TEST_DATABASE_ADMIN_URL`). URL-encode special characters in passwords.

Prepare a database (applies migrations and installs the least-privilege roles and grants):

```sh
pnpm build
MIGRATOR_DATABASE_URL=postgres://owner:pw@localhost:5432/scanin_dev \
DB_APP_PASSWORD=... DB_RETENTION_PASSWORD=... DB_OPERATOR_PASSWORD=... \
  node apps/api/dist/db/setup.js --create-roles
```

Run it:

```sh
pnpm --filter @scanin/api dev     # API on API_PORT
pnpm --filter @scanin/web dev     # web app on :5173
```

## Provisioning (operator CLI)

Lecturers, terms, courses and assignments are created by an operator, not through the app:

```sh
pnpm --filter @scanin/api operator --help
```

Commands: `create-term`, `create-course`, `create-lecturer` (prints a temporary password once), `assign-lecturer`, `end-assignment`, `retention-run`, `audit-checkpoint`, `audit-verify`. It needs `OPERATOR_DATABASE_URL`.

## Scripts

| Command                               | Does                                                                 |
| ------------------------------------- | -------------------------------------------------------------------- |
| `pnpm check`                          | format check, lint, typecheck, all unit and integration tests, build |
| `pnpm test`                           | unit and integration tests (real PostgreSQL, throwaway databases)    |
| `pnpm e2e`                            | builds, then runs the real-browser tests (Edge locally)              |
| `pnpm --filter @scanin/api test:load` | load tests (500 students over 20 s, End under load, dashboard reads) |
| `pnpm format`                         | format everything with Prettier                                      |

The e2e tests use Microsoft Edge by default. In CI, or if you prefer Chromium: `PLAYWRIGHT_CHANNEL=chromium` after `pnpm --filter @scanin/e2e exec playwright install chromium`.

## How it is kept safe

- **The database enforces the rules**: constraints, composite foreign keys and a trigger on session state. The app role can insert and select history but cannot rewrite it, and cannot create lecturer accounts.
- **Three database roles**: `app` (runtime), `retention` (purge only), `operator` (provisioning only).
- **Sessions**: Argon2id passwords, opaque server-side sessions in a `__Host-` cookie.
- **CSRF**: Origin check, `X-Requested-With` header and `Sec-Fetch-Site`.
- **Every route declares who may call it**; startup fails otherwise.
- **QR codes** are short-lived HMAC-signed tokens (3 minutes, refreshed every 30 s) with key rotation. The lecturer can cancel codes already on screen.
- **Headers**: strict CSP, HSTS in production, camera permission limited to the app.
- **Rate limits** are stored in PostgreSQL, so they hold across several API instances.

## Configuration

All settings are environment variables, documented in `.env.example`. The important ones:

| Variable                   | Purpose                                                 |
| -------------------------- | ------------------------------------------------------- |
| `DATABASE_URL`             | runtime connection, as the `app` role                   |
| `APP_ORIGIN`               | exact public origin (CSRF checks, links in e-mails)     |
| `IP_HASH_SECRET`           | secret for hashing IP addresses (32+ random characters) |
| `QR_KEYS`, `QR_ACTIVE_KID` | QR signing keyring and the key currently used to sign   |
| `WEB_DIST_DIR`             | built web app to serve from the API                     |
| `EXPORT_DIR`               | private storage for generated exports                   |
| `RETENTION_DATABASE_URL`   | enables the scheduled retention job                     |
| `TRUST_PROXY`              | set `true` only behind a trusted reverse proxy          |

## Status

Milestones M0 to M12 are built and verified. Remaining before a pilot: container image, deployment guide, operator runbook and a restore drill (M13).

Not built yet, by design or pending decision: password reset, an operator command to release a student ID, a production e-mail provider, and a hosting choice.
