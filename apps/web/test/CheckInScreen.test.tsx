import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckInScreen, capturePendingToken } from '../src/features/student/CheckInScreen';
import { bodyOf, mockApi, reply } from './helpers/net';

// A controllable stand-in for the camera scanner library.
const scanner = vi.hoisted(() => ({
  instances: [] as Array<{ decode: (text: string) => void; stop: () => void; destroy: () => void }>,
  startError: null as null | Error,
}));

vi.mock('qr-scanner', () => ({
  default: class FakeQrScanner {
    stop = vi.fn();
    destroy = vi.fn();
    private callback: (r: { data: string }) => void;
    constructor(_video: HTMLVideoElement, callback: (r: { data: string }) => void) {
      this.callback = callback;
      scanner.instances.push({
        decode: (text) => this.callback({ data: text }),
        stop: this.stop,
        destroy: this.destroy,
      });
    }
    start() {
      return scanner.startError ? Promise.reject(scanner.startError) : Promise.resolve();
    }
  },
}));

const TOKEN =
  'ST1.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const LINK = `https://app.example/c#t=${TOKEN}`;

const recorded = (extra: Record<string, unknown> = {}, status = 201, result = 'RECORDED') =>
  reply(status, {
    result,
    attendanceStatus: 'PRESENT',
    associationState: 'PROVISIONAL',
    course: { code: 'CS101', title: 'Intro to CS' },
    sessionTitle: 'Week 3 lecture',
    ...extra,
  });

beforeEach(() => {
  scanner.instances.length = 0;
  scanner.startError = null;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const startCamera = async () => {
  fireEvent.click(screen.getByRole('button', { name: /start camera/i }));
  await waitFor(() => expect(scanner.instances.length).toBeGreaterThan(0));
};
const decode = async (text: string) => {
  await act(async () => scanner.instances.at(-1)!.decode(text));
};

describe('UX-01 the student scanning journey', () => {
  it('starts on a clear call to action, with the camera-app alternative explained', () => {
    mockApi({});
    render(<CheckInScreen />);
    expect(screen.getByRole('heading', { name: /check in to class/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /start camera/i })).toBeTruthy();
    expect(screen.getByText(/phone's normal camera app/i)).toBeTruthy();
    expect(scanner.instances).toHaveLength(0); // no camera until the student asks
  });

  it('shows the camera, then loading, then success with the class named', async () => {
    let release: (r: Response) => void = () => undefined;
    const fetchMock = mockApi({
      'POST /checkins': () => new Promise<Response>((r) => (release = r)),
    });
    render(<CheckInScreen />);
    await startCamera();
    expect(screen.getByLabelText(/camera view/i)).toBeTruthy();

    await decode(LINK);
    expect(screen.getByRole('status').textContent).toMatch(/checking you in/i);
    expect(scanner.instances[0]!.destroy).toHaveBeenCalled(); // camera released while submitting

    await act(async () => release(recorded()));
    expect(screen.getByRole('status').textContent).toContain("You're checked in");
    expect(screen.getByText(/CS101 Intro to CS · Week 3 lecture/)).toBeTruthy();
    expect(screen.getByText(/may need to confirm your details/i)).toBeTruthy(); // provisional
    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.token).toBe(TOKEN);
    expect(body.clientAttemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not show the "confirm your details" note once the association is confirmed', async () => {
    mockApi({ 'POST /checkins': recorded({ associationState: 'CONFIRMED' }) });
    render(<CheckInScreen />);
    await startCamera();
    await decode(LINK);
    await waitFor(() => screen.getByText(/you're checked in/i));
    expect(screen.queryByText(/may need to confirm/i)).toBeNull();
  });

  it('submits once even if the camera reads the same code many times', async () => {
    const fetchMock = mockApi({ 'POST /checkins': recorded() });
    render(<CheckInScreen />);
    await startCamera();
    const scan = scanner.instances[0]!;
    await act(async () => {
      for (let i = 0; i < 6; i++) scan.decode(LINK);
    });
    await waitFor(() => screen.getByText(/you're checked in/i));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says so when the student is already checked in, and when a lecturer changed the record', async () => {
    mockApi({ 'POST /checkins': recorded({}, 200, 'ALREADY_RECORDED') });
    render(<CheckInScreen />);
    await startCamera();
    await decode(LINK);
    await waitFor(() => screen.getByText(/already checked in/i));
    cleanup();

    mockApi({
      'POST /checkins': recorded({ attendanceStatus: 'INVALIDATED' }, 200, 'ALREADY_RECORDED'),
    });
    render(<CheckInScreen />);
    await startCamera();
    await decode(LINK);
    await waitFor(() => screen.getByText(/lecturer changed this record/i));
  });

  it.each([
    ['an expired code', 410, 'CODE_EXPIRED', /code has expired/i, true],
    ['a cancelled code', 410, 'CODE_REVOKED', /code was cancelled/i, true],
    ['check-in not started', 409, 'SESSION_NOT_STARTED', /hasn't started yet/i, true],
    ['a closed window', 409, 'SESSION_CLOSED', /check-in is closed/i, false],
    ['an ended class', 409, 'SESSION_ENDED', /class has ended/i, false],
    ['an unrecognised code', 400, 'INVALID_CODE', /isn't a scanin check-in code/i, true],
  ])(
    'explains %s clearly and offers the right next step',
    async (_label, status, code, message, canScanAgain) => {
      mockApi({ 'POST /checkins': reply(status, { error: { code } }) });
      render(<CheckInScreen />);
      await startCamera();
      await decode(LINK);
      await waitFor(() => screen.getByText(message));
      expect(!!screen.queryByRole('button', { name: /scan again/i })).toBe(canScanAgain);
      expect(
        screen.getByRole('button', { name: canScanAgain ? /scan again/i : /back/i }),
      ).toBeTruthy();
    },
  );

  it('ignores a QR code that is not a ScanIn code without contacting the server', async () => {
    const fetchMock = mockApi({});
    render(<CheckInScreen />);
    await startCamera();
    await decode('https://example.com/menu');
    await waitFor(() => screen.getByText(/isn't a scanin check-in code/i));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells the student how long to wait when rate limited', async () => {
    mockApi({
      'POST /checkins': reply(429, { error: { code: 'RATE_LIMITED' } }, { 'Retry-After': '45' }),
    });
    render(<CheckInScreen />);
    await startCamera();
    await decode(LINK);
    await waitFor(() => screen.getByText(/about 45 seconds/i));
  });

  it('after a network failure, "Try again" retries the SAME attempt so nothing can be recorded twice', async () => {
    let calls = 0;
    const fetchMock = mockApi({
      'POST /checkins': () => {
        calls += 1;
        if (calls === 1) throw new TypeError('offline');
        return recorded();
      },
    });
    render(<CheckInScreen />);
    await startCamera();
    await decode(LINK);
    await waitFor(() => screen.getByText(/couldn't reach the server/i));
    expect(screen.getByText(/trying again is safe/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => screen.getByText(/you're checked in/i));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map((c) => bodyOf(c));
    expect(second!.clientAttemptId).toBe(first!.clientAttemptId);
    expect(second!.token).toBe(first!.token);
  });

  it('treats a temporary server error (503) as retryable too', async () => {
    let calls = 0;
    mockApi({
      'POST /checkins': () =>
        ++calls === 1 ? reply(503, { error: { code: 'TRY_AGAIN' } }) : recorded(),
    });
    render(<CheckInScreen />);
    await startCamera();
    await decode(LINK);
    await waitFor(() => screen.getByRole('button', { name: /try again/i }));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => screen.getByText(/you're checked in/i));
  });

  it('uses a fresh attempt id for each new scan the student starts', async () => {
    const fetchMock = mockApi({ 'POST /checkins': recorded() });
    render(<CheckInScreen />);
    await startCamera();
    await decode(LINK);
    await waitFor(() => screen.getByRole('button', { name: /done/i }));
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await startCamera();
    await decode(LINK);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const ids = fetchMock.mock.calls.map((c) => bodyOf(c).clientAttemptId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('explains blocked camera permission and what to do instead, and lets the student retry', async () => {
    scanner.startError = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    mockApi({});
    render(<CheckInScreen />);
    fireEvent.click(screen.getByRole('button', { name: /start camera/i }));
    await waitFor(() => screen.getByText(/camera access is blocked/i));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/phone's normal camera app/i)).toBeTruthy();

    scanner.startError = null;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => screen.getByLabelText(/camera view/i));
  });

  it('explains when no camera is available', async () => {
    scanner.startError = new Error('Camera not found.');
    mockApi({});
    render(<CheckInScreen />);
    fireEvent.click(screen.getByRole('button', { name: /start camera/i }));
    await waitFor(() => screen.getByText(/no camera available/i));
    expect(screen.getByText(/ask your lecturer to record your attendance/i)).toBeTruthy();
  });

  it('releases the camera when the student cancels or leaves', async () => {
    mockApi({});
    const { unmount } = render(<CheckInScreen />);
    await startCamera();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(scanner.instances[0]!.destroy).toHaveBeenCalled();
    await startCamera();
    unmount();
    expect(scanner.instances[1]!.destroy).toHaveBeenCalled();
  });
});

describe("a code opened from the phone's own camera app", () => {
  it('is taken from the address bar, erased from it, and checked in automatically', async () => {
    const fetchMock = mockApi({ 'POST /checkins': recorded() });
    window.history.replaceState(null, '', `/c#t=${TOKEN}`);
    capturePendingToken();
    expect(window.location.hash).toBe(''); // no code left in the address bar or history entry
    expect(window.location.pathname).toBe('/c');

    render(<CheckInScreen />);
    await waitFor(() => screen.getByText(/you're checked in/i));
    expect(bodyOf(fetchMock.mock.calls[0]!).token).toBe(TOKEN);
    expect(sessionStorage.getItem('scanin.pendingToken')).toBeNull(); // spent
    expect(scanner.instances).toHaveLength(0); // no camera needed
  });

  it('is kept across a sign-in when the session has ended, then resumes', async () => {
    mockApi({ 'POST /checkins': reply(401, { error: { code: 'UNAUTHENTICATED' } }) });
    window.history.replaceState(null, '', `/c#t=${TOKEN}`);
    capturePendingToken();
    render(<CheckInScreen />);
    await waitFor(() => screen.getByText(/please sign in again/i));
    expect(sessionStorage.getItem('scanin.pendingToken')).toBe(TOKEN);
    cleanup();

    const fetchMock = mockApi({ 'POST /checkins': recorded() });
    render(<CheckInScreen />); // after signing in
    await waitFor(() => screen.getByText(/you're checked in/i));
    expect(bodyOf(fetchMock.mock.calls[0]!).token).toBe(TOKEN);
  });

  it('ignores a fragment that is not a ScanIn code', () => {
    window.history.replaceState(null, '', '/c#t=garbage');
    capturePendingToken();
    expect(sessionStorage.getItem('scanin.pendingToken')).toBeNull();
  });
});
