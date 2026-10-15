import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outcomeOf, summarise, type ViewRow } from '../../src/attendance/history.js';
import { createHarness, type Harness } from '../antiproxy/harness.js';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const history = async (s: BulkStudent, course: string) =>
  (await h.get(`/me/courses/${course}`, s.cookie)).json();
const courseList = async (s: BulkStudent) => (await h.get('/me/courses', s.cookie)).json();
const end = (course: string, session: string, who = h.lecturer) =>
  h.post(`/courses/${course}/sessions/${session}/end`, {}, who.cookie);
const linkOf = async (course: string, s: BulkStudent) =>
  (
    await h.db.pool.query('SELECT id FROM roster_links WHERE course_id = $1 AND student_id = $2', [
      course,
      s.id,
    ])
  ).rows[0]!.id as string;
const decide = (course: string, link: string, decision: string, basis?: string) =>
  h.post(`/courses/${course}/links/${link}/decision`, {
    decision,
    ...(basis ? { basis } : {}),
    explanation: 'Checked against the class register in person.',
  });
const confirm = (course: string, link: string) =>
  decide(course, link, 'CONFIRM', 'LECTURER_IDENTITY_CONFIRMED');
const invalidate = (course: string, session: string, attendanceId: string) =>
  h.post(`/courses/${course}/sessions/${session}/attendance/${attendanceId}/invalidate`, {
    category: 'INCORRECT_ENTRY',
    explanation: 'Entered under the wrong account.',
  });
const attendanceIdOf = async (session: string, s: BulkStudent) =>
  (
    await h.db.pool.query(
      'SELECT id FROM attendance_records WHERE session_id = $1 AND student_id = $2',
      [session, s.id],
    )
  ).rows[0]!.id as string;

/** A course with one of every kind of session, for one student. */
async function fiveSessions(course: string) {
  const [s] = await createBulkStudents(h.db, 1);
  const s0 = await h.openSession(course); // ended before the student is known to the course
  await end(course, s0);
  const s1 = await h.openSession(course);
  expect((await h.scan(s!, s1)).statusCode).toBe(201); // first check-in: the association begins here
  await end(course, s1);
  const s2 = await h.openSession(course); // started and finished with no record for the student
  await end(course, s2);
  const s3 = await h.openSession(course); // still open for check-in
  const s4 = await h.openSession(course);
  expect((await h.scan(s!, s4)).statusCode).toBe(201);
  await invalidate(course, s4, await attendanceIdOf(s4, s!));
  await end(course, s4);
  return { s: s!, s0, s1, s2, s3, s4 };
}

describe('the counting rule (pure arithmetic)', () => {
  const row = (over: Partial<ViewRow>): ViewRow => ({
    link_state: 'CONFIRMED',
    closed: true,
    counted: true,
    attendance_id: null,
    bucket: null,
    ...over,
  });

  it('names each situation without merging them', () => {
    expect(outcomeOf(row({ attendance_id: 'a', bucket: 'CONFIRMED' }))).toBe('CONFIRMED');
    expect(outcomeOf(row({ attendance_id: 'a', bucket: 'PROVISIONAL' }))).toBe('PROVISIONAL');
    expect(outcomeOf(row({ attendance_id: 'a', bucket: 'REVIEW_REQUIRED' }))).toBe(
      'AWAITING_CONFIRMATION',
    );
    expect(outcomeOf(row({ attendance_id: 'a', bucket: 'INVALIDATED' }))).toBe('INVALIDATED');
    expect(outcomeOf(row({}))).toBe('NO_RECORD');
    expect(outcomeOf(row({ closed: false, counted: false }))).toBe('IN_PROGRESS');
    expect(outcomeOf(row({ counted: false }))).toBe('NOT_COUNTED');
  });

  it('shows a percentage only for confirmed students, over eligible sessions only, to one decimal', () => {
    const rows = [
      row({ attendance_id: 'a', bucket: 'CONFIRMED' }),
      row({}),
      row({ attendance_id: 'b', bucket: 'INVALIDATED' }),
      row({ closed: false, counted: false }), // in progress: not in the denominator
      row({ counted: false }), // before the student belonged: not in the denominator
    ];
    const s = summarise(rows, 'CONFIRMED');
    expect(s).toMatchObject({
      sessionsStarted: 5,
      eligibleSessions: 3,
      inProgress: 1,
      notCounted: 1,
      percent: 33.3,
      percentReason: 'OK',
    });
    expect(s.tally).toEqual({
      confirmed: 1,
      provisional: 0,
      awaitingConfirmation: 0,
      invalidated: 1,
      noRecord: 1,
    });
    const { confirmed, provisional, awaitingConfirmation, invalidated, noRecord } = s.tally;
    expect(confirmed + provisional + awaitingConfirmation + invalidated + noRecord).toBe(
      s.eligibleSessions,
    );
  });

  it('never promotes provisional or unresolved attendance into a confirmed percentage', () => {
    const provisional = [
      row({ link_state: 'PROVISIONAL', attendance_id: 'a', bucket: 'PROVISIONAL' }),
    ];
    expect(summarise(provisional, 'PROVISIONAL')).toMatchObject({
      percent: null,
      percentReason: 'NOT_CONFIRMED',
      tally: { provisional: 1, confirmed: 0 },
    });
    const review = [row({ attendance_id: 'a', bucket: 'REVIEW_REQUIRED' })];
    expect(summarise(review, 'REVIEW_REQUIRED')).toMatchObject({
      percent: null,
      percentReason: 'NOT_CONFIRMED',
      tally: { awaitingConfirmation: 1 },
    });
    expect(summarise(review, 'REJECTED')).toMatchObject({
      percent: null,
      percentReason: 'NOT_MATCHED',
    });
  });

  it('says so when there is nothing to divide by, rather than showing 0% or 100%', () => {
    expect(summarise([], 'CONFIRMED')).toMatchObject({
      percent: null,
      percentReason: 'NO_ELIGIBLE_SESSIONS',
      eligibleSessions: 0,
    });
    expect(summarise([row({ closed: false, counted: false })], 'CONFIRMED')).toMatchObject({
      percent: null,
      percentReason: 'NO_ELIGIBLE_SESSIONS',
      inProgress: 1,
    });
  });
});

describe('what each session is, for a student', () => {
  it('distinguishes counted, not counted, in progress, no record and invalidated sessions', async () => {
    const course = await h.newCourse();
    const { s, s0, s1, s2, s3, s4 } = await fiveSessions(course);
    const result = await history(s, course);
    const outcome = (id: string) => result.sessions.find((x: { id: string }) => x.id === id);
    expect(outcome(s0)).toMatchObject({ outcome: 'NOT_COUNTED', counted: false, phase: 'CLOSED' });
    expect(outcome(s1)).toMatchObject({ outcome: 'PROVISIONAL', counted: true });
    expect(outcome(s2)).toMatchObject({ outcome: 'NO_RECORD', counted: true });
    expect(outcome(s3)).toMatchObject({
      outcome: 'IN_PROGRESS',
      counted: false,
      phase: 'IN_PROGRESS',
    });
    expect(outcome(s4)).toMatchObject({
      outcome: 'INVALIDATED',
      counted: true,
      invalidationCategory: 'INCORRECT_ENTRY',
    });
    expect(result.sessions).toHaveLength(5); // newest first, nothing missing, nothing from elsewhere
  });

  it('keeps provisional attendance provisional: no percentage until the lecturer confirms', async () => {
    const course = await h.newCourse();
    const { s } = await fiveSessions(course);
    const before = await history(s, course);
    expect(before.association.state).toBe('PROVISIONAL');
    expect(before.summary).toMatchObject({
      eligibleSessions: 3,
      percent: null,
      percentReason: 'NOT_CONFIRMED',
      tally: { confirmed: 0, provisional: 1, invalidated: 1, noRecord: 1 },
    });
  });

  it('shows a confirmed percentage over eligible sessions once the student is confirmed', async () => {
    const course = await h.newCourse();
    const { s, s1 } = await fiveSessions(course);
    expect((await confirm(course, await linkOf(course, s))).statusCode).toBe(200);
    const after = await history(s, course);
    expect(after.association.state).toBe('CONFIRMED');
    expect(after.summary).toMatchObject({
      sessionsStarted: 5,
      eligibleSessions: 3,
      inProgress: 1,
      notCounted: 1,
      percent: 33.3,
      percentReason: 'OK',
      tally: { confirmed: 1, provisional: 0, awaitingConfirmation: 0, invalidated: 1, noRecord: 1 },
    });
    expect(after.sessions.find((x: { id: string }) => x.id === s1).outcome).toBe('CONFIRMED');
  });

  it('keeps unresolved and rejected associations out of any percentage', async () => {
    const course = await h.newCourse();
    const { s } = await fiveSessions(course);
    const link = await linkOf(course, s);
    expect((await decide(course, link, 'MARK_REVIEW_REQUIRED')).statusCode).toBe(200);
    expect((await history(s, course)).summary).toMatchObject({
      percent: null,
      percentReason: 'NOT_CONFIRMED',
      tally: { awaitingConfirmation: 1 },
    });
    expect((await decide(course, link, 'REJECT')).statusCode).toBe(200);
    const rejected = await history(s, course);
    expect(rejected.summary).toMatchObject({ percent: null, percentReason: 'NOT_MATCHED' });
    expect(rejected.sessions.length).toBeGreaterThan(0); // their records are still shown, never hidden
  });

  it('does not count a session that is still open, for anyone, until it closes', async () => {
    const course = await h.newCourse();
    const [s] = await createBulkStudents(h.db, 1);
    const open = await h.openSession(course);
    await h.scan(s!, open);
    const midway = await history(s!, course);
    expect(midway.summary).toMatchObject({
      eligibleSessions: 0,
      inProgress: 1,
      percentReason: 'NO_ELIGIBLE_SESSIONS',
    });
    await end(course, open);
    expect((await history(s!, course)).summary).toMatchObject({
      eligibleSessions: 1,
      inProgress: 0,
      tally: { provisional: 1 },
    });
  });

  it('does not penalise a student who joined late for the sessions before they belonged', async () => {
    const course = await h.newCourse();
    const early = await h.openSession(course);
    await end(course, early);
    const [late] = await createBulkStudents(h.db, 1);
    const now = await h.openSession(course);
    await h.scan(late!, now);
    await end(course, now);
    const result = await history(late!, course);
    expect(result.sessions.find((x: { id: string }) => x.id === early).outcome).toBe('NOT_COUNTED');
    expect(result.summary.eligibleSessions).toBe(1);
    expect(result.countedFrom).toBeTruthy(); // the screen can say from when sessions are counted
  });

  it('shows a record under review without changing what it counts as, and never mentions flags', async () => {
    const course = await h.newCourse();
    const { s, s1 } = await fiveSessions(course);
    await confirm(course, await linkOf(course, s));
    const link = await linkOf(course, s);
    const flag = await h.post(`/courses/${course}/flags`, {
      kind: 'PROXY_SUSPECTED',
      attendanceId: await attendanceIdOf(s1, s),
      note: 'Seen scanning for a friend at the back.',
    });
    expect(flag.statusCode).toBe(201);
    const student = await history(s, course);
    expect(student.sessions.find((x: { id: string }) => x.id === s1).outcome).toBe('CONFIRMED'); // not invalidated, not hidden
    expect(JSON.stringify(student).toLowerCase()).not.toContain('flag');
    // The lecturer, by contrast, sees it.
    const lecturerView = (await h.get(`/courses/${course}/students/${link}/attendance`)).json();
    expect(lecturerView.sessions.find((x: { id: string }) => x.id === s1)).toMatchObject({
      flagged: true,
      outcome: 'CONFIRMED',
    });
  });
});

describe('class lists decide when a student started to belong', () => {
  const importList = async (course: string, rows: string[]) => {
    const csv = `student_id,full_name\n${rows.join('\n')}\n`;
    const preview = await h.post(`/courses/${course}/roster/preview`, { csv });
    expect(preview.statusCode).toBe(200);
    const applied = await h.post(`/courses/${course}/roster/apply`, {
      csv,
      previewToken: preview.json().previewToken,
      retireEntryIds: [],
    });
    expect(applied.statusCode).toBe(200);
  };

  it('counts sessions only from when the student was on the class list, and stops when they are removed', async () => {
    const course = await h.newCourse();
    const [s] = await createBulkStudents(h.db, 1);
    const before = await h.openSession(course);
    await end(course, before); // before any class list existed
    await importList(course, [`${s!.studentId},Listed Student`]);
    const during = await h.openSession(course);
    await h.scan(s!, during);
    await end(course, during);
    const after = await h.openSession(course);
    await end(course, after);

    // On the class list (confirmed by ID match): sessions since the list was imported are counted.
    let result = await history(s!, course);
    expect(result.association.state).toBe('CONFIRMED');
    const find = (id: string) => result.sessions.find((x: { id: string }) => x.id === id);
    expect(find(before)).toMatchObject({ outcome: 'NOT_COUNTED' });
    expect(find(during)).toMatchObject({ outcome: 'CONFIRMED' });
    expect(find(after)).toMatchObject({ outcome: 'NO_RECORD' });
    expect(result.summary).toMatchObject({ eligibleSessions: 2, percent: 50 });

    // The list says they were enrolled from the start: earlier sessions then count too.
    await h.db.pool.query(
      `UPDATE roster_entries SET created_at = created_at - interval '2 days' WHERE course_id = $1 AND student_id_norm = $2`,
      [course, s!.studentId],
    );
    result = await history(s!, course);
    expect(find(before)).toMatchObject({ outcome: 'NO_RECORD' });
    expect(result.summary).toMatchObject({ eligibleSessions: 3 });

    // Removed from the class list before a later session: that session is not theirs to be counted in.
    await h.db.pool.query(
      `UPDATE roster_entries SET retired_at = (SELECT started_at FROM class_sessions WHERE id = $2) - interval '1 microsecond'
        WHERE course_id = $1 AND student_id_norm = $3`,
      [course, after, s!.studentId],
    );
    result = await history(s!, course);
    expect(find(after)).toMatchObject({ outcome: 'NOT_COUNTED' });
    expect(result.summary).toMatchObject({ eligibleSessions: 2 });
  });
});

describe('two courses never mix', () => {
  it('keeps each course’s sessions and totals separate, even with identical names, and follows ids not names', async () => {
    const course = await h.newCourse();
    const courseB = await h.newCourse('other');
    await h.db.pool.query(
      `UPDATE courses SET title = 'Introduction to Computing' WHERE id = ANY($1::uuid[])`,
      [[course, courseB]],
    );
    const [s] = await createBulkStudents(h.db, 1);
    const a1 = await h.openSession(course);
    const b1 = await h.openSession(courseB);
    for (const sess of [a1, b1]) expect((await h.scan(s!, sess)).statusCode).toBe(201);
    const a2 = await h.openSession(course); // started after the student belongs to the course
    for (const [owned, sess, who] of [
      [course, a1, h.lecturer],
      [course, a2, h.lecturer],
      [courseB, b1, h.other],
    ] as const)
      await end(owned, sess, who);

    const list = await courseList(s!);
    expect(list.courses).toHaveLength(2);
    expect(new Set(list.courses.map((c: { title: string }) => c.title))).toEqual(
      new Set(['Introduction to Computing']),
    );
    const a = await history(s!, course);
    const b = await history(s!, courseB);
    expect(a.sessions.map((x: { id: string }) => x.id).sort()).toEqual([a1, a2].sort());
    expect(b.sessions.map((x: { id: string }) => x.id)).toEqual([b1]);
    expect(a.summary).toMatchObject({
      sessionsStarted: 2,
      eligibleSessions: 2,
      tally: { provisional: 1, noRecord: 1 },
    });
    expect(b.summary).toMatchObject({
      sessionsStarted: 1,
      eligibleSessions: 1,
      tally: { provisional: 1, noRecord: 0 },
    });
    // The list's own totals match each course's page.
    const listed = (id: string) => list.courses.find((c: { id: string }) => c.id === id).summary;
    expect(listed(course)).toEqual(a.summary);
    expect(listed(courseB)).toEqual(b.summary);

    // A new title changes what is displayed and nothing about what belongs where.
    await h.db.pool.query(
      `UPDATE courses SET title = 'Renamed Course', code = 'ZZ999' WHERE id = $1`,
      [course],
    );
    const renamed = await history(s!, course);
    expect(renamed.course).toMatchObject({
      id: course,
      code: 'ZZ999',
      title: 'Renamed Course',
    });
    expect(renamed.sessions.map((x: { id: string }) => x.id).sort()).toEqual([a1, a2].sort());
    expect(renamed.summary).toEqual(a.summary);
  });

  it('refuses to attribute a record to a course whose session it is not (the database itself forbids it)', async () => {
    const course = await h.newCourse();
    const courseB = await h.newCourse('other');
    const [s] = await createBulkStudents(h.db, 1);
    const inA = await h.openSession(course);
    await h.scan(s!, inA);
    const record = await attendanceIdOf(inA, s!);
    await expect(
      h.db.pool.query('UPDATE attendance_records SET course_id = $2 WHERE id = $1', [
        record,
        courseB,
      ]),
    ).rejects.toMatchObject({ code: '23503' }); // composite foreign key to the session's own course
    await expect(
      h.db.appPool.query('UPDATE attendance_records SET course_id = $2 WHERE id = $1', [
        record,
        courseB,
      ]),
    ).rejects.toMatchObject({ code: '42501' }); // and the application is not even allowed to try
  });

  it('shows a student nothing about courses they are not in, and nothing for a course with no sessions', async () => {
    const course = await h.newCourse();
    const courseB = await h.newCourse('other');
    const [s, outsider] = await createBulkStudents(h.db, 2);
    const only = await h.openSession(course);
    await h.scan(s!, only);
    expect((await courseList(outsider!)).courses).toEqual([]);
    expect((await h.get(`/me/courses/${course}`, outsider!.cookie)).statusCode).toBe(404);
    expect((await h.get(`/me/courses/${courseB}`, s!.cookie)).statusCode).toBe(404); // right student, wrong course
  });
});

describe('what a lecturer sees for a course', () => {
  it('gives the course’s per-session totals and each student’s cumulative attendance, side by side', async () => {
    const course = await h.newCourse();
    const { s, s1, s4 } = await fiveSessions(course);
    const [other] = await createBulkStudents(h.db, 1);
    await h.scan(other!, s4); // too late: s4 has ended, so this is refused and records nothing
    await confirm(course, await linkOf(course, s));

    const summary = (await h.get(`/courses/${course}/attendance-summary`)).json();
    const mine = summary.students.find((x: { studentId: string }) => x.studentId === s.studentId);
    expect(mine).toMatchObject({
      associationState: 'CONFIRMED',
      summary: { eligibleSessions: 3, percent: 33.3 },
      flaggedRecords: 0,
    });
    const sessionRow = (id: string) => summary.sessions.find((x: { id: string }) => x.id === id);
    expect(sessionRow(s1)).toMatchObject({ present: 1, confirmed: 1, invalidated: 0 });
    expect(sessionRow(s4)).toMatchObject({ present: 0, invalidated: 1 });
    expect(
      summary.students.every((x: { studentId: string }) => x.studentId !== other!.studentId),
    ).toBe(true);
  });

  it('lists class-list students with no account separately, and calculates nothing for them', async () => {
    const courseB = await h.newCourse('other');
    const course = courseB;
    const csv = 'student_id,full_name\nNOACCOUNT1,Not Registered Yet\n';
    const preview = await h.post(`/courses/${course}/roster/preview`, { csv }, h.other.cookie);
    await h.post(
      `/courses/${course}/roster/apply`,
      { csv, previewToken: preview.json().previewToken, retireEntryIds: [] },
      h.other.cookie,
    );
    const summary = (await h.get(`/courses/${course}/attendance-summary`, h.other.cookie)).json();
    expect(summary.notRegistered).toEqual([
      expect.objectContaining({ studentId: 'NOACCOUNT1', fullName: 'Not Registered Yet' }),
    ]);
    expect(summary.students.some((x: { studentId: string }) => x.studentId === 'NOACCOUNT1')).toBe(
      false,
    );
  });

  it('shows one student’s full history to the lecturer, including what only a lecturer may see', async () => {
    const course = await h.newCourse();
    const { s, s1 } = await fiveSessions(course);
    const link = await linkOf(course, s);
    const res = (await h.get(`/courses/${course}/students/${link}/attendance`)).json();
    expect(res.student).toMatchObject({
      linkId: link,
      studentId: s.studentId,
      associationState: 'PROVISIONAL',
    });
    expect(res.summary.eligibleSessions).toBe(3);
    expect(res.sessions.find((x: { id: string }) => x.id === s1)).toMatchObject({
      attendanceId: expect.any(String),
      outcome: 'PROVISIONAL',
      flagged: false,
    });
  });

  it('summarises each assigned course for the dashboard: what is open, and what needs attention', async () => {
    const course = await h.newCourse();
    const courseB = await h.newCourse('other');
    const open = await h.openSession(course);
    const students = await h.checkInStudents(open, 3);
    await decide(course, await linkOf(course, students[0]!), 'MARK_REVIEW_REQUIRED');
    const overview = (await h.get('/courses/overview')).json();
    const mine = overview.courses.find((c: { id: string }) => c.id === course);
    expect(mine.openSession).toMatchObject({ id: open, present: 3 });
    expect(mine.attention.matchesToReview).toBeGreaterThanOrEqual(1);
    expect(mine.students.registered).toBeGreaterThanOrEqual(3);
    // Another lecturer's course is never in this lecturer's overview, and the reverse.
    expect(overview.courses.some((c: { id: string }) => c.id === courseB)).toBe(false);
    const theirs = (await h.get('/courses/overview', h.other.cookie)).json();
    const theirIds = theirs.courses.map((c: { id: string }) => c.id);
    expect(theirIds).toContain(courseB);
    expect(theirIds).not.toContain(course);
  });
});

describe('access control on every new route', () => {
  it('keeps lecturers, students and the signed-out apart', async () => {
    const course = await h.newCourse();
    const courseB = await h.newCourse('other');
    const { s } = await fiveSessions(course);
    const link = await linkOf(course, s);
    const lecturerRoutes = [
      '/courses/overview',
      `/courses/${course}/attendance-summary`,
      `/courses/${course}/students/${link}/attendance`,
    ];
    for (const url of lecturerRoutes) {
      expect((await h.get(url, s.cookie)).statusCode, `student on ${url}`).toBe(403);
      expect(
        (await h.app.inject({ method: 'GET', url, remoteAddress: '10.8.8.8' })).statusCode,
        `anonymous on ${url}`,
      ).toBe(401);
    }
    // Another lecturer cannot read this course, and a link from one course cannot be read through another.
    expect((await h.get(lecturerRoutes[1]!, h.other.cookie)).statusCode).toBe(404);
    expect((await h.get(lecturerRoutes[2]!, h.other.cookie)).statusCode).toBe(404);
    expect(
      (await h.get(`/courses/${courseB}/students/${link}/attendance`, h.other.cookie)).statusCode,
    ).toBe(404);
    expect((await h.get(`/courses/${course}/students/${randomUUID()}/attendance`)).statusCode).toBe(
      404,
    );
    expect((await h.get(`/courses/${course}/students/not-an-id/attendance`)).statusCode).toBe(404);
    // And a lecturer cannot use the student endpoints.
    for (const url of ['/me/courses', `/me/courses/${course}`]) {
      expect((await h.get(url)).statusCode).toBe(403);
    }
  });
});

describe('the view is the one definition', () => {
  it('has no row that pairs a student with a session of a different course', async () => {
    const { rows } = await h.db.pool.query(
      `SELECT count(*)::int AS n FROM course_session_attendance v
         JOIN class_sessions s ON s.id = v.session_id
        WHERE s.course_id <> v.course_id`,
    );
    expect(rows[0].n).toBe(0);
  });
});
