import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { LECTURER_ONLY } from '../authz/index.js';
import { suggestCandidates } from './matching.js';
import { applyImport, listRoster, previewImport, RosterError } from './service.js';

const COURSE_ROUTE = { config: { authz: { roles: LECTURER_ONLY, course: 'courseId' } } };
const IMPORT_ROUTE = { ...COURSE_ROUTE, bodyLimit: 2 * 1024 * 1024 };

const PreviewBody = z.object({ csv: z.string().min(1).max(1_000_000) });
const ApplyBody = PreviewBody.extend({
  previewToken: z.string().length(64),
  retireEntryIds: z.array(z.string().uuid()).max(5000).default([]),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof RosterError) {
    return reply
      .code(err.status)
      .send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  throw err;
}

export function registerRosterRoutes(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const { pool } = deps;

  app.get('/courses/:courseId/roster', COURSE_ROUTE, async (req) => {
    const { courseId } = req.params as { courseId: string };
    return listRoster(pool, courseId);
  });

  /** Shows what importing a file would change. Writes nothing. */
  app.post('/courses/:courseId/roster/preview', IMPORT_ROUTE, async (req, reply) => {
    const body = PreviewBody.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Provide the roster CSV.' } });
    }
    const { courseId } = req.params as { courseId: string };
    try {
      return await previewImport(pool, courseId, body.data.csv);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /** Applies a previewed import. Entries missing from the file are only retired if listed. */
  app.post('/courses/:courseId/roster/apply', IMPORT_ROUTE, async (req, reply) => {
    const body = ApplyBody.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_REQUEST', message: 'Check the request and try again.' } });
    }
    const { courseId } = req.params as { courseId: string };
    const actorId = req.auth?.userId;
    if (!actorId)
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
    try {
      return await applyImport(pool, {
        courseId,
        actorId,
        csv: body.data.csv,
        previewToken: body.data.previewToken,
        retireEntryIds: body.data.retireEntryIds,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Roster entries whose names resemble a linked student's self-reported name. A suggestion only:
   * nothing is linked until a lecturer decides.
   */
  app.get('/courses/:courseId/links/:linkId/suggestions', COURSE_ROUTE, async (req, reply) => {
    const { courseId, linkId } = req.params as { courseId: string; linkId: string };
    const notFound = () =>
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    if (!UUID.test(linkId)) return notFound();
    const { rows } = await pool.query<{ full_name: string }>(
      `SELECT u.full_name FROM roster_links l JOIN users u ON u.id = l.student_id
        WHERE l.id = $1 AND l.course_id = $2`,
      [linkId, courseId],
    );
    const name = rows[0]?.full_name;
    if (!name) return notFound();
    const candidates = await suggestCandidates(pool, courseId, name);
    return {
      suggestionOnly: true,
      candidates: candidates.map((c) => ({
        entryId: c.id,
        studentId: c.student_id_norm,
        fullName: c.full_name,
        similarity: Math.round(c.score * 100) / 100,
      })),
    };
  });
}
