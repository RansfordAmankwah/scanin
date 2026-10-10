import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { LECTURER_ONLY } from '../authz/index.js';
import {
  createSession,
  endSession,
  extendSession,
  getSession,
  listSessions,
  SessionError,
  startSession,
} from './service.js';

const COURSE_ROUTE = { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  sessionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const ExtendBody = z.object({
  minutes: z.number().int().min(1).max(120),
  reason: z.string().trim().min(3).max(500),
  expectedDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/),
});

function handle(reply: FastifyReply, err: unknown) {
  if (err instanceof SessionError) {
    return reply
      .code(err.status)
      .send({ error: { code: err.code, message: err.message, state: err.state } });
  }
  throw err;
}

const invalid = (reply: FastifyReply) =>
  reply
    .code(400)
    .send({ error: { code: 'INVALID_REQUEST', message: 'Check the request and try again.' } });

export function registerSessionRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const { pool } = deps;

  /** A session id that is malformed or belongs to another course is simply "not found". */
  const ids = (req: { params: unknown }) => req.params as { courseId: string; sessionId: string };
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });

  app.get('/courses/:courseId/sessions', COURSE_ROUTE, async (req) => {
    const { courseId } = req.params as { courseId: string };
    return { sessions: await listSessions(pool, courseId) };
  });

  app.post('/courses/:courseId/sessions', COURSE_ROUTE, async (req, reply) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) return invalid(reply);
    const { courseId } = req.params as { courseId: string };
    const actorId = req.auth?.userId as string;
    try {
      const session = await createSession(pool, { courseId, actorId, ...body.data });
      return reply.code(201).send({ session });
    } catch (err) {
      // e.g. an impossible calendar date such as 2026-02-31
      if ((err as { code?: string }).code === '22008') return invalid(reply);
      return handle(reply, err);
    }
  });

  app.get('/courses/:courseId/sessions/:sessionId', COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = ids(req);
    if (!UUID.test(sessionId)) return notFound(reply);
    try {
      return { session: await getSession(pool, courseId, sessionId) };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post('/courses/:courseId/sessions/:sessionId/start', COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = ids(req);
    if (!UUID.test(sessionId)) return notFound(reply);
    try {
      const session = await startSession(pool, {
        courseId,
        sessionId,
        actorId: req.auth?.userId as string,
      });
      return { session };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post('/courses/:courseId/sessions/:sessionId/extend', COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = ids(req);
    if (!UUID.test(sessionId)) return notFound(reply);
    const body = ExtendBody.safeParse(req.body);
    if (!body.success) return invalid(reply);
    try {
      const session = await extendSession(pool, {
        courseId,
        sessionId,
        actorId: req.auth?.userId as string,
        ...body.data,
      });
      return { session };
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.post('/courses/:courseId/sessions/:sessionId/end', COURSE_ROUTE, async (req, reply) => {
    const { courseId, sessionId } = ids(req);
    if (!UUID.test(sessionId)) return notFound(reply);
    try {
      const session = await endSession(pool, {
        courseId,
        sessionId,
        actorId: req.auth?.userId as string,
      });
      return { session };
    } catch (err) {
      return handle(reply, err);
    }
  });
}
