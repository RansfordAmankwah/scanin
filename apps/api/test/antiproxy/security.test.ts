import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeCourse } from '../../src/retention/service.js';
import { createBulkStudents } from '../helpers/students.js';
import { base, createHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

/** Runs the whole workflow once, in a course of its own, so the later checks have real rows to look at. */
async function fullWorkflow(): Promise<{ s: string; student: string; studentCookie: string }> {
  const s = await h.openSession();
  const students = await h.checkInStudents(s, 12);
  await h.put(`${base(h.courseId, s)}/headcount`, { headcount: 5 }); // flagged
  await h.put(`${base(h.courseId, s)}/headcount`, { headcount: 11, explanation: 'Missed a row' }); // cleared
  await h.put(`${base(h.courseId, s)}/headcount`, { headcount: 4 }); // flagged again
  await h.post(`${base(h.courseId, s)}/reconciliation/notes`, {
    note: 'Several left before I counted',
  });
  const listing = (await h.post(`${base(h.courseId, s)}/spot-checks`, { size: 2 })).json();
  const [first, second] = listing.rounds[0].items;
  await h.post(`${base(h.courseId, s)}/spot-checks/items/${second.id}/result`, {
    requestId: randomUUID(),
    outcome: 'VERIFIED',
    method: 'ROSTER_PHOTO',
  });
  const missing = await h.post(`${base(h.courseId, s)}/spot-checks/items/${first.id}/result`, {
    requestId: randomUUID(),
    outcome: 'NOT_PRESENT',
    explanation: 'Not in the room after two calls.',
  });
  const dispute = missing.json().rounds[0].items.find((i: { id: string }) => i.id === first.id)
    .disputeId as string;
  const owner = (
    await h.db.pool.query('SELECT student_id FROM spot_check_items WHERE id = $1', [first.id])
  ).rows[0]!.student_id as string;
  const student = students.find((x) => x.id === owner)!;
  await h.post(
    `/me/disputes/${dispute}/response`,
    { note: 'I was there, please ask the row behind me.' },
    student.cookie,
  );
  await h.post(`${base(h.courseId, s)}/disputes/${dispute}/resolve`, {
    resolution: 'INVALIDATE',
    category: 'IDENTITY_ENROLLMENT_MISMATCH',
    explanation: 'Could not be matched to anyone in the room.',
  });
  return { s, student: student.id, studentCookie: student.cookie };
}

describe('audit trail', () => {
  it('records every consequential action, by its actor, in the course’s retention window', async () => {
    const { s } = await fullWorkflow();
    const expected: Array<[string, string]> = [
      ['HEADCOUNT_RECORDED', 'LECTURER'],
      ['HEADCOUNT_CORRECTED', 'LECTURER'],
      ['RECONCILIATION_FLAGGED', 'LECTURER'],
      ['RECONCILIATION_CLEARED', 'LECTURER'],
      ['RECONCILIATION_NOTE_ADDED', 'LECTURER'],
      ['SPOT_CHECK_GENERATED', 'LECTURER'],
      ['SPOT_CHECK_RESULT_RECORDED', 'LECTURER'],
      ['DISPUTE_OPENED', 'LECTURER'],
      ['DISPUTE_STUDENT_RESPONDED', 'STUDENT'],
      ['DISPUTE_RESOLVED', 'LECTURER'],
      ['ATTENDANCE_INVALIDATED', 'LECTURER'],
    ];
    for (const [action, actor] of expected) {
      const rows = await h.audit(action, s);
      expect(rows.length, action).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.actor_type === actor),
        action,
      ).toBe(true);
    }
    expect(await h.audit('RECONCILIATION_FLAGGED', s)).toHaveLength(2); // flagged, cleared, flagged again
    const missingRetention = await h.count(
      `SELECT 1 FROM audit_events WHERE session_id = $1 AND class = 'DOMAIN' AND retain_until IS NULL`,
      [s],
    );
    expect(missingRetention).toBe(0);
  });

  it('never writes credentials, tokens or device ids into it', async () => {
    const { s } = await fullWorkflow();
    const rows = (
      await h.db.pool.query(
        `SELECT action, summary::text AS summary, entity_id FROM audit_events WHERE session_id = $1`,
        [s],
      )
    ).rows;
    const blob = JSON.stringify(rows).toLowerCase();
    for (const forbidden of [
      'cookie',
      'password',
      'secret',
      'authorization',
      'st1.',
      'hash',
      'deviceid',
      'sid=',
    ]) {
      expect(blob, forbidden).not.toContain(forbidden);
    }
    // The spot-check rationale names items and reasons, never students' names or e-mails.
    const generated = rows.find((r) => r.action === 'SPOT_CHECK_GENERATED')!;
    expect(generated.summary).not.toMatch(/@|Bulk Student/);
  });

  it('cannot be edited or deleted through the application, and neither can the history behind it', async () => {
    await fullWorkflow();
    const attacks = [
      `UPDATE audit_events SET action = 'x'`,
      `DELETE FROM audit_events`,
      `UPDATE session_headcounts SET headcount = 0`,
      `DELETE FROM session_headcounts`,
      `UPDATE reconciliation_notes SET note = 'edited'`,
      `UPDATE spot_check_events SET explanation = 'edited'`,
      `DELETE FROM spot_check_events`,
      `UPDATE attendance_dispute_events SET note = 'edited'`,
      `DELETE FROM attendance_dispute_events`,
      `UPDATE spot_check_items SET student_id = student_id`,
      `UPDATE attendance_disputes SET student_id = student_id`,
      `DELETE FROM attendance_disputes`,
      `DELETE FROM spot_check_items`,
      `UPDATE attendance_records SET recorded_at = now()`,
    ];
    for (const sql of attacks) {
      await expect(h.db.appPool.query(sql), sql).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('access control', () => {
  it('keeps one lecturer out of another’s sessions on every anti-proxy route', async () => {
    const mine = await h.openSession();
    await h.checkInStudents(mine, 3);
    const theirs = await h.openSession(h.otherCourseId);
    const item = (await h.post(`${base(h.courseId, mine)}/spot-checks`, { size: 1 })).json()
      .rounds[0].items[0];

    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `${base(h.courseId, mine)}/reconciliation`],
      ['PUT', `${base(h.courseId, mine)}/headcount`, { headcount: 1 }],
      ['POST', `${base(h.courseId, mine)}/reconciliation/notes`, { note: 'Not yours to write on' }],
      ['GET', `${base(h.courseId, mine)}/spot-checks`],
      ['POST', `${base(h.courseId, mine)}/spot-checks`, { size: 1 }],
      [
        'POST',
        `${base(h.courseId, mine)}/spot-checks/items/${item.id}/result`,
        { requestId: randomUUID(), outcome: 'VERIFIED', method: 'STUDENT_ID_CARD' },
      ],
      ['GET', `${base(h.courseId, mine)}/disputes`],
      // Right lecturer and course, but another course's session id.
      ['GET', `${base(h.courseId, theirs)}/reconciliation`],
      ['PUT', `${base(h.courseId, theirs)}/headcount`, { headcount: 1 }],
      ['POST', `${base(h.courseId, theirs)}/spot-checks`, { size: 1 }],
    ];
    const statuses = new Set<number>();
    for (const [method, url, body] of attempts) {
      const asOther =
        method === 'GET'
          ? await h.get(url, h.other.cookie)
          : method === 'PUT'
            ? await h.put(url, body, h.other.cookie)
            : await h.post(url, body, h.other.cookie);
      const asMe = url.includes(theirs)
        ? method === 'GET'
          ? await h.get(url)
          : method === 'PUT'
            ? await h.put(url, body)
            : await h.post(url, body)
        : null;
      expect(asOther.statusCode, `${method} ${url} as the other lecturer`).toBe(404);
      statuses.add(asOther.statusCode);
      if (asMe) expect(asMe.statusCode, `${method} ${url} with the wrong session`).toBe(404);
    }
    expect([...statuses]).toEqual([404]); // existence is never revealed
    expect(
      await h.count('SELECT 1 FROM session_headcounts WHERE session_id = ANY($1::uuid[])', [
        [mine, theirs],
      ]),
    ).toBe(0);
    expect(await h.count('SELECT 1 FROM spot_check_events WHERE item_id = $1', [item.id])).toBe(0);
  });

  it('keeps students out of every lecturer-only anti-proxy route', async () => {
    const s = await h.openSession();
    const [stu] = await h.checkInStudents(s, 1);
    const item = (await h.post(`${base(h.courseId, s)}/spot-checks`, { size: 1 })).json().rounds[0]
      .items[0];
    for (const [method, url, body] of [
      ['GET', `${base(h.courseId, s)}/reconciliation`, undefined],
      ['PUT', `${base(h.courseId, s)}/headcount`, { headcount: 1 }],
      ['POST', `${base(h.courseId, s)}/reconciliation/notes`, { note: 'A student writing a note' }],
      ['GET', `${base(h.courseId, s)}/spot-checks`, undefined],
      ['POST', `${base(h.courseId, s)}/spot-checks`, { size: 1 }],
      [
        'POST',
        `${base(h.courseId, s)}/spot-checks/items/${item.id}/result`,
        { requestId: randomUUID(), outcome: 'VERIFIED', method: 'STUDENT_ID_CARD' },
      ],
      ['GET', `${base(h.courseId, s)}/disputes`, undefined],
      [
        'POST',
        `${base(h.courseId, s)}/disputes/${randomUUID()}/resolve`,
        { resolution: 'UPHOLD', explanation: 'A student resolving it' },
      ],
    ] as Array<[string, string, unknown]>) {
      const res =
        method === 'GET'
          ? await h.get(url, stu!.cookie)
          : method === 'PUT'
            ? await h.put(url, body, stu!.cookie)
            : await h.post(url, body, stu!.cookie);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await h.count('SELECT 1 FROM spot_check_events WHERE item_id = $1', [item.id])).toBe(0);
  });

  it('keeps a lecturer out of the student endpoint, and signed-out callers out of everything', async () => {
    const res = await h.post(`/me/disputes/${randomUUID()}/response`, {
      note: 'A lecturer replying',
    });
    expect(res.statusCode).toBe(403);
    const s = await h.openSession();
    for (const url of [
      `${base(h.courseId, s)}/reconciliation`,
      `${base(h.courseId, s)}/spot-checks`,
      `${base(h.courseId, s)}/disputes`,
    ]) {
      expect(
        (await h.app.inject({ method: 'GET', url, remoteAddress: '10.9.9.9' })).statusCode,
      ).toBe(401);
    }
    expect(
      (await h.post('/me/disputes/' + randomUUID() + '/response', { note: 'x' }, '')).statusCode,
    ).toBe(401);
  });

  it('refuses a cross-site write (no same-origin headers) like every other endpoint', async () => {
    const s = await h.openSession();
    const res = await h.app.inject({
      method: 'PUT',
      url: `${base(h.courseId, s)}/headcount`,
      payload: { headcount: 3 },
      headers: {
        cookie: h.lecturer.cookie,
        origin: 'https://evil.example',
        'x-requested-with': 'scanin',
      },
      remoteAddress: '10.9.9.8',
    });
    expect(res.statusCode).toBe(403);
    expect(await h.count('SELECT 1 FROM session_headcounts WHERE session_id = $1', [s])).toBe(0);
  });
});

describe('errors do not reveal internals', () => {
  it('answers an unexpected database failure with a fixed message and a request id', async () => {
    const s = await h.openSession();
    await h.db.pool.query(`
      CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'secret_table_name exploded'; END $$;
      CREATE TRIGGER boom_trg BEFORE INSERT ON session_headcounts FOR EACH ROW EXECUTE FUNCTION boom();`);
    try {
      const res = await h.put(`${base(h.courseId, s)}/headcount`, { headcount: 3 });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(typeof res.json().error.requestId).toBe('string');
      for (const leak of [
        'secret_table_name',
        'exploded',
        'P0001',
        'session_headcounts',
        'stack',
        'pg',
      ]) {
        expect(res.body, leak).not.toContain(leak);
      }
      // The detail is in the server log for the operator, and the session cookie is not.
      const logs = h.t.logs();
      expect(logs).toContain('secret_table_name exploded');
      expect(logs).not.toContain(h.lecturer.cookie.split('=')[1]!);
    } finally {
      await h.db.pool.query('DROP TRIGGER boom_trg ON session_headcounts; DROP FUNCTION boom();');
    }
    expect(await h.count('SELECT 1 FROM session_headcounts WHERE session_id = $1', [s])).toBe(0);
  });

  it('gives malformed JSON a fixed client error rather than a parser message', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: `${base(h.courseId, await h.openSession())}/headcount`,
      payload: '{"headcount": ',
      headers: {
        cookie: h.lecturer.cookie,
        origin: 'https://app.scanin.test',
        'x-requested-with': 'scanin',
        'content-type': 'application/json',
      },
      remoteAddress: '10.9.9.7',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('The request could not be understood.');
  });
});

describe('retention', () => {
  it('deletes every anti-proxy record with its course, in dependency order', async () => {
    const { s } = await fullWorkflow();
    expect(
      await h.count('SELECT 1 FROM session_headcounts WHERE session_id = $1', [s]),
    ).toBeGreaterThan(0);
    await purgeCourse(h.db.retentionPool, h.courseId);
    for (const table of [
      'session_headcounts',
      'reconciliation_notes',
      'spot_checks',
      'spot_check_items',
      'spot_check_events',
      'attendance_disputes',
      'attendance_dispute_events',
      'attendance_records',
    ]) {
      expect(await h.count(`SELECT 1 FROM ${table}`), table).toBe(0);
    }
    // The other lecturer's course is untouched.
    expect(await h.count('SELECT 1 FROM courses WHERE id = $1', [h.otherCourseId])).toBe(1);
    void createBulkStudents;
  });
});
