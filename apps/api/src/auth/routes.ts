import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { ANY_ROLE } from '../authz/index.js';
import type { Config } from '../config.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { keyedHash, randomToken, sha256 } from './crypto.js';
import {
  displayStudentId,
  normalizeEmail,
  normalizeFullName,
  normalizeStudentId,
} from './identifiers.js';
import type { Mailer } from './mailer.js';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from './password.js';
import { hit, peek } from './rateLimit.js';
import {
  createSession,
  findSession,
  revokeAllSessions,
  revokeSession,
  type AuthContext,
} from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AuthDeps {
  config: Config;
  pool: pg.Pool;
  mailer: Mailer;
}

// Limits. Failed logins are counted per account and per IP in 15-minute fixed windows.
const LOGIN_WINDOW_S = 15 * 60;
const LOGIN_MAX_FAILURES_PER_ACCOUNT = 5;
const LOGIN_MAX_FAILURES_PER_IP = 30;
const REGISTER_WINDOW_S = 60 * 60;
const REGISTER_MAX_PER_IP = 10;
const PASSWORD_CHANGE_MAX_FAILURES = 5;

const VERIFICATION_TTL_HOURS = 24;

const PUBLIC = { config: { authz: { public: true as const } } };
const SIGNED_IN = { config: { authz: { roles: ANY_ROLE } } };

const COOKIE_NAME_SECURE = '__Host-sid';
const COOKIE_NAME_INSECURE = 'sid';

function fail(reply: FastifyReply, status: number, code: string, message: string, extra?: object) {
  return reply.code(status).send({ error: { code, message, ...extra } });
}

const RegisterBody = z.object({
  studentId: z.string().max(64),
  fullName: z.string().max(200),
  email: z.string().max(254).email(),
  password: z.string().max(1024),
});

const LecturerRegisterBody = z.object({
  fullName: z.string().max(200),
  email: z.string().max(254).email(),
  password: z.string().max(1024),
});

const CommitBody = RegisterBody.extend({ confirmed: z.literal(true) });

const LoginBody = z.object({ email: z.string().max(254), password: z.string().max(1024) });
const VerifyBody = z.object({ token: z.string().min(20).max(200) });
const ChangePasswordBody = z.object({
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
});

interface Normalized {
  studentId: string;
  studentIdDisplay: string;
  fullName: string;
  email: string;
  password: string;
}

function normalizeRegistration(
  body: z.infer<typeof RegisterBody>,
): { ok: true; value: Normalized } | { ok: false; code: string; message: string } {
  const studentId = normalizeStudentId(body.studentId);
  if (!studentId) {
    return { ok: false, code: 'INVALID_STUDENT_ID', message: 'Enter a valid student ID.' };
  }
  const fullName = normalizeFullName(body.fullName);
  if (!fullName) {
    return { ok: false, code: 'INVALID_NAME', message: 'Enter your full name.' };
  }
  const policy = checkPasswordPolicy(body.password);
  if (policy) {
    return { ok: false, code: policy, message: 'Choose a password of 10 to 128 characters.' };
  }
  return {
    ok: true,
    value: {
      studentId,
      studentIdDisplay: displayStudentId(body.studentId),
      fullName,
      email: normalizeEmail(body.email),
      password: body.password,
    },
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { config, pool, mailer } = deps;
  const secureCookies = !config.ALLOW_INSECURE_COOKIES;
  const cookieName = secureCookies ? COOKIE_NAME_SECURE : COOKIE_NAME_INSECURE;

  const ipHash = (req: FastifyRequest): Buffer => keyedHash(config.IP_HASH_SECRET, 'ip', req.ip);

  function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
    void reply.setCookie(cookieName, token, {
      path: '/',
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      maxAge: maxAgeSeconds,
    });
  }

  function clearSessionCookie(reply: FastifyReply): void {
    void reply.clearCookie(cookieName, {
      path: '/',
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
    });
  }

  // Resolve the session (if any) for every request.
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[cookieName];
    req.auth = token ? await findSession(pool, token) : null;
  });

  type NewAccount = {
    role: 'STUDENT' | 'LECTURER';
    email: string;
    fullName: string;
    password: string;
    studentId?: { norm: string; display: string };
  };

  /**
   * Creates the account and sends the verification e-mail. A duplicate e-mail looks exactly like
   * success (so the endpoint cannot be used to discover registered addresses); a duplicate student
   * ID is reported, because the student needs to know.
   */
  async function createAccount(
    req: FastifyRequest,
    hashedIp: Buffer,
    a: NewAccount,
  ): Promise<'CREATED' | 'STUDENT_ID_TAKEN'> {
    // Always hash, so every path costs the same time.
    const passwordHash = await hashPassword(a.password);
    const verificationToken = randomToken();

    try {
      await withTransaction(pool, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          // `email_verified_at` is not insertable by the application database role.
          `INSERT INTO users (role, email, full_name, student_id_norm, student_id_display, password_hash)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            a.role,
            a.email,
            a.fullName,
            a.studentId?.norm ?? null,
            a.studentId?.display ?? null,
            passwordHash,
          ],
        );
        const id = rows[0]?.id;
        if (!id) throw new Error('user insert returned no row');
        await c.query(
          `INSERT INTO account_tokens (token_hash, user_id, purpose, expires_at)
           VALUES ($1, $2, 'EMAIL_VERIFICATION', clock_timestamp() + make_interval(hours => $3))`,
          [sha256(verificationToken), id, VERIFICATION_TTL_HOURS],
        );
        await writeAudit(c, {
          class: 'SECURITY',
          actorType: a.role,
          actorUserId: id,
          action: 'ACCOUNT_REGISTERED',
          entityType: 'user',
          entityId: id,
          requestId: req.id,
          ipHash: hashedIp,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'users_student_id_norm_key') && a.studentId) {
        await writeAudit(pool, {
          class: 'SECURITY',
          actorType: 'ANONYMOUS',
          action: 'REGISTRATION_ID_CONFLICT',
          outcome: 'DENIED',
          entityType: 'student_id',
          entityId: keyedHash(config.IP_HASH_SECRET, 'sid', a.studentId.norm).toString('hex'),
          requestId: req.id,
          ipHash: hashedIp,
        });
        return 'STUDENT_ID_TAKEN';
      }
      if (isUniqueViolation(err, 'users_email_key')) {
        await writeAudit(pool, {
          class: 'SECURITY',
          actorType: 'ANONYMOUS',
          action: 'REGISTRATION_EMAIL_CONFLICT',
          outcome: 'DENIED',
          requestId: req.id,
          ipHash: hashedIp,
        });
        return 'CREATED';
      }
      throw err;
    }

    try {
      await mailer.sendEmailVerification(
        a.email,
        `${config.APP_ORIGIN}/verify-email#t=${verificationToken}`,
      );
    } catch (err) {
      // The account exists; they can request another link later. Never log the link.
      req.log.error({ err: (err as Error).name }, 'verification e-mail failed');
    }
    return 'CREATED';
  }

  // ---------------------------------------------------------------------------------------------
  // Registration. Students and lecturers can both sign up. A lecturer account sees nothing until an
  // operator assigns it a course.
  // ---------------------------------------------------------------------------------------------

  /** Validates and echoes the normalised details for the confirmation screen. Writes nothing. */
  app.post('/auth/register/preview', PUBLIC, async (req, reply) => {
    const body = RegisterBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'INVALID_REQUEST', 'Check the form and try again.');
    const n = normalizeRegistration(body.data);
    if (!n.ok) return fail(reply, 400, n.code, n.message);
    return {
      studentId: n.value.studentIdDisplay,
      fullName: n.value.fullName,
      email: n.value.email,
    };
  });

  app.post('/auth/register/commit', PUBLIC, async (req, reply) => {
    const hashedIp = ipHash(req);
    const limit = await hit(pool, `register:${hashedIp.toString('hex')}`, REGISTER_WINDOW_S);
    if (limit.count > REGISTER_MAX_PER_IP) {
      return fail(reply, 429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const body = CommitBody.safeParse(req.body);
    if (!body.success) {
      const needsConfirm = RegisterBody.safeParse(req.body).success;
      return needsConfirm
        ? fail(reply, 400, 'CONFIRMATION_REQUIRED', 'Confirm your details to create the account.')
        : fail(reply, 400, 'INVALID_REQUEST', 'Check the form and try again.');
    }
    const n = normalizeRegistration(body.data);
    if (!n.ok) return fail(reply, 400, n.code, n.message);
    const v = n.value;

    const outcome = await createAccount(req, hashedIp, {
      role: 'STUDENT',
      email: v.email,
      fullName: v.fullName,
      password: v.password,
      studentId: { norm: v.studentId, display: v.studentIdDisplay },
    });
    if (outcome === 'STUDENT_ID_TAKEN') {
      return fail(
        reply,
        409,
        'STUDENT_ID_TAKEN',
        'This student ID is already registered. If you think this is an error, contact your lecturer.',
      );
    }

    return reply.code(201).send({ status: 'registered' });
  });

  app.post('/auth/register/lecturer', PUBLIC, async (req, reply) => {
    const hashedIp = ipHash(req);
    const limit = await hit(pool, `register:${hashedIp.toString('hex')}`, REGISTER_WINDOW_S);
    if (limit.count > REGISTER_MAX_PER_IP) {
      return fail(reply, 429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const body = LecturerRegisterBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'INVALID_REQUEST', 'Check the form and try again.');
    const fullName = normalizeFullName(body.data.fullName);
    if (!fullName) return fail(reply, 400, 'INVALID_NAME', 'Enter your full name.');
    const policy = checkPasswordPolicy(body.data.password);
    if (policy) {
      return fail(reply, 400, policy, 'Choose a password of 10 to 128 characters.');
    }
    await createAccount(req, hashedIp, {
      role: 'LECTURER',
      email: normalizeEmail(body.data.email),
      fullName,
      password: body.data.password,
    });
    return reply.code(201).send({ status: 'registered' });
  });

  app.post('/auth/verify-email', PUBLIC, async (req, reply) => {
    const body = VerifyBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'INVALID_REQUEST', 'Invalid link.');
    const ok = await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ user_id: string }>(
        `UPDATE account_tokens SET used_at = clock_timestamp()
          WHERE token_hash = $1 AND purpose = 'EMAIL_VERIFICATION'
            AND used_at IS NULL AND expires_at > clock_timestamp()
        RETURNING user_id`,
        [sha256(body.data.token)],
      );
      const userId = rows[0]?.user_id;
      if (!userId) return false;
      await c.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, clock_timestamp()) WHERE id = $1`,
        [userId],
      );
      await writeAudit(c, {
        class: 'SECURITY',
        actorType: 'ANONYMOUS',
        actorUserId: userId,
        action: 'EMAIL_VERIFIED',
        entityType: 'user',
        entityId: userId,
        requestId: req.id,
      });
      return true;
    });
    return ok
      ? { status: 'verified' }
      : fail(reply, 400, 'INVALID_OR_EXPIRED_LINK', 'This link is invalid or has expired.');
  });

  // ---------------------------------------------------------------------------------------------
  // Login / logout / session
  // ---------------------------------------------------------------------------------------------

  app.post('/auth/login', PUBLIC, async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success)
      return fail(reply, 400, 'INVALID_REQUEST', 'Enter your e-mail and password.');
    const email = normalizeEmail(body.data.email);
    const hashedIp = ipHash(req);
    const accountKey = `login:acct:${keyedHash(config.IP_HASH_SECRET, 'acct', email).toString('hex')}`;
    const ipKey = `login:ip:${hashedIp.toString('hex')}`;

    // Throttle first, so a throttled caller learns nothing about whether a password was right.
    const [acct, ip] = await Promise.all([
      peek(pool, accountKey, LOGIN_WINDOW_S),
      peek(pool, ipKey, LOGIN_WINDOW_S),
    ]);
    if (acct.count >= LOGIN_MAX_FAILURES_PER_ACCOUNT || ip.count >= LOGIN_MAX_FAILURES_PER_IP) {
      const retryAfterSeconds = Math.max(acct.retryAfterSeconds, ip.retryAfterSeconds);
      await writeAudit(pool, {
        class: 'SECURITY',
        actorType: 'ANONYMOUS',
        action: 'LOGIN_THROTTLED',
        outcome: 'DENIED',
        requestId: req.id,
        ipHash: hashedIp,
      });
      void reply.header('Retry-After', String(retryAfterSeconds));
      return fail(reply, 429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.', {
        retryAfterSeconds,
      });
    }

    const { rows } = await pool.query<{
      id: string;
      role: 'LECTURER' | 'STUDENT';
      full_name: string;
      password_hash: string;
      status: string;
      email_verified_at: Date | null;
    }>(
      `SELECT id, role, full_name, password_hash, status, email_verified_at FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];

    let passwordOk = false;
    if (user) {
      passwordOk = await verifyPassword(user.password_hash, body.data.password);
    } else {
      await verifyAgainstDummy(body.data.password);
    }

    if (!user || !passwordOk || user.status !== 'ACTIVE') {
      await Promise.all([hit(pool, accountKey, LOGIN_WINDOW_S), hit(pool, ipKey, LOGIN_WINDOW_S)]);
      await writeAudit(pool, {
        class: 'SECURITY',
        actorType: 'ANONYMOUS',
        actorUserId: user?.id ?? null,
        action: 'LOGIN_FAILED',
        outcome: 'DENIED',
        requestId: req.id,
        ipHash: hashedIp,
      });
      return fail(reply, 401, 'INVALID_CREDENTIALS', 'E-mail or password is incorrect.');
    }

    const session = await createSession(pool, user.id, user.role);
    await writeAudit(pool, {
      class: 'SECURITY',
      actorType: user.role,
      actorUserId: user.id,
      action: 'LOGIN_SUCCEEDED',
      requestId: req.id,
      ipHash: hashedIp,
    });
    setSessionCookie(reply, session.token, session.maxAgeSeconds);
    return {
      user: {
        id: user.id,
        role: user.role,
        fullName: user.full_name,
        emailVerified: user.email_verified_at !== null,
      },
    };
  });

  app.post('/auth/logout', SIGNED_IN, async (req, reply) => {
    const auth = req.auth;
    if (auth) {
      await revokeSession(pool, auth.sessionHash, 'LOGOUT');
      await writeAudit(pool, {
        class: 'SECURITY',
        actorType: auth.role,
        actorUserId: auth.userId,
        action: 'LOGOUT',
        requestId: req.id,
      });
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/auth/me', SIGNED_IN, async (req) => {
    const auth = req.auth;
    return {
      user: auth && {
        id: auth.userId,
        role: auth.role,
        fullName: auth.fullName,
        emailVerified: auth.emailVerified,
      },
    };
  });

  /** Changes the password, revokes every other session, and issues a fresh one. */
  app.post('/auth/password', SIGNED_IN, async (req, reply) => {
    const auth = req.auth;
    if (!auth) return fail(reply, 401, 'UNAUTHENTICATED', 'Please sign in.');
    const body = ChangePasswordBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'INVALID_REQUEST', 'Check the form and try again.');

    const key = `pwchange:${auth.userId}`;
    const state = await peek(pool, key, LOGIN_WINDOW_S);
    if (state.count >= PASSWORD_CHANGE_MAX_FAILURES) {
      return fail(reply, 429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
        retryAfterSeconds: state.retryAfterSeconds,
      });
    }

    const policy = checkPasswordPolicy(body.data.newPassword);
    if (policy) return fail(reply, 400, policy, 'Choose a password of 10 to 128 characters.');

    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [auth.userId],
    );
    const current = rows[0]?.password_hash;
    if (!current || !(await verifyPassword(current, body.data.currentPassword))) {
      await hit(pool, key, LOGIN_WINDOW_S);
      return fail(reply, 401, 'INVALID_CREDENTIALS', 'Your current password is incorrect.');
    }

    const newHash = await hashPassword(body.data.newPassword);
    const session = await withTransaction(pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [auth.userId, newHash]);
      await revokeAllSessions(c, auth.userId, 'PASSWORD_CHANGED');
      const created = await createSession(c, auth.userId, auth.role);
      await writeAudit(c, {
        class: 'SECURITY',
        actorType: auth.role,
        actorUserId: auth.userId,
        action: 'PASSWORD_CHANGED',
        requestId: req.id,
      });
      return created;
    });
    setSessionCookie(reply, session.token, session.maxAgeSeconds);
    return { status: 'password_changed' };
  });
}
