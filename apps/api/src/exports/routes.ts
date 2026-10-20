import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { hit } from '../auth/rateLimit.js';
import { LECTURER_ONLY } from '../authz/index.js';
import { createExport, downloadExport, ExportError, listExports } from './service.js';
import type { ExportStorage } from './storage.js';

const COURSE_ROUTE = { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Format = z.enum(['CSV', 'XLSX', 'PDF', 'DOCX']);
const Body = z.union([
  // A per-session report needs a session.
  z.object({
    kind: z.enum(['ATTENDANCE', 'SCAN_HISTORY']),
    sessionId: z.string().uuid(),
    format: Format,
  }),
  // The course-wide attendance grid has no single session.
  z.object({ kind: z.literal('ATTENDANCE_MATRIX'), format: Format }),
]);

const EXPORTS_PER_MINUTE = 5;

function handle(reply: FastifyReply, err: unknown) {
  if (err instanceof ExportError) {
    return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

export function registerExportRoutes(
  app: FastifyInstance,
  deps: { pool: pg.Pool; storage: ExportStorage; ttlMinutes: number },
): void {
  const { pool, storage, ttlMinutes } = deps;

  app.post('/courses/:courseId/exports', COURSE_ROUTE, async (req, reply) => {
    const { courseId } = req.params as { courseId: string };
    const actorId = req.auth?.userId as string;
    const limit = await hit(pool, `export:${actorId}`, 60);
    if (limit.count > EXPORTS_PER_MINUTE) {
      void reply.header('Retry-After', String(limit.retryAfterSeconds));
      return reply.code(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many exports. Wait a moment.',
          retryAfterSeconds: limit.retryAfterSeconds,
        },
      });
    }
    const body = Body.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'Choose a session, a report and a format.' },
      });
    }
    try {
      const summary = await createExport(pool, storage, {
        courseId,
        actorId,
        ttlMinutes,
        ...body.data,
      });
      return reply.code(201).send({ export: summary });
    } catch (err) {
      return handle(reply, err);
    }
  });

  app.get('/courses/:courseId/exports', COURSE_ROUTE, async (req) => {
    const { courseId } = req.params as { courseId: string };
    return { exports: await listExports(pool, courseId, req.auth?.userId as string) };
  });

  // Not course-scoped in the path: the service checks the requester, the course assignment and expiry.
  app.get(
    '/exports/:exportId/download',
    { config: { authz: { roles: LECTURER_ONLY } } },
    async (req, reply) => {
      const { exportId } = req.params as { exportId: string };
      if (!UUID.test(exportId))
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      try {
        const file = await downloadExport(pool, storage, {
          exportId,
          actorId: req.auth?.userId as string,
        });
        void reply
          .header('Content-Type', file.contentType)
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff');
        return reply.send(file.data);
      } catch (err) {
        return handle(reply, err);
      }
    },
  );
}
