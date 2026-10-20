# ScanIn

A campus attendance tracker with QR check-in. A lecturer starts a class session and shows a QR code that refreshes every 30 seconds. Students sign in on their phones and scan it. The database and backend are the source of truth.

Live at **[scanin.dev](https://scanin.dev)**. The public landing site is at `/`; the app is entered at `/sign-in`.

- Two roles only: **lecturer** and **student**. There is no admin dashboard. Lecturers sign up themselves and create their own terms and courses; an operator CLI covers exceptions such as adding a second lecturer to a course.
- **Self-service accounts**: sign-up with e-mail verification, forgot-password reset, change e-mail, resend verification, and account deletion (disabled at once, then hard-erased by the retention role after a grace period). All e-mail goes through Resend.
- One effective attendance record per student per session, enforced by the database, and one device per student per class (`docs/DEVICE_BINDING.md`).
- Anti-proxy controls: a room headcount compared with attendance, randomised in-person spot checks, and a review process for the student, all as review signals rather than penalties (`docs/ANTI_PROXY.md`).
- Identity uncertainty is explicit: matches to the class list are _provisional_, _needs review_, _confirmed_ or _rejected_, and a lecturer decides. A student who is simply not on the list is shown quietly with one-tap **add to class** / **remove**, so a roster can also build up organically from whoever the lecturer confirms.
- An **optional face-verification pilot**, off by default and enabled per course. It is a review signal only: it never changes an attendance record, stores no raw images (only an encrypted template reference), and needs the student's explicit consent (`docs/FACE_VERIFICATION.md`).
- No precise location, and nothing is written to official university systems.
- Course-based attendance history for lecturers and students (`docs/COURSE_ATTENDANCE.md`), including a course-wide **attendance grid** (students x sessions, Present/Absent) with CSV download.
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

## Public site and the app

The API serves both a small public, indexable marketing site and the authenticated single-page app from the same origin (so cookies, CSRF and CORS stay trivial). The split lives in `apps/api/src/security/web.ts`:

| Path                          | What it serves                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                           | Static landing page. A visitor with a session cookie is 302'd to `/sign-in`; sent `Cache-Control: private, no-store` so a CDN never shares one visitor's redirect with another. Cookie presence is routing, not authorisation. |
| `/how-it-works`, `/privacy`   | Static public pages at clean URLs, cached and indexable. `/privacy` is a short general site notice — **not** the face-verification pilot notice, which stays separate.                                                         |
| `/robots.txt`, `/sitemap.xml` | Real files with correct content types, served ahead of the SPA fallback. robots.txt does **not** disallow app routes, so a crawler can fetch them and see their `noindex` header.                                              |
| everything else               | The SPA shell (sign-in when signed out, the dashboard when signed in), sent with `X-Robots-Tag: noindex`. Entered at `/sign-in`; QR and `/present` links are unchanged.                                                        |

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

## Operator CLI

Lecturers create their own terms and courses in the app. The operator CLI is for exceptions (assigning another lecturer to a course, ending an assignment, shared terms, retention and audit tools):

```sh
pnpm --filter @scanin/api operator --help
```

Commands: `create-term`, `create-course`, `create-lecturer` (prints a temporary password once), `assign-lecturer`, `end-assignment`, `grant-comp` / `revoke-comp` (billing exemption), `release-student-id` (free a student ID stuck on the wrong account), `retention-run`, `audit-checkpoint`, `audit-verify`. It needs `OPERATOR_DATABASE_URL`.

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

Milestones M0 to M13 are built and verified, and the app is **deployed live at [scanin.dev](https://scanin.dev)** (Render, with Neon PostgreSQL and Resend for e-mail). The face-verification pilot ships off by default.

## Roadmap

Recently built:

- **Self-service account management**: forgot-password reset, change e-mail, account deletion (hard-erased by the retention role after a grace period), and a resend-verification link, all e-mailed via Resend. A show/hide toggle on password fields.
- **Softer, organic roster review**: an unmatched student is shown quietly as "not on the class list" with one-tap add / remove, and a course roster can build up from whoever the lecturer confirms rather than requiring an upfront import.
- **Course attendance matrix**: one grid per course (`NAME | ID | <session title> | …`), every student who attended any session listed alphabetically, each cell Present/Absent, exportable to CSV, Excel and PDF.
- **Lecturer billing**: GH₵25 / month per lecturer via Paystack (Mobile Money + card), pay-to-extend. A 14-day free trial that starts the first time a lecturer runs a session; students never pay, and a verified e-mail is required. Running a session is gated; reading, creating courses and rostering stay free. Operator comps (`grant-comp`) exempt test/free accounts. Billing is off entirely when no Paystack key is set.
- **In-app light/dark/system theme toggle** in the app header (choice remembered per browser).
- **Operator tools**: `release-student-id` frees a student ID stuck on the wrong account (typo, duplicate, or misused), and `grant-comp` / `revoke-comp` manage billing exemptions.
