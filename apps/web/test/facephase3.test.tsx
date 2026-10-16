import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SpotChecksPanel } from '../src/features/lecturer/SpotChecksPanel';
import { mockApi, reply } from './helpers/net';

const COURSE = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const lecturer = {
  id: 'l1',
  role: 'LECTURER',
  fullName: 'Dr Owusu',
  email: 'owusu@school.test',
  studentId: null,
  emailVerified: true,
};
const student = {
  id: 's1',
  role: 'STUDENT',
  fullName: 'Ama Mensah',
  email: 'ama@school.test',
  studentId: 'AB100',
  emailVerified: true,
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('spot check: a face exception shows only as an in-person check', () => {
  it('labels an IN_PERSON_REQUIRED item plainly and never reveals the face sub-reason', async () => {
    const base = `/courses/${COURSE}/sessions/${SESSION}`;
    mockApi({
      [`GET ${base}/spot-checks`]: () =>
        reply(200, {
          rounds: [
            {
              id: 'r1',
              createdAt: '2026-10-10T09:12:00.000Z',
              createdBy: 'Dr Owusu',
              requestedSize: 1,
              eligibleCount: 3,
              selectedCount: 2,
              items: [
                {
                  id: 'i1',
                  attendanceId: 'a1',
                  studentId: 'AB101',
                  fullName: 'Kofi Boateng',
                  selectionReason: 'IN_PERSON_REQUIRED',
                  riskFactors: [],
                  state: 'PENDING',
                  disputeId: null,
                  disputeState: null,
                  history: [],
                },
              ],
            },
          ],
          summary: { pending: 1, verified: 0, notPresent: 0, couldNotVerify: 0 },
          limits: { defaultSize: 5, maxSize: 20 },
        }),
    });
    render(
      <SpotChecksPanel
        courseId={COURSE}
        sessionId={SESSION}
        sessionState="CHECK_IN_OPEN"
        onChanged={() => {}}
      />,
    );
    const item = await waitFor(() => screen.getByLabelText(/AB101 Kofi Boateng/i));
    expect(within(item).getByText(/in-person check is required/i)).toBeTruthy();
    const text = item.textContent?.toLowerCase() ?? '';
    for (const leak of ['face', 'liveness', 'exempt', 'failed']) expect(text).not.toContain(leak);
  });
});

describe('lecturer: face pilot metrics', () => {
  const course = (faceOn: boolean) => ({
    course: {
      id: COURSE,
      code: 'CS101',
      title: 'Intro',
      faceVerificationEnabled: faceOn,
      term: { id: 't', name: 'Autumn 2026', startsOn: '2026-09-01', endsOn: '2026-12-20' },
    },
  });
  const overview = {
    courses: [
      {
        id: COURSE,
        code: 'CS101',
        title: 'Intro',
        term: { id: 't', name: 'Autumn 2026', startsOn: '2026-09-01', endsOn: '2026-12-20' },
        sessions: { total: 0, started: 0 },
        openSession: null,
        lastSession: null,
        attention: { matchesToReview: 0, openFlags: 0, openReviews: 0 },
        students: { registered: 0, notRegistered: 0 },
      },
    ],
  };
  const summary = { students: [], notRegistered: [], sessions: [] };

  it('shows pilot totals on the course when the course is in the pilot', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET /courses/${COURSE}`]: reply(200, course(true)),
      'GET /courses/overview': reply(200, overview),
      [`GET /courses/${COURSE}/attendance-summary`]: reply(200, summary),
      [`GET /courses/${COURSE}/face-metrics`]: reply(200, {
        attempted: 10,
        verified: 7,
        failed: 2,
        livenessRejected: 1,
        unavailable: 0,
        exempt: 3,
        forcedListSize: 4,
        medianScanToVerifiedSeconds: 12.5,
        notPresentAmongFaceVerified: 0,
      }),
    });
    render(<App pathname={`/courses/${COURSE}`} />);
    const card = (await waitFor(() => screen.getByText('Verified'))).closest('section')!;
    expect(within(card).getByRole('heading', { name: 'Face pilot' })).toBeTruthy();
    expect(within(card).getByText('Verified').nextElementSibling?.textContent).toBe('7');
    expect(within(card).getByText('On the in-person list').nextElementSibling?.textContent).toBe(
      '4',
    );
    expect(card.textContent).toContain('12.5s');
  });

  it('omits the pilot card when the course is not in the pilot', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET /courses/${COURSE}`]: reply(200, course(false)),
      'GET /courses/overview': reply(200, overview),
      [`GET /courses/${COURSE}/attendance-summary`]: reply(200, summary),
    });
    render(<App pathname={`/courses/${COURSE}`} />);
    await waitFor(() => screen.getByRole('navigation', { name: /course sections/i }));
    expect(screen.queryByRole('heading', { name: 'Face pilot' })).toBeNull();
  });
});

describe('student privacy: in-person reasons', () => {
  it('lists the times a face check could not confirm them', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/privacy': () =>
        reply(200, {
          consent: {
            state: 'GRANTED',
            noticeVersion: 'v2',
            at: '2026-10-01T09:00:00.000Z',
            currentNoticeVersion: 'v2',
          },
          enrollment: { enrolledAt: '2026-10-01T09:00:00.000Z', idMethod: 'STUDENT_ID_CARD' },
          deletionPending: false,
          pendingEnrollment: null,
          faceChecks: [
            {
              outcome: 'FAILED',
              attempt: 1,
              at: '2026-10-10T09:00:00.000Z',
              courseCode: 'CS101',
              sessionTitle: 'Week 3',
            },
          ],
          inPersonReasons: [
            {
              at: '2026-10-10T09:05:00.000Z',
              courseCode: 'CS101',
              sessionTitle: 'Week 3',
              result: 'VERIFIED',
            },
          ],
        }),
    });
    render(<App pathname="/account/privacy" />);
    await waitFor(() => screen.getByRole('list', { name: 'Face checks' }));
    expect(screen.getByText('Did not match')).toBeTruthy();
    const inPerson = screen.getByRole('list', { name: 'In-person checks' });
    expect(within(inPerson).getByText(/an in-person check was asked for/i)).toBeTruthy();
  });
});
