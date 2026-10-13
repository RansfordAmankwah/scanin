# One device, one student per class

## What is enforced

| Rule                                                                      | Where                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The student is the signed-in account, never a value in the request        | `POST /checkins` reads `req.auth.userId`; the body cannot name anyone                                        |
| At most one attendance record per student per class session               | `UNIQUE (session_id, student_id)` plus `ON CONFLICT DO NOTHING`                                              |
| A repeat check-in by the same student is "already checked in", not a copy | Returns `200 ALREADY_RECORDED`                                                                               |
| Every check-in must carry a device id                                     | Missing id: `400 DEVICE_ID_REQUIRED`, nothing recorded, audit event                                          |
| A second student on the same device in the same session                   | `DEVICE_POLICY=BLOCK` (default): `403 DEVICE_ALREADY_USED`, audited                                          |
|                                                                           | `DEVICE_POLICY=FLAG`: recorded, and a system proxy-suspected flag is raised on every record from that device |
| The same device in a different class session                              | Allowed                                                                                                      |
| A different device                                                        | Allowed                                                                                                      |
| A rejected attempt (expired code, closed class) does not claim the device | Only an accepted check-in writes the device claim                                                            |
| Two students racing on one device                                         | A per-(session, device) advisory lock; exactly one gets in                                                   |

The device id is a random UUID the browser keeps in `localStorage`. The server stores only a keyed hash of it (never the raw id), in `device_sessions` and `attendance_records.device_hash`. Errors say only that "this device was already used by another student"; they never name the other student. The audit event holds a count of other students, not their identities.

## Why a client-kept id rather than a server cookie

A server-issued, HttpOnly cookie would also survive an out-of-date cached app and could not be read by a script. It does not change the main limit below: whoever clears their cookies gets a fresh one. The mandatory-id rule closes the same stale-client gap, so the simpler client id was kept.

## Limits (this is a speed bump, not proof of who is holding the phone)

- **Clearing browser data, a private window, or a different browser** gives a new device id. Someone willing to do that can check in a second account from the same phone.
- **The id can be copied** to another browser or script by anyone who can read it. A person with developer tools can do this.
- **A student carrying two phones** (one per account) is not detected by this at all. It needs a different control: a lecturer watching the room, scan-time spread and IP clustering in the scan history, or in-person verification. This is the main remaining gap.
- **A borrowed phone**: in `BLOCK` mode a student who legitimately borrows a classmate's phone is stopped, and the lecturer has to mark them present by hand. `FLAG` mode avoids that, at the cost of recording both and leaving the decision to the lecturer.
- It is not biometric or identity verification, and does not claim to be.

## Operating it

- Set `DEVICE_POLICY` in Render (`BLOCK` by default).
- A phone that still holds an old cached copy of the app sees "Reload ScanIn to finish checking in" until it reloads.
- Device claims are scan metadata: they are deleted with the course, and after 90 days.
