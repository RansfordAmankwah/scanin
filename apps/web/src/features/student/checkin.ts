import { apiFetch } from '../../api/client';
import { getDeviceId } from './deviceId';

/** What the student's phone scans is a link like https://host/c#t=<code>; accept a bare code too. */
export function extractToken(scanned: string): string | null {
  const text = scanned.trim();
  if (!text) return null;
  const fromFragment = /[#&]t=([A-Za-z0-9._-]+)/.exec(text);
  const candidate = fromFragment?.[1] ?? text;
  return /^ST\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate)
    ? candidate
    : null;
}

export type CheckInOutcome =
  | { kind: 'recorded'; course: string; session: string; association: string }
  | { kind: 'already'; course: string; session: string; invalidated: boolean }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'not-started' }
  | { kind: 'closed' }
  | { kind: 'ended' }
  | { kind: 'invalid' }
  | { kind: 'device-used' }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'signed-out' }
  | { kind: 'retryable' } // network failure or a temporary server problem: safe to try again
  | { kind: 'error' };

interface RecordBody {
  result: 'RECORDED' | 'ALREADY_RECORDED';
  attendanceStatus: 'PRESENT' | 'INVALIDATED';
  associationState: string;
  course: { code: string; title: string };
  sessionTitle: string;
  error?: { code?: string };
}

const REJECTIONS: Record<string, CheckInOutcome> = {
  CODE_EXPIRED: { kind: 'expired' },
  CODE_REVOKED: { kind: 'revoked' },
  SESSION_NOT_STARTED: { kind: 'not-started' },
  SESSION_CLOSED: { kind: 'closed' },
  SESSION_ENDED: { kind: 'ended' },
  INVALID_CODE: { kind: 'invalid' },
  DEVICE_ALREADY_USED: { kind: 'device-used' },
};

/**
 * Sends one check-in. `attemptId` identifies the student's action: reuse it when retrying after a
 * network failure so the server can recognise the repeat and never record twice.
 */
export async function submitCheckIn(token: string, attemptId: string): Promise<CheckInOutcome> {
  try {
    const res = await apiFetch<RecordBody>('/checkins', {
      method: 'POST',
      body: { token, clientAttemptId: attemptId, deviceId: getDeviceId() },
    });
    const body = res.data;
    if (res.ok && body && 'result' in body) {
      const course = `${body.course.code} ${body.course.title}`;
      return body.result === 'RECORDED'
        ? {
            kind: 'recorded',
            course,
            session: body.sessionTitle,
            association: body.associationState,
          }
        : {
            kind: 'already',
            course,
            session: body.sessionTitle,
            invalidated: body.attendanceStatus === 'INVALIDATED',
          };
    }
    const code = body?.error?.code ?? '';
    if (res.status === 401) return { kind: 'signed-out' };
    if (res.status === 429)
      return { kind: 'rate-limited', retryAfterSeconds: res.retryAfterSeconds ?? 30 };
    if (res.status === 503) return { kind: 'retryable' };
    return REJECTIONS[code] ?? { kind: 'error' };
  } catch {
    return { kind: 'retryable' };
  }
}
