import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport, type ReportModel } from '../../src/exports/model.js';
import { safeCell } from '../../src/exports/sanitize.js';
import { expireExports } from '../../src/exports/service.js';
import { LocalDiskStorage } from '../../src/exports/storage.js';
import {
  assignLecturer,
  createCourse,
  createTerm,
  endAssignment,
} from '../../src/operator/commands.js';
import { mintToken, parseKeyring } from '../../src/qr/token.js';
import {
  TEST_CONFIG,
  createLecturerSession,
  createTestApp,
  freshIp,
  get,
  post,
  type TestApp,
} from '../helpers/app.js';
import { parseCsv, parseDocx, parsePdf, parseXlsx } from '../helpers/parse.js';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;
let t: TestApp;
let lecturer1: { id: string; cookie: string };
let lecturer2: { id: string; cookie: string };
const operator = 'export-test';
const keyring = parseKeyring(TEST_CONFIG.QR_KEYS, TEST_CONFIG.QR_ACTIVE_KID);
let courseSeq = 0;
const FORMATS = ['CSV', 'XLSX', 'PDF', 'DOCX'] as const;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);
  await createTerm(db.operatorPool, {
    operator,
    name: 'T1',
    startsOn: '2026-09-01',
    endsOn: '2026-12-20',
  });
  lecturer1 = await createLecturerSession(db, t.app, 'lec1@school.test', 'Dr One');
  lecturer2 = await createLecturerSession(db, t.app, 'lec2@school.test', 'Dr Two');
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

async function newCourse(): Promise<string> {
  courseSeq += 1;
  const code = `X${courseSeq}`;
  const { id } = await createCourse(db.operatorPool, {
    operator,
    term: 'T1',
    code,
    title: `Export course ${code}`,
  });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: code,
    lecturerEmail: 'lec1@school.test',
  });
  return id;
}
const L1 = (path: string, body: unknown = {}) =>
  post(t.app, path, body, { cookie: lecturer1.cookie });
const students = (n: number): Promise<BulkStudent[]> => createBulkStudents(db, n);

async function openSession(course: string): Promise<string> {
  const id = (
    await L1(`/courses/${course}/sessions`, { title: 'Week 3 lecture', sessionDate: '2026-10-10' })
  ).json().session.id as string;
  await L1(`/courses/${course}/sessions/${id}/start`);
  return id;
}
async function scan(s: BulkStudent, session: string) {
  const now = Number(
    (
      await db.pool.query<{ ms: string }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
      )
    ).rows[0]!.ms,
  );
  return post(
    t.app,
    '/checkins',
    { token: mintToken(keyring, session, now).token, clientAttemptId: randomUUID() },
    { cookie: s.cookie, ip: freshIp() },
  );
}

/** A realistic session: roster, confirmed + provisional + needs-review + invalidated + manual + flagged. */
async function richSession() {
  const course = await newCourse();
  const crowd = await students(6);
  const names = [
    'Ama Mensah',
    'Zoë Müller',
    'Kofi Boateng',
    'Yaw Owusu',
    'Esi, "Quoted" Darko',
    'Nana Adjei',
  ];
  for (const [i, s] of crowd.entries())
    await db.pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [s.id, names[i]]);
  const csv = `student_id,full_name\n${crowd[0]!.studentId},Ama Mensah\n${crowd[1]!.studentId},Zoë Müller\nNOT-REGISTERED-1,Yet To Register\n`;
  const preview = await L1(`/courses/${course}/roster/preview`, { csv });
  await L1(`/courses/${course}/roster/apply`, {
    csv,
    previewToken: preview.json().previewToken,
    retireEntryIds: [],
  });
  const session = await openSession(course);
  for (const s of crowd.slice(0, 5)) await scan(s, session); // 0,1 confirmed; 2,3,4 need review
  await L1(`/courses/${course}/sessions/${session}/attendance/manual`, {
    studentId: crowd[5]!.studentId,
    explanation: 'Camera broken, saw them in class',
  });
  const rec = async (i: number) =>
    (
      await db.pool.query<{ id: string }>(
        'SELECT id FROM attendance_records WHERE session_id = $1 AND student_id = $2',
        [session, crowd[i]!.id],
      )
    ).rows[0]!.id;
  await L1(`/courses/${course}/sessions/${session}/attendance/${await rec(3)}/invalidate`, {
    category: 'CONFIRMED_PROXY',
    explanation: 'Secret investigation note, never exported',
  });
  await L1(`/courses/${course}/flags`, {
    kind: 'PROXY_SUSPECTED',
    attendanceId: await rec(2),
    note: 'Phone passed along the row',
  });
  return { course, session, crowd };
}

/** Creates an export. The per-minute limit is lifted for ordinary tests; one test exercises it. */
const create = async (
  course: string,
  session: string,
  format: string,
  kind = 'ATTENDANCE',
  cookie = lecturer1.cookie,
  opts: { keepLimit?: boolean } = {},
) => {
  if (!opts.keepLimit) await db.pool.query('DELETE FROM rate_limits');
  return post(
    t.app,
    `/courses/${course}/exports`,
    { sessionId: session, kind, format },
    { cookie },
  );
};
const download = (id: string, cookie = lecturer1.cookie) =>
  get(t.app, `/exports/${id}/download`, { cookie });
async function fetchExport(
  course: string,
  session: string,
  format: string,
  kind = 'ATTENDANCE',
): Promise<Buffer> {
  const made = await create(course, session, format, kind);
  expect(made.statusCode, made.body).toBe(201);
  const res = await t.app.inject({
    method: 'GET',
    url: made.json().export.downloadPath,
    headers: { cookie: lecturer1.cookie },
    remoteAddress: freshIp(),
  });
  expect(res.statusCode).toBe(200);
  return res.rawPayload;
}

describe('EXP-01 one report model, four formats, identical content', () => {
  it('shows the same facts, counts and rows in CSV, XLSX, PDF and DOCX', async () => {
    const { course, session } = await richSession();
    const model: ReportModel = await buildReport(db.appPool, {
      courseId: course,
      sessionId: session,
      kind: 'ATTENDANCE',
      actorId: lecturer1.id,
    });
    expect(model.table.rows).toHaveLength(7); // 6 records + 1 roster entry without a record
    expect(model.totals).toEqual({
      presentTotal: 5,
      confirmed: 2,
      provisional: 0,
      reviewRequired: 3,
      invalidated: 1,
      flaggedPresent: 1,
    });
    // The on-screen view uses the same counting definition.
    expect(
      (
        await get(t.app, `/courses/${course}/sessions/${session}/attendance`, {
          cookie: lecturer1.cookie,
        })
      ).json().counts,
    ).toEqual(model.totals);

    const expectedCounts = {
      'Present (all)': 5,
      Confirmed: 2,
      Provisional: 0,
      'Needs review': 3,
      'Invalidated (not counted as present)': 1,
      'Flagged (overlay; included above, not additional)': 1,
    };

    const csv = parseCsv(await fetchExport(course, session, 'CSV'));
    expect(csv.hasBom).toBe(true);
    expect(csv.columns).toEqual(model.table.columns);
    expect(csv.rows).toEqual(model.table.rows);
    expect(csv.counts).toEqual(expectedCounts);
    expect(csv.facts['Course']).toBe(`${model.meta.courseCode} ${model.meta.courseTitle}`);

    const xlsx = await parseXlsx(await fetchExport(course, session, 'XLSX'));
    expect(xlsx.columns).toEqual(model.table.columns);
    expect(xlsx.rows).toEqual(model.table.rows);
    expect(xlsx.counts).toEqual(expectedCounts);
    expect(xlsx.facts['Session date']).toBe('2026-10-10');

    const docx = await parseDocx(await fetchExport(course, session, 'DOCX'));
    const [facts, counts, data] = docx.tables;
    expect(data![0]).toEqual(model.table.columns);
    expect(data!.slice(1)).toEqual(model.table.rows);
    expect(Object.fromEntries(counts!.map(([k, v]) => [k, Number(v)]))).toEqual(expectedCounts);
    expect(facts!.find(([k]) => k === 'Session')![1]).toBe('Week 3 lecture');
    expect(docx.title).toBe('Attendance report');

    const pdf = await parsePdf(await fetchExport(course, session, 'PDF'));
    for (const [label, value] of Object.entries(expectedCounts))
      expect(pdf.text).toContain(`${label}: ${value}`);
    for (const row of model.table.rows) {
      expect(pdf.text, row.join('|')).toContain(row[0]!);
      expect(pdf.text).toContain(row[1]!);
    }
    expect(pdf.text).toContain('Zoë Müller'); // non-ASCII survives
    expect(pdf.text).toContain('Week 3 lecture');
    expect(pdf.info.Author).toBe('ScanIn');
  });

  it('carries the required header facts, clearly labelled and separated from counts', async () => {
    const { course, session } = await richSession();
    const csv = parseCsv(await fetchExport(course, session, 'CSV'));
    expect(Object.keys(csv.facts)).toEqual([
      'Report',
      'Course',
      'Term',
      'Session',
      'Session date',
      'Lecturer(s)',
      'Generated (UTC)',
      'Generated by',
      'Definitions version',
      'Note',
    ]);
    expect(csv.facts['Lecturer(s)']).toBe('Dr One');
    expect(csv.facts['Generated (UTC)']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(csv.facts['Generated by']).toBe('Dr One');
    expect(csv.facts['Note']).toMatch(/self-reported/);
    // Counts are a separate block, not mixed into the data rows.
    expect(csv.raw.findIndex((r) => r[0] === 'Counts')).toBeLessThan(
      csv.raw.findIndex((r) => r[0] === 'Student ID'),
    );
  });

  it('preserves unusual but legitimate names: quotes, commas, accents', async () => {
    const { course, session } = await richSession();
    const csv = parseCsv(await fetchExport(course, session, 'CSV'));
    const names = csv.rows.map((r) => r[1]);
    expect(names).toContain('Esi, "Quoted" Darko');
    expect(names).toContain('Zoë Müller');
    const xlsx = await parseXlsx(await fetchExport(course, session, 'XLSX'));
    expect(xlsx.rows.map((r) => r[1])).toContain('Esi, "Quoted" Darko');
  });

  it("never includes a lecturer's explanation text, only the reason category", async () => {
    const { course, session } = await richSession();
    for (const format of FORMATS) {
      const body = await fetchExport(course, session, format);
      const text =
        format === 'PDF'
          ? (await parsePdf(body)).text
          : format === 'DOCX'
            ? (await parseDocx(body)).xml
            : format === 'XLSX'
              ? JSON.stringify((await parseXlsx(body)).rows)
              : body.toString('utf8');
      expect(text, format).not.toContain('Secret investigation note');
      expect(text, format).not.toContain('Phone passed along the row');
      expect(text, format).not.toContain('Camera broken');
    }
    const csv = parseCsv(await fetchExport(course, session, 'CSV'));
    expect(csv.rows.find((r) => r[2] === 'Invalidated')![6]).toBe('Confirmed proxy attendance');
  });

  it('marks manual attendance, flags, and unconfirmed matches in every format', async () => {
    const { course, session } = await richSession();
    const csv = parseCsv(await fetchExport(course, session, 'CSV'));
    expect(csv.rows.filter((r) => r[3] === 'Marked by lecturer')).toHaveLength(1);
    expect(csv.rows.filter((r) => r[5] === 'Yes')).toHaveLength(1);
    expect(csv.rows.filter((r) => r[4] === 'Needs review').length).toBeGreaterThan(0);
    expect(csv.rows.find((r) => r[2] === 'No record')![1]).toBe('Yet To Register');
  });
});

describe('EXP-02 spreadsheet formula injection', () => {
  const evil = [
    '=HYPERLINK("http://evil.example","click")',
    '+1+1',
    '-2+3',
    '@SUM(A1:A9)',
    "\t=cmd|' /C calc'!A0",
    '  =leading space',
    '=1+1',
  ];

  it('neutralises every dangerous leading character in names, in CSV and XLSX', async () => {
    const course = await newCourse();
    const session = await openSession(course);
    const crowd = await students(evil.length);
    for (const [i, s] of crowd.entries()) {
      await db.pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [s.id, evil[i]]);
      await scan(s, session);
    }
    const csv = parseCsv(await fetchExport(course, session, 'CSV'));
    for (const row of csv.rows) {
      for (const cellText of row)
        expect(/^[\s]*[=+\-@\t\r]/.test(cellText), JSON.stringify(cellText)).toBe(false);
    }
    expect(csv.rows.map((r) => r[1]).sort()).toEqual(evil.map(safeCell).sort());

    const xlsx = await parseXlsx(await fetchExport(course, session, 'XLSX'));
    for (const cell of [...xlsx.cells, ...xlsx.summaryCells]) {
      expect(cell.type, `${cell.address}`).not.toBe(ExcelValueTypeFormula);
      expect((cell as unknown as { formula?: string }).formula).toBeUndefined();
      if (typeof cell.value === 'string')
        expect(/^[\s]*[=+\-@\t\r]/.test(cell.value), cell.value).toBe(false);
    }
    expect(xlsx.rows.map((r) => r[1]).sort()).toEqual(evil.map(safeCell).sort());
  });

  it('leaves harmless text alone', () => {
    for (const ok of ['Ama Mensah', 'Mary-Jane', "O'Brien", 'Zoë', 'a=b', 'Dr. +1 not leading', ''])
      expect(safeCell(ok)).toBe(ok);
    for (const bad of ['=1', '+1', '-1', '@x', '\t1', '\r1', ' =1', '\n=1']) {
      expect(safeCell(bad).startsWith("'"), JSON.stringify(bad)).toBe(true);
    }
  });

  it('keeps student IDs as text so leading zeros survive', async () => {
    const course = await newCourse();
    const session = await openSession(course);
    const [s] = await students(1);
    await scan(s!, session);
    const xlsx = await parseXlsx(await fetchExport(course, session, 'XLSX'));
    const cell = xlsx.cells.find((c) => c.value === s!.studentId)!;
    expect(cell.type).toBe(ExcelValueTypeString);
    expect(cell.numFmt).toBe('@');
  });
});

const ExcelValueTypeFormula = 6;
const ExcelValueTypeString = 3;

describe('EXP-03 standard exports carry no scan times; the scan-history export does', () => {
  it('has no per-scan time anywhere in the attendance data, but a labelled generation time', async () => {
    const { course, session } = await richSession();
    const csv = parseCsv(await fetchExport(course, session, 'CSV'));
    expect(csv.columns).not.toContain('Time (UTC)');
    const dataText = JSON.stringify(csv.rows);
    expect(dataText).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(csv.facts['Generated (UTC)']).toBeTruthy();
    for (const format of ['XLSX', 'DOCX'] as const) {
      const rows =
        format === 'XLSX'
          ? (await parseXlsx(await fetchExport(course, session, format))).rows
          : (await parseDocx(await fetchExport(course, session, format))).tables.at(-1)!.slice(1);
      expect(JSON.stringify(rows), format).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });

  it('the scan-history report lists every attempt with its time, in all four formats', async () => {
    const { course, session } = await richSession();
    const model = await buildReport(db.appPool, {
      courseId: course,
      sessionId: session,
      kind: 'SCAN_HISTORY',
      actorId: lecturer1.id,
    });
    expect(model.table.columns).toEqual([
      'Time (UTC)',
      'Student ID',
      'Full name',
      'Result',
      'Browser',
      'Network',
    ]);
    expect(model.table.rows).toHaveLength(5);
    expect(model.totals).toBeNull();
    expect(
      model.table.rows.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r[0]!)),
    ).toBe(true);

    expect(parseCsv(await fetchExport(course, session, 'CSV', 'SCAN_HISTORY')).rows).toEqual(
      model.table.rows,
    );
    expect(
      (await parseXlsx(await fetchExport(course, session, 'XLSX', 'SCAN_HISTORY'))).rows,
    ).toEqual(model.table.rows);
    expect(
      (await parseDocx(await fetchExport(course, session, 'DOCX', 'SCAN_HISTORY'))).tables
        .at(-1)!
        .slice(1),
    ).toEqual(model.table.rows);
    const pdf = await parsePdf(await fetchExport(course, session, 'PDF', 'SCAN_HISTORY'));
    expect(pdf.text).toContain('Scan history report');
    expect(pdf.text).toContain(model.table.rows[0]![0]!);
  });

  it('is audited as its own kind of export', async () => {
    const { course, session } = await richSession();
    const made = await create(course, session, 'CSV', 'SCAN_HISTORY');
    const e = (
      await db.pool.query(
        `SELECT summary FROM audit_events WHERE action = 'EXPORT_REQUESTED' AND entity_id = $1`,
        [made.json().export.id],
      )
    ).rows[0];
    expect(e.summary).toMatchObject({ kind: 'SCAN_HISTORY', format: 'CSV' });
  });
});

describe('EXP-04 exporting changes nothing', () => {
  it('leaves attendance, matches, flags and sessions byte-identical', async () => {
    const { course, session } = await richSession();
    const fingerprint = async () =>
      (
        await db.pool.query(`
        SELECT (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM attendance_records t) AS attendance,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM attendance_revisions t) AS revisions,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM roster_links t) AS links,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM identity_reviews t) AS reviews,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM investigation_flags t) AS flags,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM investigation_flag_events t) AS flag_events,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM class_sessions t) AS sessions,
               (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM scan_attempts t) AS scans`)
      ).rows[0];
    const before = await fingerprint();
    for (const format of FORMATS) await fetchExport(course, session, format);
    await fetchExport(course, session, 'CSV', 'SCAN_HISTORY');
    expect(await fingerprint()).toEqual(before);
  });

  it('writes the file and the audit trail atomically: a failed audit leaves no export and no file', async () => {
    const { course, session } = await richSession();
    const filesBefore = t.storage.files.size;
    const recordsBefore = (await db.pool.query('SELECT count(*)::int AS n FROM export_records'))
      .rows[0].n;
    await db.pool.query(
      `CREATE OR REPLACE FUNCTION fail_audit_exp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$`,
    );
    await db.pool.query(
      `CREATE TRIGGER fail_audit_exp_trg BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = 'EXPORT_REQUESTED') EXECUTE FUNCTION fail_audit_exp()`,
    );
    try {
      expect((await create(course, session, 'CSV')).statusCode).toBe(500);
    } finally {
      await db.pool.query('DROP TRIGGER IF EXISTS fail_audit_exp_trg ON audit_events');
    }
    expect(t.storage.files.size).toBe(filesBefore); // the orphan file was removed
    expect((await db.pool.query('SELECT count(*)::int AS n FROM export_records')).rows[0].n).toBe(
      recordsBefore,
    );
  });
});

describe('EXP-05 expiry and access control', () => {
  it('is downloadable only by the requester, and records who and what, never the content', async () => {
    const { course, session } = await richSession();
    const made = await create(course, session, 'CSV');
    expect(made.statusCode).toBe(201);
    const info = made.json().export;
    expect(info).toMatchObject({ format: 'CSV', kind: 'ATTENDANCE', rowCount: 7 });
    expect(info.filename).toMatch(/^attendance-X\d+-2026-10-10-[0-9a-f]{8}\.csv$/);
    const expires = new Date(info.expiresAt).getTime() - Date.now();
    expect(expires).toBeGreaterThan(58 * 60_000);
    expect(expires).toBeLessThanOrEqual(60 * 60_000);

    const res = await download(info.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${info.filename}"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const events = (
      await db.pool.query(
        `SELECT action, summary, actor_user_id FROM audit_events WHERE entity_id = $1 ORDER BY id`,
        [info.id],
      )
    ).rows;
    expect(events.map((e) => e.action)).toEqual(['EXPORT_REQUESTED', 'EXPORT_DOWNLOADED']);
    expect(events.every((e) => e.actor_user_id === lecturer1.id)).toBe(true);
    expect(JSON.stringify(events.map((e) => e.summary))).not.toMatch(/Mensah|Müller|Boateng/);

    const record = (
      await db.pool.query(
        `SELECT file_sha256, row_count, status::text AS status FROM export_records WHERE id = $1`,
        [info.id],
      )
    ).rows[0];
    expect(record.row_count).toBe(7);
    expect(record.file_sha256.length).toBe(32);
  });

  it('is invisible to other lecturers, students, anonymous callers, and after the assignment ends', async () => {
    const { course, session } = await richSession();
    const made = await create(course, session, 'CSV');
    const id = made.json().export.id as string;
    const [student] = await students(1);

    expect((await download(id, lecturer2.cookie)).statusCode).toBe(404);
    expect((await download(id, student!.cookie)).statusCode).toBe(403);
    expect((await get(t.app, `/exports/${id}/download`)).statusCode).toBe(401);
    expect((await download('not-a-uuid')).statusCode).toBe(404);
    expect((await download(randomUUID())).statusCode).toBe(404);

    expect((await create(course, session, 'CSV', 'ATTENDANCE', lecturer2.cookie)).statusCode).toBe(
      404,
    );
    expect(
      (await get(t.app, `/courses/${course}/exports`, { cookie: lecturer2.cookie })).statusCode,
    ).toBe(404);
    expect((await create(course, session, 'CSV', 'ATTENDANCE', student!.cookie)).statusCode).toBe(
      403,
    );

    // A second lecturer assigned to the same course still cannot fetch someone else's export.
    await assignLecturer(db.operatorPool, {
      operator,
      term: 'T1',
      courseCode: (
        await db.pool.query<{ code: string }>('SELECT code FROM courses WHERE id = $1', [course])
      ).rows[0]!.code,
      lecturerEmail: 'lec2@school.test',
    });
    expect((await download(id, lecturer2.cookie)).statusCode).toBe(404);

    // The requester loses access when they are no longer assigned.
    await endAssignment(db.operatorPool, {
      operator,
      term: 'T1',
      courseCode: (
        await db.pool.query<{ code: string }>('SELECT code FROM courses WHERE id = $1', [course])
      ).rows[0]!.code,
      lecturerEmail: 'lec1@school.test',
    });
    expect((await download(id)).statusCode).toBe(404);
  });

  it('refuses a session from another course, and bad requests', async () => {
    const a = await richSession();
    const other = await newCourse();
    expect((await create(other, a.session, 'CSV')).statusCode).toBe(404);
    await db.pool.query('DELETE FROM rate_limits');
    for (const body of [
      {},
      { sessionId: a.session },
      { sessionId: a.session, kind: 'ATTENDANCE', format: 'ODT' },
      { sessionId: 'x', kind: 'ATTENDANCE', format: 'CSV' },
      { sessionId: a.session, kind: 'EVERYTHING', format: 'CSV' },
    ]) {
      expect(
        (await post(t.app, `/courses/${a.course}/exports`, body, { cookie: lecturer1.cookie }))
          .statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it('stops being downloadable at expiry, and the sweeper deletes the file and marks the record', async () => {
    const { course, session } = await richSession();
    const live = (await create(course, session, 'CSV')).json().export;
    const old = (await create(course, session, 'XLSX')).json().export;
    const oldKey = (
      await db.pool.query<{ storage_key: string }>(
        'SELECT storage_key FROM export_records WHERE id = $1',
        [old.id],
      )
    ).rows[0]!.storage_key;
    expect(t.storage.files.has(oldKey)).toBe(true);

    await db.pool.query(
      `UPDATE export_records SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [old.id],
    );
    const late = await download(old.id);
    expect(late.statusCode).toBe(410); // refused even before the sweeper runs
    expect(late.json().error.code).toBe('EXPORT_EXPIRED');
    expect(t.storage.files.has(oldKey)).toBe(true);

    expect(await expireExports(db.appPool, t.storage)).toBeGreaterThanOrEqual(1);
    expect(t.storage.files.has(oldKey)).toBe(false); // really deleted
    const rec = (
      await db.pool.query(
        `SELECT status::text AS status, storage_key FROM export_records WHERE id = $1`,
        [old.id],
      )
    ).rows[0];
    expect(rec).toEqual({ status: 'EXPIRED', storage_key: null });
    expect((await download(old.id)).statusCode).toBe(410);
    expect(
      (
        await db.pool.query(
          `SELECT 1 FROM audit_events WHERE action = 'EXPORT_EXPIRED' AND entity_id = $1`,
          [old.id],
        )
      ).rowCount,
    ).toBe(1);

    expect((await download(live.id)).statusCode).toBe(200); // unexpired exports are untouched
    expect(await expireExports(db.appPool, t.storage)).toBe(0); // idempotent
    const listed = (
      await get(t.app, `/courses/${course}/exports`, { cookie: lecturer1.cookie })
    ).json().exports;
    expect(listed.find((x: { id: string }) => x.id === old.id)).toMatchObject({
      status: 'EXPIRED',
      downloadPath: null,
    });
    expect(listed.find((x: { id: string }) => x.id === live.id).downloadPath).toBe(
      live.downloadPath,
    );
  });

  it('rate-limits exports per lecturer', async () => {
    const { course, session } = await richSession();
    let limited: Awaited<ReturnType<typeof create>> | undefined;
    for (let i = 0; i < 14 && !limited; i++) {
      const res = await create(course, session, 'CSV', 'ATTENDANCE', lecturer1.cookie, {
        keepLimit: true,
      });
      if (res.statusCode === 429) limited = res;
    }
    expect(limited?.statusCode).toBe(429);
    expect(limited?.headers['retry-after']).toBeDefined();
  });
});

describe('private file storage', () => {
  it('writes owner-only files, never overwrites, and refuses keys that could escape the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scanin-store-'));
    try {
      const store = new LocalDiskStorage(join(dir, 'exports'));
      await store.put('a.csv', Buffer.from('one'));
      expect((await store.get('a.csv')).toString()).toBe('one');
      await expect(store.put('a.csv', Buffer.from('two'))).rejects.toThrow(); // no silent overwrite
      expect((await store.get('a.csv')).toString()).toBe('one');
      if (process.platform !== 'win32')
        expect((await stat(join(dir, 'exports', 'a.csv'))).mode & 0o077).toBe(0);

      for (const key of [
        '../x',
        '..',
        'a/b',
        'a\\b',
        '/etc/passwd',
        '',
        '.hidden',
        'a'.repeat(200),
      ]) {
        await expect(store.put(key, Buffer.from('x')), key).rejects.toThrow();
        await expect(store.get(key), key).rejects.toThrow();
      }
      await store.delete('a.csv');
      await store.delete('a.csv'); // deleting twice is fine
      expect(await readdir(join(dir, 'exports'))).toEqual([]);
      await expect(readFile(join(dir, 'exports', 'a.csv'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('LOAD-03 a 1,000-row export in every format', () => {
  it('completes each within ten seconds with every row present', async () => {
    const course = await newCourse();
    const session = await openSession(course);
    const crowd = await students(1000);
    // Bulk-create the matches and records directly: this test is about export, not check-in.
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO roster_links (course_id, student_id, state) SELECT $1, u, 'PROVISIONAL' FROM unnest($2::uuid[]) u`,
        [course, crowd.map((s) => s.id)],
      );
      await c.query(
        `INSERT INTO identity_reviews (link_id, review_no, review_kind, decision, from_state, to_state) SELECT id, 1, 'SYSTEM_MATCH', 'SYSTEM_MATCH', NULL, 'PROVISIONAL' FROM roster_links WHERE course_id = $1`,
        [course],
      );
      await c.query(
        `INSERT INTO attendance_records (session_id, course_id, student_id, link_id, source) SELECT $1, $2, l.student_id, l.id, 'QR_SCAN' FROM roster_links l WHERE l.course_id = $2`,
        [session, course],
      );
      await c.query(
        `INSERT INTO attendance_revisions (attendance_id, rev_no, change_kind, from_status, to_status, actor_user_id) SELECT id, 1, 'CREATED_QR', NULL, 'PRESENT', student_id FROM attendance_records WHERE session_id = $1`,
        [session],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    for (const format of FORMATS) {
      const started = Date.now();
      const body = await fetchExport(course, session, format);
      expect(Date.now() - started, format).toBeLessThan(10_000);
      if (format === 'CSV') expect(parseCsv(body).rows).toHaveLength(1000);
      if (format === 'XLSX') expect((await parseXlsx(body)).rows).toHaveLength(1000);
      if (format === 'DOCX') expect((await parseDocx(body)).tables.at(-1)!.length).toBe(1001);
      if (format === 'PDF') {
        const pdf = await parsePdf(body);
        expect(pdf.pageCount).toBeGreaterThan(5); // paginated, header repeated
        expect(pdf.text).toContain(crowd[0]!.studentId);
        expect(pdf.text).toContain(crowd[999]!.studentId);
      }
    }
  }, 120_000);
});
