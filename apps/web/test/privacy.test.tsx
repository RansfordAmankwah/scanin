import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { bodyOf, mockApi, reply } from './helpers/net';

// The camera capture is injected so the test drives deterministic frames, no real getUserMedia.
vi.mock('../src/features/account/faceCapture', () => ({
  browserCapture: vi.fn(async () => ['subject:alice', 'live:true', 'frame-blob']),
  CaptureError: class CaptureError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

const COURSE = '11111111-1111-4111-8111-111111111111';
const LINK = '55555555-5555-4555-8555-555555555555';
const student = {
  id: 's1',
  role: 'STUDENT',
  fullName: 'Ama Mensah',
  email: 'ama@school.test',
  studentId: 'AB100',
  emailVerified: true,
};
const lecturer = {
  id: 'l1',
  role: 'LECTURER',
  fullName: 'Dr Owusu',
  email: 'owusu@school.test',
  studentId: null,
  emailVerified: true,
};

const privacy = (over: Record<string, unknown> = {}) => ({
  consent: { state: 'NONE', noticeVersion: null, at: null, currentNoticeVersion: 'notice-v2' },
  enrollment: null,
  deletionPending: false,
  pendingEnrollment: null,
  faceChecks: [],
  inPersonReasons: [],
  ...over,
});
const granted = {
  state: 'GRANTED',
  noticeVersion: 'notice-v2',
  at: '2026-10-10T09:00:00.000Z',
  currentNoticeVersion: 'notice-v2',
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

describe('student privacy page', () => {
  it('shows consent not given, then records consent when the student agrees', async () => {
    let state = privacy();
    const fetchMock = mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/privacy': () => reply(200, state),
      'POST /me/biometric-consent': () => {
        state = privacy({ consent: granted });
        return reply(200, { consent: granted });
      },
    });
    render(<App pathname="/account/privacy" />);
    await waitFor(() => screen.getByText('Not given'));

    fireEvent.click(screen.getByRole('button', { name: /agree to the privacy notice/i }));
    await waitFor(() => screen.getByText('Consent given'));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/biometric-consent'))).toBe(true);
    // No one else's data, and no lecturer-only wording.
    expect(document.body.textContent?.toLowerCase()).not.toContain('spot check');
  });

  it('completes a lecturer-started enrollment with a capture on the student device', async () => {
    let state = privacy({
      consent: granted,
      pendingEnrollment: {
        sessionId: 'sess-1',
        courseCode: 'CS101',
        courseTitle: 'Intro',
        expiresAt: '2026-10-10T09:05:00.000Z',
      },
    });
    const fetchMock = mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/privacy': () => reply(200, state),
      'POST /me/face-enrollments/sess-1/complete': () => {
        state = privacy({
          consent: granted,
          enrollment: { enrolledAt: '2026-10-10T09:04:00.000Z', idMethod: 'STUDENT_ID_CARD' },
        });
        return reply(201, { enrolledAt: '2026-10-10T09:04:00.000Z' });
      },
    });
    render(<App pathname="/account/privacy" />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /start face capture/i })),
    );
    await waitFor(() => screen.getByText(/your face enrollment is complete/i));
    expect(screen.getByText(/enrolled on/i)).toBeTruthy();
    // The frames the fake capture produced were sent to the server.
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/complete'))!;
    expect(bodyOf(call).frames).toEqual(['subject:alice', 'live:true', 'frame-blob']);
  });

  it('withdraws consent after a confirmation, and reports the deletion', async () => {
    let state = privacy({
      consent: granted,
      enrollment: { enrolledAt: '2026-10-10T09:00:00.000Z', idMethod: 'STUDENT_ID_CARD' },
    });
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/privacy': () => reply(200, state),
      'POST /me/biometric-consent/withdraw': () => {
        state = privacy({ consent: { ...granted, state: 'WITHDRAWN' }, enrollment: null });
        return reply(200, { consent: { ...granted, state: 'WITHDRAWN' }, templateDeleted: true });
      },
    });
    render(<App pathname="/account/privacy" />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /withdraw consent & delete/i })),
    );
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: /withdraw consent/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /withdraw and delete/i }));
    await waitFor(() => screen.getByText('Withdrawn'));
    expect(screen.getByText(/you are not enrolled/i)).toBeTruthy();
  });

  it('shows empty check history and an export download link', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/privacy': () => reply(200, privacy({ consent: granted })),
    });
    render(<App pathname="/account/privacy" />);
    await waitFor(() => screen.getByText(/no face checks yet/i));
    const link = screen.getByRole('link', { name: /download my face data/i });
    expect(link.getAttribute('href')).toBe('/api/me/privacy/export');
  });
});

describe('lecturer: starting a face enrollment', () => {
  const studentHistory = {
    student: {
      linkId: LINK,
      studentId: 'AB100',
      fullName: 'Ama Mensah',
      associationState: 'CONFIRMED',
    },
    summary: {
      sessionsStarted: 1,
      eligibleSessions: 1,
      inProgress: 0,
      notCounted: 0,
      tally: { confirmed: 1, provisional: 0, awaitingConfirmation: 0, invalidated: 0, noRecord: 0 },
      percent: 100,
      percentReason: 'OK',
    },
    countedFrom: '2026-09-01T00:00:00.000Z',
    sessions: [],
  };
  const courseBody = (faceOn: boolean) => ({
    course: {
      id: COURSE,
      code: 'CS101',
      title: 'Intro',
      faceVerificationEnabled: faceOn,
      term: { id: 't', name: 'Autumn 2026', startsOn: '2026-09-01', endsOn: '2026-12-20' },
    },
  });
  const routes = (faceOn: boolean, over: Record<string, unknown> = {}) => ({
    'GET /auth/me': reply(200, { user: lecturer }),
    [`GET /courses/${COURSE}`]: reply(200, courseBody(faceOn)),
    [`GET /courses/${COURSE}/students/${LINK}/attendance`]: reply(200, studentHistory),
    ...over,
  });

  it('shows the enrollment card only when the course is in the pilot, and opens a session', async () => {
    const fetchMock = mockApi(
      routes(true, {
        [`POST /courses/${COURSE}/face-enrollments`]: () =>
          reply(201, { sessionId: 'sess-9', expiresAt: '2026-10-10T09:05:00.000Z' }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/students/${LINK}`} />);
    await waitFor(() => screen.getByRole('heading', { name: /face enrollment/i }));
    fireEvent.click(screen.getByRole('button', { name: /start face enrollment/i }));
    await waitFor(() => screen.getByText(/ask ama mensah to open their privacy page/i));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/face-enrollments'))!;
    expect(bodyOf(call)).toEqual({ linkId: LINK, idMethod: 'STUDENT_ID_CARD' });
  });

  it('hides the enrollment card when the course is not in the pilot', async () => {
    mockApi(routes(false));
    render(<App pathname={`/courses/${COURSE}/students/${LINK}`} />);
    await waitFor(() => screen.getByRole('heading', { name: /ama mensah/i, level: 1 }));
    expect(screen.queryByRole('heading', { name: /face enrollment/i })).toBeNull();
  });
});
