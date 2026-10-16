import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { bodyOf, mockApi, reply } from './helpers/net';

vi.mock('qr-scanner', () => ({
  default: class {
    start() {
      return Promise.resolve();
    }
    stop() {}
    destroy() {}
  },
}));
// Deterministic capture, no real camera.
vi.mock('../src/features/account/faceCapture', () => ({
  browserCapture: vi.fn(async () => ['subject:alice', 'live:true', 'frame']),
  CaptureError: class CaptureError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

const TOKEN =
  'ST1.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const student = {
  id: 's1',
  role: 'STUDENT',
  fullName: 'Ama Mensah',
  email: 'ama@school.test',
  studentId: 'AB100',
  emailVerified: true,
};
const recorded = {
  result: 'RECORDED',
  attendanceStatus: 'PRESENT',
  associationState: 'CONFIRMED',
  course: { code: 'CS101', title: 'Intro' },
  sessionTitle: 'Week 3',
  attendanceId: 'att-1',
  faceCheck: { required: true },
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
  sessionStorage.setItem('scanin.pendingToken', TOKEN);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const base = {
  'GET /auth/me': reply(200, { user: student }),
  'GET /me/courses': reply(200, { courses: [] }),
  'POST /checkins': reply(201, recorded),
};

describe('face check after a check-in', () => {
  it('runs a challenge and a capture, and shows a pass', async () => {
    const fetchMock = mockApi({
      ...base,
      'POST /me/face-checks/challenge': () =>
        reply(200, { challengeId: 'ch-1', content: { moves: ['blink'] }, expiresAt: 'x' }),
      'POST /me/face-checks/ch-1/frames': () =>
        reply(200, { outcome: 'VERIFIED', attemptsLeft: 0 }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByText("You're checked in"));
    fireEvent.click(screen.getByRole('button', { name: /do the face check/i }));
    await waitFor(() => screen.getByText(/face check passed/i));
    // The challenge was bound to the just-created attendance, and frames were uploaded.
    expect(bodyOf(fetchMock.mock.calls.find(([u]) => String(u).endsWith('/challenge'))!)).toEqual({
      attendanceId: 'att-1',
    });
    const upload = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/frames'))!;
    expect(bodyOf(upload).frames).toEqual(['subject:alice', 'live:true', 'frame']);
  });

  it('shows a failed check as not changing attendance, with a retry while attempts remain', async () => {
    mockApi({
      ...base,
      'POST /me/face-checks/challenge': () =>
        reply(200, { challengeId: 'ch-1', content: {}, expiresAt: 'x' }),
      'POST /me/face-checks/ch-1/frames': () => reply(200, { outcome: 'FAILED', attemptsLeft: 2 }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByText("You're checked in"));
    fireEvent.click(screen.getByRole('button', { name: /do the face check/i }));
    await waitFor(() => screen.getByText(/face check didn't pass/i));
    expect(screen.getByText(/your attendance still stands/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try the face check again/i })).toBeTruthy();
  });

  it('tells an exempt student they will be checked in person', async () => {
    mockApi({
      ...base,
      'POST /me/face-checks/challenge': () => reply(200, { outcome: 'EXEMPT' }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByText("You're checked in"));
    fireEvent.click(screen.getByRole('button', { name: /do the face check/i }));
    await waitFor(() => screen.getByText(/checked in person/i));
  });

  it('does not offer a face check when the course is not in the pilot', async () => {
    const { faceCheck, attendanceId, ...plain } = recorded;
    void faceCheck;
    void attendanceId;
    mockApi({ ...base, 'POST /checkins': reply(201, plain) });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByText("You're checked in"));
    expect(screen.queryByRole('button', { name: /do the face check/i })).toBeNull();
  });
});
