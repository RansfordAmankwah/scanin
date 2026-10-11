# ScanIn pilot runbook

## Lecturer

1. **Account.** On the sign-in screen choose **Create a lecturer account** and enter your name, e-mail and a password of at least 10 characters.
2. **Sign in**, then **Create a course**: a code, a title, and a term (pick one from the list or choose **New term…** and give its name and dates). You are assigned to the course automatically and see only courses you created or were assigned. Class data is deleted one year after the term's end date, so enter the real end date.
3. **Import the class list.** Open the course, paste or upload a CSV with the header `student_id,full_name,email` (e-mail optional), choose **Preview changes**, check the counts, then **Apply changes**. Nothing changes until you apply.
4. **Create a session.** Type a title, **Create session**, open it, then **Start check-in (30 minutes)**. Use **Extend** (with a reason) if needed.
5. **Project the QR.** Choose **Show QR code for the room** and put that page on the projector. It refreshes itself about every 30 seconds. If a code was shared outside the room, press **Invalidate shown codes**.
6. **Watch and review.** The session page shows live counts. Resolve anything under "Needs review". You can mark a student present, invalidate or restore a record (a written reason is required), and export CSV, Excel, PDF or Word.
7. **End the session** when class finishes.

## Student

1. Create an account once (student ID, name, school e-mail, password). Check the details carefully: ID and name cannot be changed later.
2. Sign in, tap **Start camera**, allow camera access, and point it at the projected code. You see **You're checked in**.
3. No camera? Scan the code with the phone's normal camera app and open the link, or ask the lecturer to mark you present.
4. "That code has expired" means scan the code on screen right now.

## Operator: backup

Take a dump before each deploy and weekly during the pilot. Use the owner **direct** Neon URL:

```sh
pg_dump "$MIGRATOR_DATABASE_URL" --format=custom --no-owner --file "scanin-$(date +%F).dump"
```

Store the file somewhere access-controlled. It contains student names, IDs and attendance. Neon's point-in-time history is the first line of recovery; the dump is the independent copy.

## Operator: recovery

1. **Stop traffic.** Suspend the Render service.
2. **Restore into a new database.** Either use Neon's restore/branch to a time before the problem, or load a dump into a new, empty database:
   ```sh
   pg_restore --no-owner --dbname "<new owner direct url>" scanin-YYYY-MM-DD.dump
   ```
3. **Reinstall roles and grants** against the restored database (a dump made with `--no-owner` carries none): run `node apps/api/dist/db/setup.js` with `MIGRATOR_DATABASE_URL` pointing at it. If the three roles do not exist there yet, add `--create-roles` with the passwords.
4. **Repoint** `DATABASE_URL`, `MIGRATOR_DATABASE_URL` and `RETENTION_DATABASE_URL` in Render, then resume the service. Check `/healthz`, sign in as a lecturer and open a recent session.
5. **Tell lecturers** what time the data is restored to. Check-ins after that point must be re-recorded (manual mark) or re-scanned.
6. Run a restore like this into a scratch database **before the pilot starts**, so the first time is not during an incident.

## Operator: routine

- **Rotate QR keys:** add `k2:...` to `QR_KEYS`, set `QR_ACTIVE_KID=k2`, redeploy, and remove `k1` at least 4 minutes later.
- **Retention:** runs daily when `RETENTION_DATABASE_URL` is set. Check the logs for "retention run complete".
- **Operator provisioning is now optional.** Lecturers create their own terms and courses. The operator CLI is still there to add a second lecturer to a course (`assign-lecturer`), to end an assignment, or to create a shared term. An account can be assigned a course without a verified e-mail, so confirm someone's identity before assigning them to a course you did not see them create.
- **Student ID released after a mistake:** no command exists yet. Escalate to the developer.
- **Password reset:** not built yet. Escalate to the developer.
