import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Config } from '../../src/config.js';
import type { FaceVerifier } from '../../src/face/verifier.js';
import { assignLecturer, createCourse, createTerm } from '../../src/operator/commands.js';
import { mintToken, parseKeyring } from '../../src/qr/token.js';
import {
  APP_ORIGIN,
  TEST_CONFIG,
  createLecturerSession,
  createTestApp,
  freshIp,
  get,
  post,
  type TestApp,
} from '../helpers/app.js';
import { createBulkStudents, type BulkStudent } from '../helpers/students.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

const keyring = parseKeyring(TEST_CONFIG.QR_KEYS, TEST_CONFIG.QR_ACTIVE_KID);

export interface Harness {
  db: MigratedTestDatabase;
  t: TestApp;
  app: FastifyInstance;
  lecturer: { id: string; cookie: string };
  other: { id: string; cookie: string };
  courseId: string;
  otherCourseId: string;
  /** A brand-new course for the first lecturer (or, with 'other', the second), so a test starts clean. */
  newCourse(owner?: 'other'): Promise<string>;
  /** Creates and starts a session in `course` (default: the first lecturer's course). */
  openSession(course?: string): Promise<string>;
  /** Creates a session that has not been started. */
  newSession(course?: string): Promise<string>;
  /** Checks in `n` fresh students through the real endpoint, each from a different simulated phone. */
  checkInStudents(
    sessionId: string,
    n: number,
    opts?: { device?: () => string },
  ): Promise<BulkStudent[]>;
  /** One check-in request from a given device. */
  scan(student: BulkStudent, sessionId: string, deviceId?: string): Promise<LightMyRequestResponse>;
  put(url: string, payload: unknown, cookie?: string): Promise<LightMyRequestResponse>;
  post(url: string, payload: unknown, cookie?: string): Promise<LightMyRequestResponse>;
  get(url: string, cookie?: string): Promise<LightMyRequestResponse>;
  count(sql: string, params?: unknown[]): Promise<number>;
  audit(
    action: string,
    sessionId?: string,
  ): Promise<
    Array<{ actor_type: string; summary: Record<string, unknown>; entity_id: string | null }>
  >;
  /** Another API instance on the same database with different settings. */
  withConfig(overrides: Partial<Config>): Promise<TestApp>;
  close(): Promise<void>;
}

export async function createHarness(
  overrides: Partial<Config> = {},
  opts: { faceVerifier?: FaceVerifier } = {},
): Promise<Harness> {
  const db = await createMigratedTestDatabase();
  const t = await createTestApp(db, overrides, opts);
  const operator = 'antiproxy-test';
  await createTerm(db.operatorPool, {
    operator,
    name: 'T1',
    startsOn: '2026-09-01',
    endsOn: '2026-12-20',
  });
  const lecturer = await createLecturerSession(db, t.app, 'lec1@school.test');
  const other = await createLecturerSession(db, t.app, 'lec2@school.test');
  const owners = new Map<string, 'other' | undefined>();
  const course = async (code: string, email: string) => {
    const { id } = await createCourse(db.operatorPool, { operator, term: 'T1', code, title: code });
    await assignLecturer(db.operatorPool, {
      operator,
      term: 'T1',
      courseCode: code,
      lecturerEmail: email,
    });
    owners.set(id, email === 'lec2@school.test' ? 'other' : undefined);
    return id;
  };
  let courseCounter = 0;
  const courseId = await course('AP1', 'lec1@school.test');
  const otherCourseId = await course('AP2', 'lec2@school.test');

  const send = (method: 'PUT', url: string, payload: unknown, cookie?: string) =>
    t.app.inject({
      method,
      url,
      payload: payload as object,
      headers: {
        origin: APP_ORIGIN,
        'x-requested-with': 'scanin',
        ...(cookie ? { cookie } : {}),
      },
      remoteAddress: freshIp(),
    });

  const nowMs = async () =>
    Number(
      (
        await db.pool.query<{ ms: string }>(
          `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`,
        )
      ).rows[0]!.ms,
    );

  const h: Harness = {
    db,
    t,
    app: t.app,
    lecturer,
    other,
    courseId,
    otherCourseId,
    async newCourse(owner) {
      courseCounter += 1;
      return course(
        `NC${courseCounter}`,
        owner === 'other' ? 'lec2@school.test' : 'lec1@school.test',
      );
    },
    async newSession(c = courseId) {
      const owner = owners.get(c) === 'other' ? other : lecturer;
      const res = await post(
        t.app,
        `/courses/${c}/sessions`,
        { title: 'Lecture' },
        { cookie: owner.cookie },
      );
      return res.json().session.id as string;
    },
    async openSession(c = courseId) {
      const owner = owners.get(c) === 'other' ? other : lecturer;
      const id = await h.newSession(c);
      await post(t.app, `/courses/${c}/sessions/${id}/start`, {}, { cookie: owner.cookie });
      return id;
    },
    scan(student, sessionId, deviceId = randomUUID()) {
      // The code is minted straight from the server's keys, exactly as the lecturer's display would.
      return nowMs().then((ms) =>
        post(
          t.app,
          '/checkins',
          {
            token: mintToken(keyring, sessionId, ms).token,
            clientAttemptId: randomUUID(),
            deviceId,
          },
          { cookie: student.cookie, ip: freshIp() },
        ),
      );
    },
    async checkInStudents(sessionId, n, opts = {}) {
      const students = await createBulkStudents(db, n);
      for (const s of students) {
        const res = await h.scan(s, sessionId, opts.device?.());
        if (res.statusCode !== 201)
          throw new Error(`check-in failed: ${res.statusCode} ${res.body}`);
      }
      return students;
    },
    put: (url, payload, cookie = lecturer.cookie) => send('PUT', url, payload, cookie),
    post: (url, payload, cookie = lecturer.cookie) => post(t.app, url, payload, { cookie }),
    get: (url, cookie = lecturer.cookie) => get(t.app, url, { cookie }),
    async count(sql, params = []) {
      return (
        await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)
      ).rows[0]!.n;
    },
    async audit(action, sessionId) {
      const { rows } = await db.pool.query(
        `SELECT actor_type::text AS actor_type, summary, entity_id FROM audit_events
          WHERE action = $1 AND ($2::uuid IS NULL OR session_id = $2) ORDER BY id`,
        [action, sessionId ?? null],
      );
      return rows;
    },
    withConfig: (o) => createTestApp(db, o),
    async close() {
      await t.close();
      await db.drop();
    },
  };
  return h;
}

export const base = (courseId: string, sessionId: string) =>
  `/courses/${courseId}/sessions/${sessionId}`;
