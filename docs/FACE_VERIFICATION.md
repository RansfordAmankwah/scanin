# Face verification (pilot)

An **optional** layer on top of the anti-proxy controls (`docs/ANTI_PROXY.md`) for the hardest case —
one person with several phones, signed in to several accounts. After a QR check-in, the student does a
quick face check that confirms it is them. A check that cannot confirm them does **not** change their
attendance; it puts them on the lecturer's in-person spot-check list, and the lecturer decides, in
person, as they always have.

It is **off by default**, per course, and nothing about a non-pilot course changes.

## What it never does

- **It never creates, changes, invalidates or restores attendance.** The QR check-in path, its unique
  constraint, and its recorded time are untouched. A face check is a review signal only.
- **It never stores a raw image or frame** — not in the database, on disk, in logs, in audit events,
  or in error messages. Frames are held in memory for one verifier call and discarded. The only thing
  stored is an **encrypted reference** to a vendor template (AES-256-GCM, key outside the database).
- **It never shows a lecturer the face sub-reason.** A face exception appears to the lecturer only as
  "an in-person check is required"; the sub-reason (failed, not live, exempt, expired) and all consent
  are the student's own data.

## Consent and enrollment (phase 1)

- **Consent** is the student's, global to them (one template per person, usable in any flag-enabled
  course they attend), recorded against a privacy-notice version. Append-only history; the student can
  withdraw at any time.
- **Enrollment is supervised.** A lecturer in a pilot course, having checked the student's ID in
  person, opens a short-lived enrollment session (`FACE_ENROLLMENT_SESSION_TTL_SECONDS`). The student
  completes the capture on their own device. It requires an active consent at the current notice
  version. One active enrollment per student.
- **Withdrawal** deletes the template at the vendor and is marked confirmed **only after the vendor
  confirms it**. A failed deletion stays `PENDING` and is retried; it is never reported as done.

## The check pipeline (phase 2)

After a check-in in a pilot course, the response carries `attendanceId` and `faceCheck: { required }`.
The client asks for a **challenge**, bound server-side to the **attendance id**, the **device claim**
that checked in, and the **QR token id** used. The challenge is single-use and expires after
`FACE_CHALLENGE_TTL_SECONDS`.

The student uploads a capture for that challenge, from the same device. The outcome:

| Outcome             | Meaning                                 | Effect                                   |
| ------------------- | --------------------------------------- | ---------------------------------------- |
| `VERIFIED`          | live, and matched the enrolled template | nothing further                          |
| `FAILED`            | live, but did not match                 | forced onto the in-person list           |
| `LIVENESS_REJECTED` | not a live capture                      | forced onto the in-person list           |
| `EXEMPT`            | no active consent or enrollment         | forced onto the in-person list           |
| `EXPIRED`           | challenge not completed in time         | forced onto the in-person list           |
| `UNAVAILABLE`       | the verifier was down                   | **falls back to normal random sampling** |

A match needs `FACE_MATCH_THRESHOLD` and a live capture. A student gets `FACE_MAX_ATTEMPTS` attempts;
after that they are left for an in-person decision. Reuse of a challenge, a capture from a different
device, and a wrong session are each refused with a specific error and a `SECURITY` audit event where
it suggests abuse. The liveness label and match score live in a separate table purged after
`FACE_DETAIL_RETENTION_DAYS`; the outcome is kept with the attendance.

## Spot-check integration (phase 3)

- Every student with a face exception (`FAILED`, `LIVENESS_REJECTED`, `EXEMPT`, `EXPIRED`) is **always
  included** in a spot-check round, on top of the requested random sample, as selection reason
  `FACE_EXCEPTION`. The lecturer sees it only as **`IN_PERSON_REQUIRED`** — never the sub-reason.
- An `UNAVAILABLE` outage is **not** forced; the student is sampled at the normal random rate, so a
  vendor outage degrades gracefully to the pre-pilot behaviour.
- Each round also includes at least `SPOT_CHECK_FACE_VERIFIED_MIN` randomly chosen face-verified
  students, so who gets checked does not reveal who failed.
- Outcomes, disputes, replies and resolution are exactly as before.
- **Pilot metrics** — `GET /courses/:courseId/face-metrics`, for the course's lecturers: totals only
  (attempted, verified, failed, liveness-rejected, unavailable, exempt, forced-list size, median
  scan-to-verified time, NOT_PRESENT among face-verified). No names, no per-student sub-reasons.

## The student's privacy page

Shows the student their consent and notice version, their enrollment date, a withdraw action, their
own face checks and outcomes (in plain terms), the times they were asked to verify in person, and a
download of all their face-related data (which contains no image or template).

## The verifier boundary

All biometric computation is behind `FaceVerifier` (`enroll` / `verify` / `deleteTemplate`); no face
computation happens in the browser, which only captures frames. `FACE_VERIFIER` selects the
implementation: `fake` (deterministic, for development and tests) or `production` (a stub that throws
`NOT_CONFIGURED` until a real vendor is integrated). The web capture is behind an interface so a native
or attested capture can replace it later.

## Database and configuration

Migrations: `0009_face_verification.sql` (flag, consent, enrollment, sessions), `0010_face_checks.sql`
(challenges, append-only check events, detail), `0011_face_spot_check.sql` (the `FACE_EXCEPTION`
reason; a round may select more than requested). Retention purges per course, deletes detail by age,
and clears expired challenges. The operator alone turns the per-course flag on.

Environment variables (all optional; the per-course flag is off by default):
`FACE_VERIFIER`, `FACE_TEMPLATE_KEY`, `FACE_ENROLLMENT_SESSION_TTL_SECONDS`, `FACE_NOTICE_VERSION`,
`FACE_CHALLENGE_TTL_SECONDS`, `FACE_MATCH_THRESHOLD`, `FACE_MAX_ATTEMPTS`, `FACE_DETAIL_RETENTION_DAYS`,
`SPOT_CHECK_FACE_VERIFIED_MIN`. See `.env.example`.

## What this does NOT do (read before presenting it)

- **A live remote relay within the QR lifetime still works.** The QR window is short (~30s including
  the previous-code grace), but a code relayed and scanned inside it, by someone the face check then
  clears, is not caught here.
- **Camera injection on a web client.** A determined attacker can feed synthetic frames to a browser;
  this is why no real vendor is wired in and why the capture sits behind an interface for a future
  native or attested client. The pilot's fake verifier is for development and tests only.
- **Students without face verification rely on in-person checks.** Anyone not enrolled is `EXEMPT` and
  is simply put on the in-person list — no better and no worse than before the pilot.
- It is a review signal, like every other anti-proxy control: it raises the cost and the chance of
  being noticed. It does not prove who is holding a phone.

## Open institutional decisions

- **Which verifier vendor**, and the `FACE_MATCH_THRESHOLD` and liveness policy for it.
- **A data-protection reporting view.** There is no data-protection-supervisor role. Proposed: a
  read-only reporting query (consent, withdrawal and deletion counts) run by the operator, rather than
  a new authorization role. Not yet built; awaiting a decision.
- Retention of consent and enrollment records (currently: consent events persist; the template is
  deleted on withdrawal; check detail is 90 days; the outcome follows the attendance window).
- A notification channel so a student learns promptly that they must verify in person.

## Commands

```sh
pnpm build
node apps/api/dist/db/setup.js                      # applies migrations 0009-0011 and the grants
pnpm --filter @scanin/api exec vitest run test/face
pnpm --filter @scanin/web exec vitest run test/privacy.test.tsx test/facecheck.test.tsx test/facephase3.test.tsx
pnpm e2e                                            # includes tests/41-face-pilot.spec.ts (fake verifier)
```
