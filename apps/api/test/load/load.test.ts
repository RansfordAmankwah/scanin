import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assignLecturer, createCourse, createTerm } from '../../src/operator/commands.js';
import { mintToken, parseKeyring } from '../../src/qr/token.js';
import {
  APP_ORIGIN,
  TEST_CONFIG,
  createLecturerSession,
  createTestApp,
  type TestApp,
} from '../helpers/app.js';
import { createBulkStudents } from '../helpers/students.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

/**
 * Load tests over real HTTP (a listening server and real sockets), not in-process injection, so
 * connection handling, serialisation and the connection pool are all in the measurement. The
 * numbers asserted come from the acceptance criteria: p95 latency, zero 5xx, exact counts.
 */
let db: MigratedTestDatabase;
let t: TestApp;
let base: string;
let lecturer: { id: string; cookie: string };
const operator = 'load-test';
const keyring = parseKeyring(TEST_CONFIG.QR_KEYS, TEST_CONFIG.QR_ACTIVE_KID);
let courseSeq = 0;
// Response bodies are inspected loosely in this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseJson = Record<string, any>;
// Acceptance thresholds (milliseconds). Override on a slower machine; never loosen in CI.
const P95_CHECKIN_MS = Number(process.env.LOAD_P95_CHECKIN_MS ?? 500);
const P95_DASHBOARD_MS = Number(process.env.LOAD_P95_DASHBOARD_MS ?? 300);
const END_MS = Number(process.env.LOAD_END_MS ?? 3000);

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  t = await createTestApp(db);
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const address = t.app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  await createTerm(db.operatorPool, {
    operator,
    name: 'T1',
    startsOn: '2026-09-01',
    endsOn: '2026-12-20',
  });
  lecturer = await createLecturerSession(db, t.app, 'lec@school.test');
});

beforeEach(async () => {
  // All simulated students share one address, so the per-address ceiling would otherwise accumulate across tests.
  await db.pool.query('DELETE FROM rate_limits');
});

afterAll(async () => {
  await t?.close();
  await db?.drop();
});

const HEADERS = {
  origin: APP_ORIGIN,
  'x-requested-with': 'scanin',
  'content-type': 'application/json',
};

/** Never throws: a transport failure is reported as status 0 so a test fails cleanly and finishes. */
async function http(method: 'GET' | 'POST', path: string, cookie: string, body?: unknown) {
  const started = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...HEADERS, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      ms: performance.now() - started,
      json: () => JSON.parse(text) as LooseJson,
    };
  } catch {
    return { status: 0, ms: performance.now() - started, json: () => ({}) as LooseJson };
  }
}

/** Writes a one-line summary to the console and to load-report.txt for the test run. */
function report(label: string, ms: number[], extra = ''): void {
  const line =
    `${label}: n=${ms.length} p50=${percentile(ms, 50).toFixed(0)}ms p95=${percentile(ms, 95).toFixed(0)}ms p99=${percentile(ms, 99).toFixed(0)}ms max=${Math.max(...ms).toFixed(0)}ms ${extra}`.trim();
  console.log(line);
  appendFileSync(join(tmpdir(), 'scanin-load-report.txt'), `${new Date().toISOString()} ${line}\n`);
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

async function openSession(): Promise<{ course: string; session: string; token: string }> {
  courseSeq += 1;
  const code = `LD${courseSeq}`;
  const { id: course } = await createCourse(db.operatorPool, {
    operator,
    term: 'T1',
    code,
    title: code,
  });
  await assignLecturer(db.operatorPool, {
    operator,
    term: 'T1',
    courseCode: code,
    lecturerEmail: 'lec@school.test',
  });
  const created = await http('POST', `/courses/${course}/sessions`, lecturer.cookie, {
    title: 'Big lecture',
  });
  const session = created.json().session.id as string;
  await http('POST', `/courses/${course}/sessions/${session}/start`, lecturer.cookie, {});
  const now = Number(
    (
      await db.pool.query<{ ms: string }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
      )
    ).rows[0]!.ms,
  );
  return { course, session, token: mintToken(keyring, session, now).token };
}

/**
 * Runs all tasks as fast as possible with at most `limit` in flight. A load balancer in front of
 * the app bounds simultaneous connections the same way; opening 500 sockets at once from one test
 * process only measures the operating system's connection backlog.
 */
async function burst<T>(
  count: number,
  limit: number,
  run: (i: number) => Promise<T>,
): Promise<T[]> {
  const out: T[] = new Array(count);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < count) {
        const i = next++;
        out[i] = await run(i);
      }
    }),
  );
  return out;
}

/** Runs `tasks` with at most `limit` in flight, starting each at its scheduled offset (ms). */
async function paced<T>(
  count: number,
  spreadMs: number,
  run: (i: number) => Promise<T>,
): Promise<T[]> {
  const started = performance.now();
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const at = (i / count) * spreadMs;
      const wait = at - (performance.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return run(i);
    }),
  );
}

describe('LOAD-01 a lecture hall scanning one code', () => {
  it('500 students over 20 s: p95 under 500 ms, no server errors, exactly 500 records', async () => {
    const { course, session, token } = await openSession();
    const crowd = await createBulkStudents(db, 500);
    const results = await paced(500, 20_000, (i) =>
      http('POST', '/checkins', crowd[i]!.cookie, {
        token,
        clientAttemptId: randomUUID(),
        deviceId: randomUUID(),
      }),
    );

    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(results.filter((r) => r.status === 201)).toHaveLength(500);
    const p95 = percentile(
      results.map((r) => r.ms),
      95,
    );
    report(
      'LOAD-01 500 students over 20s',
      results.map((r) => r.ms),
    );
    expect(p95, `p95 was ${p95.toFixed(0)} ms`).toBeLessThan(P95_CHECKIN_MS);

    const rows = (
      await db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1',
        [session],
      )
    ).rows[0]!.n;
    expect(rows).toBe(500);
    const roster = (
      await http('GET', `/courses/${course}/sessions/${session}/attendance`, lecturer.cookie)
    ).json();
    expect(roster.counts.presentTotal).toBe(500);
    expect(roster.counts.provisional).toBe(500);
  }, 120_000);

  it('a worst-case burst (500 requests, 50 connections at a time) still has no server errors and loses nothing', async () => {
    const { session, token } = await openSession();
    const crowd = await createBulkStudents(db, 500);
    const started = performance.now();
    const results = await burst(500, 50, (i) =>
      http('POST', '/checkins', crowd[i]!.cookie, {
        token,
        clientAttemptId: randomUUID(),
        deviceId: randomUUID(),
      }),
    );
    const seconds = (performance.now() - started) / 1000;

    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(results.filter((r) => r.status === 201)).toHaveLength(500);
    report(
      'LOAD-01 burst 500 (50 connections)',
      results.map((r) => r.ms),
      `total=${seconds.toFixed(1)}s`,
    );
    expect(seconds, `burst took ${seconds.toFixed(1)} s`).toBeLessThan(20);
    expect(
      (
        await db.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1',
          [session],
        )
      ).rows[0]!.n,
    ).toBe(500);
  }, 120_000);

  it('the lecturer can end the session in the middle of the burst, promptly, and nothing is accepted afterwards', async () => {
    const { course, session, token } = await openSession();
    const crowd = await createBulkStudents(db, 400);
    let endMs = Infinity;
    let endedAtResponse = 0;
    const ending = (async () => {
      for (;;) {
        const n = (
          await db.pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1',
            [session],
          )
        ).rows[0]!.n;
        if (n >= 100) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const res = await http(
        'POST',
        `/courses/${course}/sessions/${session}/end`,
        lecturer.cookie,
        {},
      );
      endMs = res.ms;
      endedAtResponse = (
        await db.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1',
          [session],
        )
      ).rows[0]!.n;
      return res;
    })();
    const scans = paced(400, 6_000, (i) =>
      http('POST', '/checkins', crowd[i]!.cookie, {
        token,
        clientAttemptId: randomUUID(),
        deviceId: randomUUID(),
      }),
    );
    const [endRes, results] = await Promise.all([ending, scans]);

    report('LOAD-01 End during burst', [endMs]);
    expect(endRes.status).toBe(200);
    expect(endMs, `End took ${endMs.toFixed(0)} ms`).toBeLessThan(END_MS);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    const tally: Record<number, number> = {};
    for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
    expect(
      Object.keys(tally).every((k) => k === '201' || k === '409'),
      `status counts: ${JSON.stringify(tally)}`,
    ).toBe(true);
    const finalCount = (
      await db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM attendance_records WHERE session_id = $1',
        [session],
      )
    ).rows[0]!.n;
    expect(finalCount).toBe(results.filter((r) => r.status === 201).length);
    expect(finalCount).toBeLessThan(400); // the rest were refused because the class had ended
    // Whatever was accepted was accepted before End returned: nothing slipped in afterwards.
    expect(finalCount).toBe(endedAtResponse);
    const late = await db.pool.query(
      `SELECT 1 FROM attendance_records a JOIN class_sessions s ON s.id = a.session_id WHERE a.session_id = $1 AND a.recorded_at >= s.ended_at`,
      [session],
    );
    expect(late.rowCount).toBe(0);
  }, 120_000);
});

describe('LOAD-02 lecturers watching live while students check in', () => {
  it('five classes at once: dashboard reads stay under 300 ms at p95', async () => {
    const classes = await Promise.all(Array.from({ length: 5 }, () => openSession()));
    const crowds = await Promise.all(classes.map(() => createBulkStudents(db, 80)));
    const reads: number[] = [];
    let scanning = true;

    const pollers = classes.map(async ({ course, session }) => {
      while (scanning) {
        const res = await http(
          'GET',
          `/courses/${course}/sessions/${session}/attendance`,
          lecturer.cookie,
        );
        expect(res.status).toBe(200);
        reads.push(res.ms);
        await new Promise((r) => setTimeout(r, 150));
      }
    });
    const scans = classes.flatMap((c, k) => crowds[k]!.map((s, i) => ({ c, s, i })));
    const results = await paced(scans.length, 8_000, (n) => {
      const { c, s } = scans[n]!;
      return http('POST', '/checkins', s.cookie, {
        token: c.token,
        clientAttemptId: randomUUID(),
        deviceId: randomUUID(),
      });
    });
    scanning = false;
    await Promise.all(pollers);

    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect(results.filter((r) => r.status === 201)).toHaveLength(400);
    expect(reads.length).toBeGreaterThan(50);
    const p95 = percentile(reads, 95);
    report('LOAD-02 dashboard reads (5 classes)', reads);
    expect(p95, `dashboard p95 was ${p95.toFixed(0)} ms over ${reads.length} reads`).toBeLessThan(
      P95_DASHBOARD_MS,
    );
    for (const { course, session } of classes) {
      const counts = (
        await http('GET', `/courses/${course}/sessions/${session}/attendance`, lecturer.cookie)
      ).json().counts;
      expect(counts.presentTotal).toBe(80);
    }
  }, 120_000);
});
