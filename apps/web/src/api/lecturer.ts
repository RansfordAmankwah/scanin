import { apiFetch, type ApiResult } from './client';

export interface Course {
  id: string;
  code: string;
  title: string;
  term: { id: string; name: string; startsOn: string; endsOn: string };
}

export interface TermView {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

export interface NewCourseInput {
  code: string;
  title: string;
  termId?: string;
  newTerm?: { name: string; startsOn: string; endsOn: string };
}

export interface SessionView {
  id: string;
  courseId: string;
  title: string;
  sessionDate: string;
  state: 'NOT_STARTED' | 'CHECK_IN_OPEN' | 'CHECK_IN_CLOSED' | 'ENDED';
  startedAt: string | null;
  checkInDeadline: string | null;
  checkInClosedAt: string | null;
  endedAt: string | null;
  extensions?: Array<{ previousDeadline: string; newDeadline: string; reason: string }>;
}

export interface Counts {
  presentTotal: number;
  confirmed: number;
  provisional: number;
  reviewRequired: number;
  invalidated: number;
  flaggedPresent: number;
}

export interface RosterRecord {
  attendanceId: string;
  studentId: string;
  fullName: string;
  status: 'PRESENT' | 'INVALIDATED';
  source: 'QR_SCAN' | 'MANUAL';
  associationState: string;
  associationBasis: string | null;
  flagged: boolean;
  flagKinds: string[];
  verification: 'PENDING' | 'VERIFIED' | 'NOT_PRESENT' | 'COULD_NOT_VERIFY' | null;
  disputeState: 'OPEN' | 'RESOLVED_UPHELD' | 'RESOLVED_INVALIDATED' | null;
}

export interface SessionRoster {
  counts: Counts;
  records: RosterRecord[];
  noRecord: Array<{ entryId: string; studentId: string; fullName: string; registered: boolean }>;
}

export interface ScanRow {
  id: string;
  receivedAt: string;
  studentId: string;
  fullName: string;
  outcome: string;
  browser: string | null;
  network: string | null;
}

export interface ApiError {
  code: string;
  message: string;
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; retryAfterSeconds: number | null };

/** Turns the raw API result into a value or a typed failure; network errors become code NETWORK. */
async function call<T>(
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown },
): Promise<Result<T>> {
  let res: ApiResult<T & { error?: ApiError }>;
  try {
    res = await apiFetch<T & { error?: ApiError }>(path, init);
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', retryAfterSeconds: null };
  }
  if (res.ok && res.data !== null) return { ok: true, data: res.data };
  if (res.ok) return { ok: true, data: {} as T };
  return {
    ok: false,
    status: res.status,
    code: res.data?.error?.code ?? 'ERROR',
    retryAfterSeconds: res.retryAfterSeconds,
  };
}

const base = (courseId: string, sessionId: string) => `/courses/${courseId}/sessions/${sessionId}`;

export const lecturerApi = {
  courses: () => call<{ courses: Course[] }>('/courses'),
  terms: () => call<{ terms: TermView[] }>('/terms'),
  createCourse: (input: NewCourseInput) =>
    call<{ course: Course }>('/courses', { method: 'POST', body: input }),
  course: (id: string) => call<{ course: Course }>(`/courses/${id}`),
  sessions: (courseId: string) =>
    call<{ sessions: SessionView[] }>(`/courses/${courseId}/sessions`),
  createSession: (courseId: string, title: string, sessionDate: string) =>
    call<{ session: SessionView }>(`/courses/${courseId}/sessions`, {
      method: 'POST',
      body: { title, sessionDate },
    }),
  session: (courseId: string, sessionId: string) =>
    call<{ session: SessionView }>(base(courseId, sessionId)),
  start: (courseId: string, sessionId: string) =>
    call<{ session: SessionView }>(`${base(courseId, sessionId)}/start`, {
      method: 'POST',
      body: {},
    }),
  extend: (
    courseId: string,
    sessionId: string,
    minutes: number,
    reason: string,
    expectedDeadline: string,
  ) =>
    call<{ session: SessionView }>(`${base(courseId, sessionId)}/extend`, {
      method: 'POST',
      body: { minutes, reason, expectedDeadline },
    }),
  end: (courseId: string, sessionId: string) =>
    call<{ session: SessionView }>(`${base(courseId, sessionId)}/end`, {
      method: 'POST',
      body: {},
    }),
  attendance: (courseId: string, sessionId: string) =>
    call<SessionRoster>(`${base(courseId, sessionId)}/attendance`),
  scans: (
    courseId: string,
    sessionId: string,
    query: { student?: string; outcome?: string; before?: string },
  ) => {
    const params = new URLSearchParams();
    if (query.student) params.set('student', query.student);
    if (query.outcome) params.set('outcome', query.outcome);
    if (query.before) params.set('before', query.before);
    params.set('limit', '50');
    return call<{ scans: ScanRow[]; nextCursor: string | null }>(
      `${base(courseId, sessionId)}/scans?${params.toString()}`,
    );
  },
  rosterPreview: (courseId: string, csv: string) =>
    call<RosterPreview>(`/courses/${courseId}/roster/preview`, { method: 'POST', body: { csv } }),
  rosterApply: (courseId: string, csv: string, previewToken: string, retireEntryIds: string[]) =>
    call<{ noChanges: boolean; added: number; changed: number; retired: number }>(
      `/courses/${courseId}/roster/apply`,
      {
        method: 'POST',
        body: { csv, previewToken, retireEntryIds },
      },
    ),
};

export interface QueueLink {
  linkId: string;
  state: string;
  studentId: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  rosterEntry: { studentId: string; fullName: string } | null;
  attendanceCount: number;
}
export interface QueueFlag {
  flagId: string;
  kind: string;
  state: string;
  origin: string;
  linkId: string | null;
  attendanceId: string | null;
  studentId: string | null;
  fullName: string | null;
}
export interface Suggestion {
  entryId: string;
  studentId: string;
  fullName: string;
  similarity: number;
}
export interface HistoryItem {
  at: string;
  actor: string;
  text: string;
  explanation: string | null;
}

export type LinkDecisionBody = {
  decision: 'CONFIRM' | 'KEEP_PROVISIONAL' | 'REJECT' | 'MARK_REVIEW_REQUIRED';
  basis?: 'LECTURER_IDENTITY_CONFIRMED' | 'LECTURER_ENROLLMENT_CONFIRMED';
  entryId?: string;
  explanation: string;
};

const att = (c: string, s: string, a: string) => `/courses/${c}/sessions/${s}/attendance/${a}`;

export const reviewApi = {
  queue: (courseId: string) =>
    call<{ links: QueueLink[]; flags: QueueFlag[] }>(`/courses/${courseId}/review-queue`),
  suggestions: (courseId: string, linkId: string) =>
    call<{ candidates: Suggestion[] }>(`/courses/${courseId}/links/${linkId}/suggestions`),
  decide: (courseId: string, linkId: string, body: LinkDecisionBody) =>
    call<{ state: string }>(`/courses/${courseId}/links/${linkId}/decision`, {
      method: 'POST',
      body,
    }),
  linkHistory: (courseId: string, linkId: string) =>
    call<{
      reviews: Array<{
        reviewNo: number;
        decision: string;
        fromState: string | null;
        toState: string;
        actor: string;
        explanation: string | null;
        decidedAt: string;
      }>;
    }>(`/courses/${courseId}/links/${linkId}/history`),
  raiseFlag: (
    courseId: string,
    body: { kind: string; attendanceId?: string; linkId?: string; note: string },
  ) => call<{ flagId: string }>(`/courses/${courseId}/flags`, { method: 'POST', body }),
  transitionFlag: (courseId: string, flagId: string, to: string, note: string) =>
    call<{ state: string }>(`/courses/${courseId}/flags/${flagId}/transition`, {
      method: 'POST',
      body: { to, note },
    }),
  flagHistory: (courseId: string, flagId: string) =>
    call<{
      events: Array<{
        toState: string;
        fromState: string | null;
        note: string | null;
        actor: string;
        at: string;
      }>;
    }>(`/courses/${courseId}/flags/${flagId}/history`),
  invalidate: (c: string, s: string, a: string, category: string, explanation: string) =>
    call<{ status: string }>(`${att(c, s, a)}/invalidate`, {
      method: 'POST',
      body: { category, explanation },
    }),
  restore: (c: string, s: string, a: string, explanation: string) =>
    call<{ status: string }>(`${att(c, s, a)}/restore`, { method: 'POST', body: { explanation } }),
  attendanceHistory: (c: string, s: string, a: string) =>
    call<{
      revisions: Array<{
        revNo: number;
        kind: string;
        fromStatus: string | null;
        toStatus: string;
        category: string | null;
        explanation: string | null;
        actor: string;
        at: string;
      }>;
    }>(`${att(c, s, a)}/history`),
  markPresent: (c: string, s: string, studentId: string, explanation: string) =>
    call<{ student: { studentId: string; fullName: string } }>(
      `/courses/${c}/sessions/${s}/attendance/manual`,
      {
        method: 'POST',
        body: { studentId, explanation },
      },
    ),
};

export interface RosterPreview {
  previewToken: string;
  counts: { added: number; changed: number; unchanged: number; missing: number };
  added: Array<{ studentId: string; fullName: string }>;
  changed: Array<{
    entryId: string;
    studentId: string;
    before: { fullName: string };
    after: { fullName: string };
  }>;
  missing: Array<{ entryId: string; studentId: string; fullName: string; heldBy: string | null }>;
}

export interface MyAttendance {
  courses: Array<{
    id: string;
    code: string;
    title: string;
    associationState: string;
    presentCount: number;
    sessionCount: number;
    sessions: Array<{
      id: string;
      title: string;
      date: string;
      status: 'PRESENT' | 'INVALIDATED' | 'NO_RECORD';
      source: string | null;
      invalidationCategory: string | null;
      /** Present only while a lecturer is reviewing, or after they reviewed, this record. */
      review: {
        id: string;
        state: 'OPEN' | 'RESOLVED_UPHELD' | 'RESOLVED_INVALIDATED';
        openedAt: string;
        resolvedAt: string | null;
        repliesLeft: number;
      } | null;
    }>;
  }>;
}

export const studentApi = {
  attendance: () => call<MyAttendance>('/me/attendance'),
  respondToReview: (disputeId: string, note: string) =>
    call<{ disputeId: string }>(`/me/disputes/${disputeId}/response`, {
      method: 'POST',
      body: { note },
    }),
};

// --- Anti-proxy controls: room headcount, spot checks and reviews ----------------------------

export type ReconciliationStatus =
  'NO_HEADCOUNT' | 'CONSISTENT' | 'REVIEW_RECOMMENDED' | 'MORE_PEOPLE_THAN_RECORDS';

export interface Reconciliation {
  sessionState: string;
  headcount: {
    revNo: number;
    headcount: number;
    previousHeadcount: number | null;
    explanation: string | null;
    recordedAt: string;
    recordedBy: string;
  } | null;
  history: Array<{ revNo: number; headcount: number; recordedAt: string; recordedBy: string }>;
  recordedAttendance: number;
  invalidated: number;
  difference: number | null;
  status: ReconciliationStatus;
  tolerance: { percent: number; minimum: number; allowed: number | null };
  stale: { isStale: boolean; checkInsSince: number; minutesSince: number };
  notes: Array<{ note: string; statusAtTime: string; recordedAt: string; recordedBy: string }>;
  limits: { headcountMax: number };
}

export type SpotState = 'PENDING' | 'VERIFIED' | 'NOT_PRESENT' | 'COULD_NOT_VERIFY';
export type SpotOutcome = Exclude<SpotState, 'PENDING'>;
export type VerificationMethod = 'STUDENT_ID_CARD' | 'ROSTER_PHOTO' | 'OTHER_OFFICIAL_ID';

export interface SpotCheckItem {
  id: string;
  attendanceId: string;
  studentId: string;
  fullName: string;
  selectionReason: 'RANDOM' | 'RISK_WEIGHTED';
  riskFactors: string[];
  state: SpotState;
  disputeId: string | null;
  disputeState: string | null;
  history: Array<{
    eventNo: number;
    from: SpotState;
    to: SpotOutcome;
    method: VerificationMethod | null;
    explanation: string | null;
    at: string;
    by: string;
  }>;
}

export interface SpotChecks {
  rounds: Array<{
    id: string;
    createdAt: string;
    createdBy: string;
    requestedSize: number;
    eligibleCount: number;
    selectedCount: number;
    items: SpotCheckItem[];
  }>;
  summary: { pending: number; verified: number; notPresent: number; couldNotVerify: number };
  limits: { defaultSize: number; maxSize: number };
}

export interface Dispute {
  id: string;
  attendanceId: string;
  studentId: string;
  fullName: string;
  state: 'OPEN' | 'RESOLVED_UPHELD' | 'RESOLVED_INVALIDATED';
  attendanceStatus: 'PRESENT' | 'INVALIDATED';
  openedAt: string;
  resolvedAt: string | null;
  fromSpotCheck: boolean;
  events: Array<{
    eventNo: number;
    kind: string;
    note: string | null;
    at: string;
    by: string;
    byRole: 'LECTURER' | 'STUDENT';
  }>;
}

const sess = (c: string, s: string) => `/courses/${c}/sessions/${s}`;

export const antiProxyApi = {
  reconciliation: (c: string, s: string) => call<Reconciliation>(`${sess(c, s)}/reconciliation`),
  setHeadcount: (c: string, s: string, headcount: number, explanation?: string) =>
    call<{ unchanged: boolean; reconciliation: Reconciliation }>(`${sess(c, s)}/headcount`, {
      method: 'PUT',
      body: { headcount, ...(explanation ? { explanation } : {}) },
    }),
  addNote: (c: string, s: string, note: string) =>
    call<Reconciliation>(`${sess(c, s)}/reconciliation/notes`, { method: 'POST', body: { note } }),
  spotChecks: (c: string, s: string) => call<SpotChecks>(`${sess(c, s)}/spot-checks`),
  generate: (c: string, s: string, size: number, requestId: string) =>
    call<SpotChecks>(`${sess(c, s)}/spot-checks`, { method: 'POST', body: { size, requestId } }),
  record: (
    c: string,
    s: string,
    itemId: string,
    body: {
      requestId: string;
      outcome: SpotOutcome;
      method?: VerificationMethod;
      explanation?: string;
    },
  ) =>
    call<SpotChecks>(`${sess(c, s)}/spot-checks/items/${itemId}/result`, { method: 'POST', body }),
  disputes: (c: string, s: string) => call<{ disputes: Dispute[] }>(`${sess(c, s)}/disputes`),
  resolve: (
    c: string,
    s: string,
    disputeId: string,
    body: { resolution: 'UPHOLD' | 'INVALIDATE'; category?: string; explanation: string },
  ) =>
    call<{ disputeId: string; state: string; attendanceChanged: boolean }>(
      `${sess(c, s)}/disputes/${disputeId}/resolve`,
      { method: 'POST', body },
    ),
};

export interface ExportSummary {
  id: string;
  filename: string;
  format: string;
  kind: string;
  rowCount: number;
  expiresAt: string;
  downloadPath: string;
}

export const exportApi = {
  create: (courseId: string, sessionId: string, kind: string, format: string) =>
    call<{ export: ExportSummary }>(`/courses/${courseId}/exports`, {
      method: 'POST',
      body: { sessionId, kind, format },
    }),
};
