# Anti-proxy attendance controls

A "proxy" is a student recorded present who is not in the room, usually because a classmate scanned the code for them. The hardest version: **one person with several phones, signed in to several accounts.**

ScanIn cannot prove which human holds a phone, and none of its controls claim to. What it does is make proxy attendance **harder, easier to notice, and accountable**, and it keeps every decision about a student with a person.

| Layer          | What it does                                                                                                                      | Stops or notices                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Prevention** | Rotating signed QR codes; one record per student per class; **one device, one student per class** (`docs/DEVICE_BINDING.md`)      | Scanning from a screenshot; one phone signed in to many accounts     |
| **Detection**  | **Room headcount** compared with recorded attendance; **randomised spot checks** with an in-person verification                   | Many phones, many accounts: the case prevention cannot see           |
| **Fairness**   | Everything above is a review signal. A **dispute** is opened, the student may reply, and a lecturer decides with a written reason | Wrongly accusing a student who was late, stepped out, or had a fault |
| **Evidence**   | Append-only audit trail and history tables; no endpoint edits or deletes history                                                  | Silent changes after the fact                                        |

## What the original code already did (kept unchanged)

Reviewed before any change. All still hold, and all have tests:

- The student is the signed-in account; no ID in a request body is trusted.
- One attendance record per student per session, enforced by a database unique constraint and `ON CONFLICT DO NOTHING`; concurrent requests collapse to one.
- QR codes are signed, expire after 3 minutes, can be cancelled by the lecturer, and are checked on the server together with the session state.
- Per-student and per-address rate limits on check-in; per-account and per-address limits on sign-in.
- CSRF protection, role checks on every route (the server refuses to start with an undeclared route), course-scoped lecturer access.
- Attendance corrections append a revision with the actor and a written reason; nothing is overwritten.

## Weaknesses found and fixed

1. **Device rule could be skipped** by a client that left the device id out (a stale cached app, or a hand-made request). A check-in without a device id is now refused (`400 DEVICE_ID_REQUIRED`) and audited. _(Earlier in this work.)_
2. **Unexpected errors leaked internals.** Fastify's default error handler returned the raw error, which for a database failure included the Postgres error code and message. One central handler now returns a fixed message and a request id; the detail goes to the server log only.
3. **Several phones, several accounts** was undetectable. This is what the new controls address, with the limits stated below.
4. The authorization matrix test could only send `GET` and `POST`; it now sends every method, so new `PUT` routes are covered by the automatic 401/403/404 checks.

## 1. Room headcount reconciliation

The lecturer counts the people physically in the room and enters the number. The server compares it with **students recorded present** (confirmed + provisional + needs-review; invalidated records are not counted).

```
allowed = max(HEADCOUNT_TOLERANCE_MIN, ceil(headcount × HEADCOUNT_TOLERANCE_PERCENT / 100))
difference = recorded − headcount
```

| Status                     | When                              | Meaning                                                                       |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `NO_HEADCOUNT`             | none recorded                     | Warns the lecturer, once students have checked in                             |
| `CONSISTENT`               | `-allowed ≤ difference ≤ allowed` | Normal                                                                        |
| `REVIEW_RECOMMENDED`       | `difference > allowed`            | More students recorded than people counted: **look closer**                   |
| `MORE_PEOPLE_THAN_RECORDS` | `difference < -allowed`           | Informational only (someone has not scanned yet); never treated as suspicious |

- Computed **from live data on every read**, so it follows every check-in, correction and headcount change with no recalculation step.
- **Stale**: shown when the headcount is at least `HEADCOUNT_STALE_MINUTES` old and students have been recorded since.
- A correction creates a new revision (previous value, new value, actor, time, optional reason); re-sending the same number changes nothing and logs nothing.
- The lecturer can add a written note to a flagged difference (e.g. "six arrived late").
- **Nothing here changes any attendance record.** No rejection, no invalidation, no penalty.

Settings (environment variables, in `.env.example`): `HEADCOUNT_TOLERANCE_PERCENT` (15), `HEADCOUNT_TOLERANCE_MIN` (3), `HEADCOUNT_MAX` (2000), `HEADCOUNT_STALE_MINUTES` (30).

## 2. Randomised spot checks

The lecturer asks for a sample of `SPOT_CHECK_DEFAULT_SIZE` (5; at most `SPOT_CHECK_MAX_SIZE`, 20) students and checks **in person** that each is really in the room.

**Who can be picked:** students recorded present (not invalidated) **by QR scan** in this session, and not already picked in this session. Students the lecturer marked present by hand are not sampled: the lecturer has already vouched for them. A request larger than the eligible pool selects everyone eligible. Selecting never creates, changes or duplicates attendance.

**How:** weighted random sampling without replacement, from the operating system's secure random source. Everyone starts with weight 1, then:

| Adjustment                                                                                                                                              | Weight        | Evidence used                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------- |
| `DEVICE_SHARED_FLAG`: the system flagged this check-in because the device had already been used for another student in the class (`DEVICE_POLICY=FLAG`) | × 2           | A recorded system flag on this attendance |
| `PRIOR_NOT_PRESENT_RESULT`: an earlier spot check in this course found the student not present, and the lecturer did not later uphold that record       | × 2           | An earlier recorded check result          |
| Both                                                                                                                                                    | × 4 (the cap) |                                           |
| Picked in one of the last `SPOT_CHECK_HISTORY_SESSIONS` (2) sessions of this course                                                                     | × 0.3         | Never excluded, only less likely          |

**Deliberately not used:** shared IP addresses, shared Wi-Fi, a changed phone, location. They are normal in a lecture hall and are not evidence. A raised chance is only a chance to be asked to show ID; it never changes anyone's attendance, flags anyone, or opens a dispute by itself. Each pick stores its **reason and factors**, and the audit event records the rationale by item and reason (never by name).

**Outcomes** (recorded by an assigned lecturer; each carries the checker, time, and a request id so a retry is safe):

| Outcome            | Requires                                                    | Effect                                                                      |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `VERIFIED`         | how: `STUDENT_ID_CARD`, `ROSTER_PHOTO`, `OTHER_OFFICIAL_ID` | Recorded. Attendance untouched, no duplicate                                |
| `NOT_PRESENT`      | an explanation (≥ 10 characters)                            | **Opens a dispute.** Attendance untouched; the original check-in time stays |
| `COULD_NOT_VERIFY` | nothing                                                     | Stays **unresolved**; can be settled later                                  |

### Spot-check state transitions

```
PENDING ──► VERIFIED ───────► NOT_PRESENT     (correction: explanation required)
   │            ▲                   │
   │            └───────────────────┘          (correction: explanation required; upholds the open dispute)
   ├──► NOT_PRESENT
   └──► COULD_NOT_VERIFY ──► VERIFIED | NOT_PRESENT
```

Anything else is refused with `409 INVALID_TRANSITION`, by the server **and** by a `CHECK` constraint in the database. The same request id repeated returns the original result; the same id with a different outcome is `409 REQUEST_ID_REUSED`.

> Official roster **photos are not in ScanIn's data**, so the workflow does not depend on them. The checker records which method was used. For stronger verification the institution would need to supply photos (see "Institutional decisions").

## 3. Disputes (review and appeal)

Opened when a spot check records `NOT_PRESENT` on a record that is still present. It is **separate from the attendance status**.

```
OPEN ──resolve: keep────────► RESOLVED_UPHELD
OPEN ──resolve: invalidate──► RESOLVED_INVALIDATED     (resolved is final; mistakes are fixed by restoring the attendance)
```

- While open, the student **keeps their attendance**. The original check-in record and time are never altered or deleted.
- The student sees only "Your lecturer is reviewing this record" and can send up to 5 replies (≤ 1000 characters). They are never shown the spot check, flags, other students or lecturer notes.
- A lecturer resolves it with a **written reason** (≥ 10 characters). "Invalidate" needs a reason category and goes through the normal audited invalidation **in the same transaction** as closing the dispute; if either part fails, neither is applied.
- If a spot check is later corrected from `NOT_PRESENT` to `VERIFIED`, its open dispute is upheld automatically, with the correction's reason.
- **Notification:** ScanIn has no student notification channel besides the in-app screen, so a student learns of a review the next time they open the app. E-mail or SMS notification is a missing dependency, not built.

## API

All lecturer routes need a signed-in **lecturer assigned to the course**; other lecturers and unknown ids get an identical `404`. Students get `403`; signed-out callers `401`. Writes need the same-origin headers. Errors are `{ "error": { "code", "message" } }`.

| Method & path (under `/courses/:courseId/sessions/:sessionId`) | Body                                                                   | Notes                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET  /reconciliation`                                         |                                                                        | Headcount, history, recorded total, difference, status, tolerance, stale, notes, limits                           |
| `PUT  /headcount`                                              | `{ headcount: int, explanation?: ≤1000 }`                              | `400 INVALID_HEADCOUNT`, `409 SESSION_NOT_STARTED`; `unchanged: true` if same value                               |
| `POST /reconciliation/notes`                                   | `{ note: 10..2000 }`                                                   | `409 NO_HEADCOUNT`                                                                                                |
| `GET  /spot-checks`                                            |                                                                        | Rounds, items (student, reason, factors, state, history), summary, limits                                         |
| `POST /spot-checks`                                            | `{ size?: int, requestId?: uuid }`                                     | `400 INVALID_SAMPLE_SIZE`, `409 NO_ELIGIBLE_STUDENTS`, `409 SESSION_NOT_STARTED`; repeat `requestId` = same round |
| `POST /spot-checks/items/:itemId/result`                       | `{ requestId: uuid, outcome, method?, explanation? }`                  | `400 METHOD_REQUIRED / EXPLANATION_REQUIRED`, `409 INVALID_TRANSITION / REQUEST_ID_REUSED`                        |
| `GET  /disputes`                                               |                                                                        | Disputes with events (including student replies)                                                                  |
| `POST /disputes/:disputeId/resolve`                            | `{ resolution: UPHOLD\|INVALIDATE, category?, explanation: 10..2000 }` | `400 CATEGORY_REQUIRED`, `409 INVALID_TRANSITION`                                                                 |
| `POST /me/disputes/:disputeId/response` (student)              | `{ note: 1..1000 }`                                                    | `404` for anyone else's dispute, `409 TOO_MANY_RESPONSES`                                                         |

`GET /attendance` (roster) now also returns each record's `verification` and `disputeState`; `GET /me/attendance` returns a student's own `review` (state, times, replies left) and nothing else. Write routes are rate-limited per lecturer or student.

## Database (migration `0007_anti_proxy_controls.sql`)

New tables: `session_headcounts`, `reconciliation_notes`, `spot_checks`, `spot_check_items`, `spot_check_events`, `attendance_disputes`, `attendance_dispute_events`.

- History tables (`session_headcounts`, `reconciliation_notes`, `spot_check_events`, `attendance_dispute_events`) are **append-only for the application**: `INSERT`/`SELECT` only. `spot_check_items` and `attendance_disputes` may only change their current state columns, and a **deferred foreign key forces that state to equal their latest event**.
- `CHECK` constraints enforce the legal transitions, the explanations, the method rules, one sample per student per session, and one open dispute per attendance.
- The operator role has no access to any of them. There is **no administrative override**; a correction is always a new, attributed event.
- Retention: with the course (term end + 1 year), purged in dependency order. The audit events follow the same window. Not reversible by design; to undo, restore a database backup.

Audit actions (all `DOMAIN`, with actor and retention date, none containing credentials, tokens or device ids): `HEADCOUNT_RECORDED`, `HEADCOUNT_CORRECTED`, `RECONCILIATION_FLAGGED`, `RECONCILIATION_CLEARED`, `RECONCILIATION_NOTE_ADDED`, `SPOT_CHECK_GENERATED`, `SPOT_CHECK_RESULT_RECORDED`, `DISPUTE_OPENED`, `DISPUTE_STUDENT_RESPONDED`, `DISPUTE_RESOLVED`, `ATTENDANCE_INVALIDATED`, `ATTENDANCE_RESTORED`; and in `SECURITY`: `CHECKIN_DEVICE_REUSED`, `CHECKIN_DEVICE_ID_MISSING`.

## What this does NOT do (read this before presenting it)

- **It cannot prove who is holding a phone.** It raises the cost and the chance of being noticed.
- **Someone with several phones can still record several students.** Nothing at the door sees it, because each scan looks legitimate. Only the headcount and the spot check can notice, and both depend on a lecturer actually doing them.
- **Small amounts of proxying stay inside the tolerance.** With 8 honest students plus the attacker and 2 absent accounts, the headcount reads "agree" (tolerance 3). A tighter tolerance would flag late arrivals and miscounts. It is a setting, and a policy choice.
- **A spot check is a sample.** If 2 of 7 recorded students are proxies and the checker looks at one, they miss about 71% of the time. Larger samples, more sessions and the raised chance for repeat signals help; none guarantees detection.
- **A lecturer's headcount is approximate** and is only as honest as the lecturer.
- **Students can still collude on sessions where they are not sampled.**
- **Device binding** is easy to evade by clearing browser data or using another browser, and the id can be copied. It is a speed bump.
- **A failed spot check is not misconduct.** The student could have stepped out. ScanIn never penalises automatically; what follows is a decision for a person, under institutional policy.

## Institutional decisions still open

1. **Who may verify.** Only lecturers assigned to the course can. Teaching assistants have no account type.
2. **Approved verification methods** and whether official roster photos can be supplied.
3. **Tolerance and sample size** for pilot courses.
4. **Consequences and appeals.** What a confirmed proxy leads to, and the formal appeal route beyond the in-app reply.
5. **Notice to students.** A privacy notice that spot checks and headcounts happen, and what is kept.
6. **Retention** of verification records (currently term end + 1 year, same as attendance).
7. **A notification channel** (e-mail or SMS) so students learn of a review promptly.

## Privacy

Reuses existing identity data (student ID and name from the account). Stores **no biometrics, no photos, no precise location**. Verification outcomes, the method used and the checker's explanation are personal data about the student, visible only to lecturers assigned to that course and to the student's own review notice. Device claims keep only a keyed hash and are purged after 90 days.

## Demonstration for the Head of Department (about 10 minutes)

**Set up first.** A course with a started session, the QR on the projector. Six phones or browser profiles (a normal window and a private window each count as a different device), three "honest" student accounts, and four more accounts the demonstrator will use as proxies.

1. **The cheap attack fails.** One phone, sign in as student A and scan, sign out, sign in as student B on the same phone and scan. B sees "Device error"; A's record is untouched. _Say:_ one phone cannot do it.
2. **The real attack.** The demonstrator signs in to the four proxy accounts on four different phones and scans each. Three honest students scan. _Say:_ every scan looks legitimate. Nothing at the door can tell. This is the case the new controls are for.
3. **Count the room.** Seven people are present (three students, the demonstrator, and so on); the lecturer enters the count. The panel shows **"Review recommended"** with the difference, and says plainly that this is a prompt and not proof. _Show:_ every student is still present; nothing was rejected.
4. **Spot check.** Ask for a sample larger than the number really present. _Show:_ the random picks and the reason shown for each. The checker "walks the room": real students show ID, **Verified in person**; the proxy accounts cannot be found, **Not found in the room** with a written reason.
5. **Fairness.** _Show:_ the "Records under review" panel. The proxy students are still present while under review. On a phone, sign in as one of them: they see only "Your lecturer is reviewing this record", and can reply.
6. **The decision.** The lecturer reads the reply and invalidates with a category and a written reason. _Show:_ the headcount comparison improves on its own, and the audit trail has every step by name and time.
7. **Be honest about what it misses.** Repeat with only two proxies: the headcount says "agree" (inside the tolerance). Say that a sample of one can miss, and that a lecturer who does not count or check catches nothing. Then list the open decisions above.

An automated version of steps 2–7 runs in `apps/api/test/antiproxy/scenario.test.ts`, including the cases it cannot catch.

## Commands

```sh
pnpm build
node apps/api/dist/db/setup.js                      # applies migration 0007 and the grants (Render does this during the build)
pnpm --filter @scanin/api exec vitest run test/antiproxy
pnpm --filter @scanin/web exec vitest run test/antiproxy.test.tsx
pnpm e2e                                            # real-browser suite, includes tests/40-anti-proxy.spec.ts
```
