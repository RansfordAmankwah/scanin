import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/pool.js';
import { assignLecturer, createCourse, createTerm } from '../../src/operator/commands.js';
import { ensureLink } from '../../src/roster/matching.js';
import {
  createLecturerSession,
  createTestApp,
  get,
  newRegistration,
  post,
  registerAndLogin,
  registerStudent,
  type Registration,
  type TestApp,
} from '../helpers/app.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;
const operator = 'roster-test';
let courseSeq = 0;
let lecturer1: { id: string; cookie: string };
let lecturer2: { id: string; cookie: string };
let studentCookie: string;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);
  await createTerm(db.operatorPool, {
    operator,
    name: 'T1',
    startsOn: '2026-09-01',
    endsOn: '2026-12-20',
  });
  lecturer1 = await createLecturerSession(db, t.app, 'lec1@school.test');
  lecturer2 = await createLecturerSession(db, t.app, 'lec2@school.test');
  studentCookie = (await registerAndLogin(t.app)).cookie;
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

/** A fresh course assigned to lecturer 1. */
async function newCourse(): Promise<string> {
  courseSeq += 1;
  const code = `C${courseSeq}`;
  const { id } = await createCourse(db.operatorPool, { operator, term: 'T1', code, title: code });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: code,
    lecturerEmail: 'lec1@school.test',
  });
  return id;
}

type Row = [id: string, name: string, email?: string];
const csv = (rows: Row[], withEmail = true): string =>
  [withEmail ? 'student_id,full_name,email' : 'student_id,full_name']
    .concat(
      rows.map(([id, name, email]) =>
        withEmail ? `${id},${name},${email ?? ''}` : `${id},${name}`,
      ),
    )
    .join('\n');

async function importRoster(
  courseId: string,
  text: string,
  retire: string[] = [],
  cookie = lecturer1.cookie,
) {
  const preview = await post(
    t.app,
    `/courses/${courseId}/roster/preview`,
    { csv: text },
    { cookie },
  );
  if (preview.statusCode !== 200) return { preview, apply: preview };
  const apply = await post(
    t.app,
    `/courses/${courseId}/roster/apply`,
    { csv: text, previewToken: preview.json().previewToken, retireEntryIds: retire },
    { cookie },
  );
  return { preview, apply };
}

let studentSeq = 0;
function reg(overrides: Partial<Registration> = {}): Registration {
  studentSeq += 1;
  return newRegistration({ studentId: `ZZ${String(studentSeq).padStart(5, '0')}`, ...overrides });
}

const linkFor = (courseId: string, userId: string) =>
  withTransaction(db.appPool, (c) => ensureLink(c, courseId, userId));

const linkRow = async (courseId: string, userId: string) =>
  (
    await db.pool.query(
      `SELECT l.id, l.state, l.confirmed_basis, l.roster_entry_id, l.current_review_no,
              (SELECT count(*)::int FROM identity_reviews r WHERE r.link_id = l.id) AS reviews
         FROM roster_links l WHERE l.course_id = $1 AND l.student_id = $2`,
      [courseId, userId],
    )
  ).rows[0];

const entryId = async (courseId: string, studentId: string): Promise<string> =>
  (
    await db.pool.query<{ id: string }>(
      'SELECT id FROM roster_entries WHERE course_id = $1 AND student_id_norm = $2 AND retired_at IS NULL',
      [courseId, studentId],
    )
  ).rows[0]?.id as string;

const flagsFor = async (linkId: string) =>
  (
    await db.pool.query(
      'SELECT kind, state, related_link_id, detail, origin FROM investigation_flags WHERE roster_link_id = $1',
      [linkId],
    )
  ).rows;

describe('ID-01 exact student-ID match comes first', () => {
  it('confirms by ID, records the basis and a first system review, and is idempotent', async () => {
    const courseId = await newCourse();
    const r = reg({ studentId: 'ab 100' });
    const userId = await registerStudent(db, t, r);
    await importRoster(courseId, csv([['AB100', 'Ama Mensah', 'ama@school.test']]));

    const first = await linkFor(courseId, userId);
    expect(first.created).toBe(true);
    const row = await linkRow(courseId, userId);
    expect(row).toMatchObject({
      state: 'CONFIRMED',
      confirmed_basis: 'ROSTER_ID_MATCH',
      current_review_no: 1,
      reviews: 1,
    });
    expect(row.roster_entry_id).toBe(await entryId(courseId, 'AB100'));

    const again = await linkFor(courseId, userId);
    expect(again.created).toBe(false);
    expect(again.link.id).toBe(first.link.id);
    expect((await linkRow(courseId, userId)).reviews).toBe(1);
  });

  it('prefers the ID match over an e-mail match on a different entry', async () => {
    const courseId = await newCourse();
    const r = reg({ studentId: 'PREF001', email: 'pref@school.test' });
    const userId = await registerStudent(db, t, r, { verifyEmail: true });
    await importRoster(
      courseId,
      csv([
        ['PREF001', 'By Id', 'someone.else@school.test'],
        ['PREF002', 'By Email', 'pref@school.test'],
      ]),
    );
    await linkFor(courseId, userId);
    const row = await linkRow(courseId, userId);
    expect(row.confirmed_basis).toBe('ROSTER_ID_MATCH');
    expect(row.roster_entry_id).toBe(await entryId(courseId, 'PREF001'));
  });

  it('keeps links separate per course', async () => {
    const a = await newCourse();
    const b = await newCourse();
    const userId = await registerStudent(db, t, reg({ studentId: 'SCOPE001' }));
    await importRoster(a, csv([['SCOPE001', 'Scoped Student']]));
    await linkFor(a, userId);
    await linkFor(b, userId); // course b has no roster
    expect((await linkRow(a, userId)).state).toBe('CONFIRMED');
    expect((await linkRow(b, userId)).state).toBe('PROVISIONAL');
  });
});

describe('ID-02 verified e-mail is a fallback only', () => {
  it('matches by verified e-mail when the ID is not on the roster', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(
      db,
      t,
      reg({ studentId: 'MAIL001', email: 'kwame@school.test' }),
      { verifyEmail: true },
    );
    await importRoster(courseId, csv([['ROSTER777', 'Kwame Asante', 'kwame@school.test']]));
    await linkFor(courseId, userId);
    const row = await linkRow(courseId, userId);
    expect(row).toMatchObject({ state: 'CONFIRMED', confirmed_basis: 'ROSTER_EMAIL_MATCH' });
    expect(row.roster_entry_id).toBe(await entryId(courseId, 'ROSTER777'));
  });

  it('does not match on an unverified e-mail', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(
      db,
      t,
      reg({ studentId: 'MAIL002', email: 'esi@school.test' }),
    );
    await importRoster(courseId, csv([['ROSTER778', 'Esi Boateng', 'esi@school.test']]));
    await linkFor(courseId, userId);
    expect(await linkRow(courseId, userId)).toMatchObject({
      state: 'REVIEW_REQUIRED',
      roster_entry_id: null,
      confirmed_basis: null,
    });
  });

  it('does not match by e-mail when the roster carries no e-mail data', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(
      db,
      t,
      reg({ studentId: 'MAIL003', email: 'yaw@school.test' }),
      { verifyEmail: true },
    );
    await importRoster(courseId, csv([['ROSTER779', 'Yaw Owusu']], false));
    await linkFor(courseId, userId);
    expect(await linkRow(courseId, userId)).toMatchObject({
      state: 'REVIEW_REQUIRED',
      roster_entry_id: null,
    });
  });
});

describe('ID-03 similar names are suggestions, never links', () => {
  it('sends a near-miss to review, flags it as ambiguous, and links nothing', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(
      db,
      t,
      reg({ studentId: 'FUZZ001', fullName: 'Ama Mensa' }),
    );
    await importRoster(courseId, csv([['FZ900', 'Ama Mensah', 'ama.m@school.test']]));
    await linkFor(courseId, userId);

    const row = await linkRow(courseId, userId);
    expect(row).toMatchObject({
      state: 'REVIEW_REQUIRED',
      roster_entry_id: null,
      confirmed_basis: null,
    });

    const target = await entryId(courseId, 'FZ900');
    const flags = await flagsFor(row.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      kind: 'AMBIGUOUS_ROSTER_MATCH',
      state: 'OPEN',
      origin: 'SYSTEM',
    });
    expect(flags[0].detail.candidateEntryIds).toEqual([target]);

    // The candidate entry has no holder: nothing was linked or merged.
    const holders = await db.pool.query('SELECT 1 FROM roster_links WHERE roster_entry_id = $1', [
      target,
    ]);
    expect(holders.rowCount).toBe(0);

    const res = await get(t.app, `/courses/${courseId}/links/${row.id}/suggestions`, {
      cookie: lecturer1.cookie,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestionOnly).toBe(true);
    expect(res.json().candidates[0]).toMatchObject({ entryId: target, studentId: 'FZ900' });
    expect(res.json().candidates[0].similarity).toBeGreaterThan(0.4);
  });

  it('does not flag when nothing resembles the name', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(
      db,
      t,
      reg({ studentId: 'FUZZ002', fullName: 'Zzyzx Qwerty' }),
    );
    await importRoster(courseId, csv([['FZ901', 'Ama Mensah']]));
    await linkFor(courseId, userId);
    const row = await linkRow(courseId, userId);
    expect(row.state).toBe('REVIEW_REQUIRED');
    expect(await flagsFor(row.id)).toHaveLength(0);
  });

  it('keeps suggestions private to lecturers assigned to the course', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(
      db,
      t,
      reg({ studentId: 'FUZZ003', fullName: 'Kofi Annan' }),
    );
    await importRoster(courseId, csv([['FZ902', 'Kofi Annan Jr']]));
    await linkFor(courseId, userId);
    const row = await linkRow(courseId, userId);
    expect(
      (
        await get(t.app, `/courses/${courseId}/links/${row.id}/suggestions`, {
          cookie: lecturer2.cookie,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await get(t.app, `/courses/${courseId}/links/${row.id}/suggestions`, {
          cookie: studentCookie,
        })
      ).statusCode,
    ).toBe(403);
    // A link id from another course is not reachable through this course either.
    const other = await newCourse();
    expect(
      (
        await get(t.app, `/courses/${other}/links/${row.id}/suggestions`, {
          cookie: lecturer1.cookie,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('ID-04 conflicting claims require explicit review', () => {
  let scenarioSeq = 0;
  async function conflictScenario() {
    scenarioSeq += 1;
    const holderEmail = `holder${scenarioSeq}@school.test`;
    const contested = `CONTEST${scenarioSeq}`;
    const courseId = await newCourse();
    const holderUser = await registerStudent(
      db,
      t,
      reg({ studentId: `HOLD00${scenarioSeq}`, email: holderEmail }),
      { verifyEmail: true },
    );
    const claimantUser = await registerStudent(db, t, reg({ studentId: contested }));
    await importRoster(courseId, csv([[contested, 'Contested Person', holderEmail]]));
    return { courseId, holderUser, claimantUser, contested };
  }

  it('sends both accounts to review, flags the conflict, and merges nothing', async () => {
    const { courseId, holderUser, claimantUser, contested } = await conflictScenario();
    await linkFor(courseId, holderUser); // matches the entry by verified e-mail first
    expect(await linkRow(courseId, holderUser)).toMatchObject({
      state: 'CONFIRMED',
      confirmed_basis: 'ROSTER_EMAIL_MATCH',
    });

    await linkFor(courseId, claimantUser); // exact ID match on an entry that is already held
    const claimant = await linkRow(courseId, claimantUser);
    const holder = await linkRow(courseId, holderUser);
    const entry = await entryId(courseId, contested);

    expect(claimant).toMatchObject({ state: 'REVIEW_REQUIRED', roster_entry_id: null });
    expect(holder).toMatchObject({
      state: 'REVIEW_REQUIRED',
      confirmed_basis: null,
      roster_entry_id: entry,
    });
    expect(holder.current_review_no).toBe(2);

    const flags = await flagsFor(claimant.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      kind: 'CONFLICTING_STUDENT_ID',
      state: 'OPEN',
      related_link_id: holder.id,
    });

    const downgrade = await db.pool.query(
      `SELECT decision, from_state, to_state FROM identity_reviews WHERE link_id = $1 AND review_no = 2`,
      [holder.id],
    );
    expect(downgrade.rows[0]).toEqual({
      decision: 'SYSTEM_DOWNGRADE',
      from_state: 'CONFIRMED',
      to_state: 'REVIEW_REQUIRED',
    });
  });

  it('lets exactly one of two simultaneous claimants take the entry, with no errors', async () => {
    const { courseId, holderUser, claimantUser, contested } = await conflictScenario();
    const results = await Promise.allSettled([
      linkFor(courseId, holderUser),
      linkFor(courseId, claimantUser),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const entry = await entryId(courseId, contested);
    const holders = await db.pool.query(
      `SELECT student_id FROM roster_links WHERE roster_entry_id = $1 AND state <> 'REJECTED'`,
      [entry],
    );
    expect(holders.rowCount).toBe(1);
    const flags = await db.pool.query(
      `SELECT count(*)::int AS n FROM investigation_flags WHERE course_id = $1 AND kind = 'CONFLICTING_STUDENT_ID'`,
      [courseId],
    );
    expect(flags.rows[0].n).toBe(1);
    const states = (
      await db.pool.query(`SELECT state FROM roster_links WHERE course_id = $1 ORDER BY state`, [
        courseId,
      ])
    ).rows.map((r) => r.state);
    expect(states).toEqual(['REVIEW_REQUIRED', 'REVIEW_REQUIRED']); // both end up awaiting a decision
  });

  it('creates exactly one link when the same student triggers it concurrently', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(db, t, reg({ studentId: 'SAME0001' }));
    await importRoster(courseId, csv([['SAME0001', 'Same Student']]));
    const results = await Promise.all(Array.from({ length: 10 }, () => linkFor(courseId, userId)));
    expect(new Set(results.map((r) => r.link.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await linkRow(courseId, userId)).reviews).toBe(1);
  });
});

describe('ID-05 courses without a roster', () => {
  it('creates a provisional, self-reported association rather than claiming enrollment', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(db, t, reg({ studentId: 'NOROST01' }));
    await linkFor(courseId, userId);
    expect(await linkRow(courseId, userId)).toMatchObject({
      state: 'PROVISIONAL',
      roster_entry_id: null,
      confirmed_basis: null,
    });

    const view = (
      await get(t.app, `/courses/${courseId}/roster`, { cookie: lecturer1.cookie })
    ).json();
    expect(view.hasRoster).toBe(false);
    expect(view.entries).toEqual([]);
    expect(view.unmatchedLinks[0]).toMatchObject({
      studentId: 'NOROST01',
      state: 'PROVISIONAL',
      selfReported: true,
    });
  });

  it('re-evaluates provisional links when a roster is imported, by the same rules', async () => {
    const courseId = await newCourse();
    const onRoster = await registerStudent(db, t, reg({ studentId: 'LATE0001' }));
    const notOnRoster = await registerStudent(
      db,
      t,
      reg({ studentId: 'LATE0002', fullName: 'Totally Different' }),
    );
    await linkFor(courseId, onRoster);
    await linkFor(courseId, notOnRoster);

    const { apply } = await importRoster(courseId, csv([['LATE0001', 'Late Student']]));
    expect(apply.json().rematched).toEqual({ confirmed: 1, reviewRequired: 1 });

    expect(await linkRow(courseId, onRoster)).toMatchObject({
      state: 'CONFIRMED',
      confirmed_basis: 'ROSTER_ID_MATCH',
      current_review_no: 2,
    });
    expect(await linkRow(courseId, notOnRoster)).toMatchObject({
      state: 'REVIEW_REQUIRED',
      roster_entry_id: null,
    });
  });
});

describe('ID-07 re-importing never overwrites', () => {
  it('replaces changed rows with new entries, keeps history, and only retires what is approved', async () => {
    const courseId = await newCourse();
    const alice = await registerStudent(db, t, reg({ studentId: 'RE0001', fullName: 'Alice' }));
    const carl = await registerStudent(db, t, reg({ studentId: 'RE0003', fullName: 'Carl' }));
    await importRoster(
      courseId,
      csv([
        ['RE0001', 'Alice', 'alice@s.test'],
        ['RE0002', 'Bob', 'bob@s.test'],
        ['RE0003', 'Carl', 'carl@s.test'],
      ]),
    );
    await linkFor(courseId, alice);
    await linkFor(courseId, carl);
    const oldAlice = await entryId(courseId, 'RE0001');
    const oldCarl = await entryId(courseId, 'RE0003');

    const second = csv([
      ['RE0001', 'Alice Johnson', 'alice@s.test'],
      ['RE0002', 'Bob', 'bob@s.test'],
      ['RE0004', 'Dina', 'dina@s.test'],
    ]);
    const preview = await post(
      t.app,
      `/courses/${courseId}/roster/preview`,
      { csv: second },
      { cookie: lecturer1.cookie },
    );
    expect(preview.json().counts).toEqual({ added: 1, changed: 1, unchanged: 1, missing: 1 });
    expect(preview.json().missing[0]).toMatchObject({
      studentId: 'RE0003',
      fullName: 'Carl',
      heldBy: expect.any(String),
    });
    // Preview wrote nothing.
    expect(
      (
        await db.pool.query('SELECT count(*)::int AS n FROM roster_entries WHERE course_id = $1', [
          courseId,
        ])
      ).rows[0].n,
    ).toBe(3);

    const applied = await post(
      t.app,
      `/courses/${courseId}/roster/apply`,
      { csv: second, previewToken: preview.json().previewToken, retireEntryIds: [] },
      { cookie: lecturer1.cookie },
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ noChanges: false, added: 1, changed: 1, retired: 0 });

    // The old row is untouched except for retirement; a new row carries the change.
    const old = (
      await db.pool.query(
        'SELECT full_name, retired_at, superseded_by FROM roster_entries WHERE id = $1',
        [oldAlice],
      )
    ).rows[0];
    const newAlice = await entryId(courseId, 'RE0001');
    expect(old.full_name).toBe('Alice');
    expect(old.retired_at).not.toBeNull();
    expect(old.superseded_by).toBe(newAlice);
    expect(newAlice).not.toBe(oldAlice);
    expect(
      (await db.pool.query('SELECT full_name FROM roster_entries WHERE id = $1', [newAlice]))
        .rows[0].full_name,
    ).toBe('Alice Johnson');

    // Alice's confirmed link followed her entry, with a recorded system review; state and basis kept.
    const aliceLink = await linkRow(courseId, alice);
    expect(aliceLink).toMatchObject({
      state: 'CONFIRMED',
      confirmed_basis: 'ROSTER_ID_MATCH',
      roster_entry_id: newAlice,
      current_review_no: 2,
    });
    const repoint = (
      await db.pool.query(
        `SELECT decision, from_entry_id, to_entry_id FROM identity_reviews WHERE link_id = $1 AND review_no = 2`,
        [aliceLink.id],
      )
    ).rows[0];
    expect(repoint).toEqual({
      decision: 'SYSTEM_REPOINT',
      from_entry_id: oldAlice,
      to_entry_id: newAlice,
    });

    // Carl was missing but NOT retired: absence from a file is not a decision.
    expect(await entryId(courseId, 'RE0003')).toBe(oldCarl);
    expect((await linkRow(courseId, carl)).state).toBe('CONFIRMED');

    // Applying the same file again changes nothing and records nothing.
    const importsBefore = (
      await db.pool.query('SELECT count(*)::int AS n FROM roster_imports WHERE course_id = $1', [
        courseId,
      ])
    ).rows[0].n;
    const repeat = await importRoster(courseId, second);
    expect(repeat.apply.json().noChanges).toBe(true);
    expect(
      (
        await db.pool.query('SELECT count(*)::int AS n FROM roster_imports WHERE course_id = $1', [
          courseId,
        ])
      ).rows[0].n,
    ).toBe(importsBefore);

    // Retiring a missing entry is explicit, and sends its holder back to review.
    const retired = await importRoster(courseId, second, [oldCarl]);
    expect(retired.apply.json()).toMatchObject({ noChanges: false, retired: 1 });
    expect(await linkRow(courseId, carl)).toMatchObject({
      state: 'REVIEW_REQUIRED',
      confirmed_basis: null,
    });
    expect(await entryId(courseId, 'RE0003')).toBeUndefined();
  });

  it('refuses to retire an entry that is not missing, and rejects stale previews', async () => {
    const courseId = await newCourse();
    const first = csv([
      ['ST0001', 'One'],
      ['ST0002', 'Two'],
    ]);
    const { preview: p1, apply: a1 } = await importRoster(courseId, first);
    expect(a1.statusCode).toBe(200);

    const bad = await post(
      t.app,
      `/courses/${courseId}/roster/apply`,
      {
        csv: first,
        previewToken: p1.json().previewToken,
        retireEntryIds: [await entryId(courseId, 'ST0001')],
      },
      { cookie: lecturer1.cookie },
    );
    expect(bad.statusCode).toBe(409); // token was for the roster before the first import: stale

    const second = csv([
      ['ST0001', 'One'],
      ['ST0003', 'Three'],
    ]);
    const preview = await post(
      t.app,
      `/courses/${courseId}/roster/preview`,
      { csv: second },
      { cookie: lecturer1.cookie },
    );
    const invalidRetire = await post(
      t.app,
      `/courses/${courseId}/roster/apply`,
      {
        csv: second,
        previewToken: preview.json().previewToken,
        retireEntryIds: [await entryId(courseId, 'ST0001')],
      },
      { cookie: lecturer1.cookie },
    );
    expect(invalidRetire.statusCode).toBe(400);
    expect(invalidRetire.json().error.code).toBe('INVALID_RETIREMENT');

    // A token from a different file is refused too.
    const wrongFile = await post(
      t.app,
      `/courses/${courseId}/roster/apply`,
      {
        csv: csv([
          ['ST0001', 'One'],
          ['ST0009', 'Nine'],
        ]),
        previewToken: preview.json().previewToken,
        retireEntryIds: [],
      },
      { cookie: lecturer1.cookie },
    );
    expect(wrongFile.statusCode).toBe(409);
  });

  it('serialises simultaneous applies of the same file: one wins, the other is told it is stale', async () => {
    const courseId = await newCourse();
    const text = csv([
      ['RACE01', 'Racer One'],
      ['RACE02', 'Racer Two'],
    ]);
    const preview = await post(
      t.app,
      `/courses/${courseId}/roster/preview`,
      { csv: text },
      { cookie: lecturer1.cookie },
    );
    const token = preview.json().previewToken;
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        post(
          t.app,
          `/courses/${courseId}/roster/apply`,
          { csv: text, previewToken: token, retireEntryIds: [] },
          { cookie: lecturer1.cookie },
        ),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
    expect(
      (
        await db.pool.query('SELECT count(*)::int AS n FROM roster_entries WHERE course_id = $1', [
          courseId,
        ])
      ).rows[0].n,
    ).toBe(2);
  });

  it('audits the import without personal data', async () => {
    const { rows } = await db.pool.query(
      `SELECT summary, class FROM audit_events WHERE action = 'ROSTER_IMPORTED' LIMIT 1`,
    );
    expect(rows[0].class).toBe('DOMAIN');
    expect(Object.keys(rows[0].summary).sort()).toEqual([
      'added',
      'changed',
      'rematchedConfirmed',
      'rematchedForReview',
      'retired',
    ]);
  });
});

describe('roster file validation', () => {
  it('accepts common header names and a byte-order mark', async () => {
    const courseId = await newCourse();
    const text = '﻿Student ID,Name,School Email\nHD001,Header Test,hd@school.test\n';
    const { apply } = await importRoster(courseId, text);
    expect(apply.statusCode).toBe(200);
    expect(apply.json().added).toBe(1);
  });

  it.each([
    ['a bad student ID', 'student_id,full_name\n!,Some Name\n', 'INVALID_STUDENT_ID'],
    ['a blank name', 'student_id,full_name\nOK001, \n', 'INVALID_NAME'],
    [
      'a malformed e-mail',
      'student_id,full_name,email\nOK001,Name,not-an-email\n',
      'INVALID_EMAIL',
    ],
    [
      'a duplicate ID',
      'student_id,full_name\nOK001,A Name\nok 001,B Name\n',
      'DUPLICATE_STUDENT_ID',
    ],
    [
      'a duplicate e-mail',
      'student_id,full_name,email\nOK001,A Name,x@s.test\nOK002,B Name,X@s.test\n',
      'DUPLICATE_EMAIL',
    ],
  ])('rejects the whole file for %s and writes nothing', async (_label, text, code) => {
    const courseId = await newCourse();
    const res = await post(
      t.app,
      `/courses/${courseId}/roster/preview`,
      { csv: text },
      { cookie: lecturer1.cookie },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.rowErrors[0]).toMatchObject({ code });
    const apply = await post(
      t.app,
      `/courses/${courseId}/roster/apply`,
      { csv: text, previewToken: 'a'.repeat(64) },
      { cookie: lecturer1.cookie },
    );
    expect(apply.statusCode).toBe(400);
    expect(
      (
        await db.pool.query('SELECT count(*)::int AS n FROM roster_entries WHERE course_id = $1', [
          courseId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('rejects missing columns, empty files and unreadable input', async () => {
    const courseId = await newCourse();
    for (const [text, reason] of [
      ['name,email\nA,b@c.test\n', 'MISSING_COLUMNS'],
      ['student_id,full_name\n', 'EMPTY'],
      ['student_id,full_name\nA1,"unterminated\n', 'UNREADABLE'],
    ] as const) {
      const res = await post(
        t.app,
        `/courses/${courseId}/roster/preview`,
        { csv: text },
        { cookie: lecturer1.cookie },
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.reason).toBe(reason);
    }
  });
});

describe('roster access control', () => {
  it('keeps other lecturers and students out of import, apply and listing', async () => {
    const courseId = await newCourse();
    const text = csv([['AC0001', 'Access Test']]);
    for (const [cookie, status] of [
      [lecturer2.cookie, 404],
      [studentCookie, 403],
    ] as const) {
      expect(
        (await post(t.app, `/courses/${courseId}/roster/preview`, { csv: text }, { cookie }))
          .statusCode,
      ).toBe(status);
      expect(
        (
          await post(
            t.app,
            `/courses/${courseId}/roster/apply`,
            { csv: text, previewToken: 'a'.repeat(64) },
            { cookie },
          )
        ).statusCode,
      ).toBe(status);
      expect((await get(t.app, `/courses/${courseId}/roster`, { cookie })).statusCode).toBe(status);
    }
    expect(
      (
        await db.pool.query('SELECT count(*)::int AS n FROM roster_entries WHERE course_id = $1', [
          courseId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('shows the roster with registration and link state to the assigned lecturer', async () => {
    const courseId = await newCourse();
    const userId = await registerStudent(db, t, reg({ studentId: 'VIEW001' }));
    await importRoster(
      courseId,
      csv([
        ['VIEW001', 'Viewable One'],
        ['VIEW002', 'Not Registered'],
      ]),
    );
    await linkFor(courseId, userId);
    const view = (
      await get(t.app, `/courses/${courseId}/roster`, { cookie: lecturer1.cookie })
    ).json();
    expect(view.hasRoster).toBe(true);
    expect(view.entries).toHaveLength(2);
    expect(view.entries[0]).toMatchObject({
      studentId: 'VIEW001',
      registered: true,
      link: { state: 'CONFIRMED', basis: 'ROSTER_ID_MATCH' },
    });
    expect(view.entries[1]).toMatchObject({ studentId: 'VIEW002', registered: false, link: null });
  });
});
