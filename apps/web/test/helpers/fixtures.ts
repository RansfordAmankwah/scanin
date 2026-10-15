import { reply } from './net';

export const COURSE_ID = '11111111-1111-4111-8111-111111111111';

export const term = { id: 't', name: 'Autumn 2026', startsOn: '2026-09-01', endsOn: '2026-12-20' };

/** One course as the lecturer's dashboard receives it from GET /courses/overview. */
export const overviewCourse = (over: Record<string, unknown> = {}) => ({
  id: COURSE_ID,
  code: 'CS101',
  title: 'Intro to CS',
  term,
  sessions: { total: 1, started: 1 },
  openSession: null,
  lastSession: null,
  attention: { matchesToReview: 0, openFlags: 0, openReviews: 0 },
  students: { registered: 0, notRegistered: 0 },
  ...over,
});

export const overview = (courses: unknown[] = [overviewCourse()]) => reply(200, { courses });

/** A course's attendance summary, built from session views like the ones the tests already use. */
export const summaryFor = (
  sessions: Array<{ id: string; title: string; sessionDate: string; state: string }> = [],
  extra: Record<string, unknown> = {},
) => ({
  students: [],
  notRegistered: [],
  sessions: sessions.map((s) => ({
    id: s.id,
    title: s.title,
    date: s.sessionDate,
    state: s.state,
    present: 0,
    confirmed: 0,
    provisional: 0,
    awaitingConfirmation: 0,
    invalidated: 0,
    flagged: 0,
    headcount: null as number | null,
  })),
  ...extra,
});

/** The extra requests every course page now makes. */
export const courseChrome = (
  sessions: Parameters<typeof summaryFor>[0] = [],
  courseId = COURSE_ID,
) => ({
  'GET /courses/overview': overview(),
  [`GET /courses/${courseId}/attendance-summary`]: () => reply(200, summaryFor(sessions)),
});

export const emptyClassList = reply(200, { hasRoster: false, entries: [], unmatchedLinks: [] });

// --- the student's side ---------------------------------------------------------------------------
export const attendanceSummary = (over: Record<string, unknown> = {}) => ({
  sessionsStarted: 3,
  eligibleSessions: 2,
  inProgress: 1,
  notCounted: 0,
  tally: { confirmed: 1, provisional: 0, awaitingConfirmation: 0, invalidated: 0, noRecord: 1 },
  percent: 50,
  percentReason: 'OK',
  ...over,
});

export const studentCourse = (over: Record<string, unknown> = {}) => ({
  id: COURSE_ID,
  code: 'CS101',
  title: 'Intro to CS',
  term,
  association: { state: 'CONFIRMED' },
  summary: attendanceSummary(),
  latestSession: { id: 's1', title: 'Week 3 lecture', date: '2026-10-10', outcome: 'CONFIRMED' },
  openReviews: 0,
  ...over,
});

export const courseSession = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  title: 'Week 3 lecture',
  date: '2026-10-10',
  phase: 'CLOSED',
  outcome: 'CONFIRMED',
  counted: true,
  source: 'QR_SCAN',
  invalidationCategory: null,
  review: null,
  ...over,
});

export const studentHistory = (
  sessions: unknown[] = [courseSession()],
  over: Record<string, unknown> = {},
) => ({
  course: { id: COURSE_ID, code: 'CS101', title: 'Intro to CS', term },
  association: { state: 'CONFIRMED' },
  summary: attendanceSummary(),
  countedFrom: '2026-09-01T00:00:00.000Z',
  sessions,
  ...over,
});
