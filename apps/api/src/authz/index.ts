import type { Role } from '@scanin/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';

/**
 * Central authorization. Every route MUST declare `config.authz`; a route that does not fails
 * application start-up, so a forgotten check cannot ship. Rules are enforced here, before any
 * handler runs:
 *   401  no valid session
 *   403  authenticated, but the role is not allowed
 *   404  lecturer not (or no longer) assigned to the course in the path, or no such course
 *        (deliberately identical, so resource existence is not leaked)
 */
export type AuthzSpec =
  | { public: true }
  | {
      roles: readonly Role[];
      /** Name of the route parameter holding a course id; lecturers must be assigned to it. */
      course?: string;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    authz?: AuthzSpec;
  }
  interface FastifyInstance {
    /** Every registered route and its authorization rule, for tests and documentation. */
    authzRoutes: Array<{ method: string; url: string; spec: AuthzSpec }>;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ANY_ROLE: readonly Role[] = ['LECTURER', 'STUDENT'];
export const LECTURER_ONLY: readonly Role[] = ['LECTURER'];
export const STUDENT_ONLY: readonly Role[] = ['STUDENT'];

function deny(reply: FastifyReply, status: 401 | 403 | 404): FastifyReply {
  const body =
    status === 401
      ? { code: 'UNAUTHENTICATED', message: 'Please sign in.' }
      : status === 403
        ? { code: 'FORBIDDEN', message: 'You do not have access to this.' }
        : { code: 'NOT_FOUND', message: 'Not found.' };
  return reply.code(status).send({ error: body });
}

/** True if the lecturer has an active assignment to the course. */
export async function isAssignedLecturer(
  pool: pg.Pool,
  lecturerId: string,
  courseId: string,
): Promise<boolean> {
  if (!UUID.test(courseId)) return false;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM lecturer_courses
      WHERE course_id = $1 AND lecturer_id = $2 AND ended_at IS NULL`,
    [courseId, lecturerId],
  );
  return (rowCount ?? 0) > 0;
}

/** Must be called before any route is registered. */
export function registerAuthorization(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  const registry: Array<{ method: string; url: string; spec: AuthzSpec }> = [];
  app.decorate('authzRoutes', registry);

  app.addHook('onRoute', (route) => {
    const spec = route.config?.authz;
    if (!spec) {
      throw new Error(`Route ${String(route.method)} ${route.url} must declare config.authz`);
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) registry.push({ method: String(method), url: route.url, spec });
  });

  app.addHook('preHandler', async (req, reply) => {
    const spec = req.routeOptions.config?.authz;
    if (!spec || 'public' in spec) return; // not found handler, or an explicitly public route

    const auth = req.auth;
    if (!auth) return deny(reply, 401);
    if (!spec.roles.includes(auth.role)) return deny(reply, 403);

    if (spec.course) {
      const courseId = (req.params as Record<string, string | undefined>)[spec.course];
      if (
        auth.role !== 'LECTURER' ||
        !courseId ||
        !(await isAssignedLecturer(deps.pool, auth.userId, courseId))
      ) {
        return deny(reply, 404);
      }
    }
  });
}
