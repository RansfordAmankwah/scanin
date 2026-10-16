import { apiFetch } from './client';

export type ConsentState = 'GRANTED' | 'WITHDRAWN' | 'NONE';
export type IdMethod = 'STUDENT_ID_CARD' | 'OTHER_OFFICIAL_ID';

export interface FacePrivacy {
  consent: {
    state: ConsentState;
    noticeVersion: string | null;
    at: string | null;
    currentNoticeVersion: string;
  };
  enrollment: { enrolledAt: string; idMethod: IdMethod } | null;
  deletionPending: boolean;
  pendingEnrollment: {
    sessionId: string;
    courseCode: string;
    courseTitle: string;
    expiresAt: string;
  } | null;
  faceChecks: FaceCheckRow[];
  inPersonReasons: InPersonReason[];
}

export interface FaceCheckRow {
  outcome: 'VERIFIED' | 'FAILED' | 'LIVENESS_REJECTED' | 'EXEMPT' | 'EXPIRED' | 'UNAVAILABLE';
  attempt: number;
  at: string;
  courseCode: string;
  sessionTitle: string;
}

export interface InPersonReason {
  at: string;
  courseCode: string;
  sessionTitle: string;
  result: string;
}

export interface FacePilotMetrics {
  attempted: number;
  verified: number;
  failed: number;
  livenessRejected: number;
  unavailable: number;
  exempt: number;
  forcedListSize: number;
  medianScanToVerifiedSeconds: number | null;
  notPresentAmongFaceVerified: number;
}

export type FaceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; retryAfterSeconds: number | null };

async function call<T>(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<FaceResult<T>> {
  try {
    const res = await apiFetch<T & { error?: { code?: string } }>(path, init);
    if (res.ok && res.data !== null) return { ok: true, data: res.data };
    if (res.ok) return { ok: true, data: {} as T };
    return {
      ok: false,
      status: res.status,
      code: res.data?.error?.code ?? 'ERROR',
      retryAfterSeconds: res.retryAfterSeconds,
    };
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', retryAfterSeconds: null };
  }
}

export const faceApi = {
  privacy: () => call<FacePrivacy>('/me/privacy'),
  grantConsent: () =>
    call<{ consent: FacePrivacy['consent'] }>('/me/biometric-consent', {
      method: 'POST',
      body: {},
    }),
  withdraw: () =>
    call<{ consent: FacePrivacy['consent']; templateDeleted: boolean | null }>(
      '/me/biometric-consent/withdraw',
      { method: 'POST', body: {} },
    ),
  completeEnrollment: (sessionId: string, frames: string[]) =>
    call<{ enrolledAt: string }>(`/me/face-enrollments/${sessionId}/complete`, {
      method: 'POST',
      body: { frames },
    }),
  /** Start a face check for the just-created attendance: a challenge, or EXEMPT (in-person fallback). */
  challengeCheck: (attendanceId: string) =>
    call<{ outcome?: 'EXEMPT'; challengeId?: string; content?: unknown; expiresAt?: string }>(
      '/me/face-checks/challenge',
      { method: 'POST', body: { attendanceId } },
    ),
  submitCheck: (challengeId: string, frames: string[], deviceId: string) =>
    call<{ outcome: string; attemptsLeft: number }>(`/me/face-checks/${challengeId}/frames`, {
      method: 'POST',
      body: { frames, deviceId },
    }),
  /** Lecturer: pilot metrics for a face-enabled course (totals only). */
  metrics: (courseId: string) => call<FacePilotMetrics>(`/courses/${courseId}/face-metrics`),
  /** Lecturer: open a supervised enrollment session for a student after checking their ID. */
  openEnrollment: (courseId: string, linkId: string, idMethod: IdMethod) =>
    call<{ sessionId: string; expiresAt: string }>(`/courses/${courseId}/face-enrollments`, {
      method: 'POST',
      body: { linkId, idMethod },
    }),
  /** The export is a plain download, so it is a link, not a fetch. */
  exportHref: '/api/me/privacy/export',
};
