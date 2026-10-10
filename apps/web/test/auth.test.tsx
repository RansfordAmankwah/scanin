import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { bodyOf, mockApi, reply } from './helpers/net';

vi.mock('qr-scanner', () => ({
  default: class {
    stop() {}
    destroy() {}
    start() {
      return Promise.resolve();
    }
  },
}));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,AAAA' } }));

const student = { id: 's1', role: 'STUDENT', fullName: 'Ama Mensah', emailVerified: true };
const lecturer = { id: 'l1', role: 'LECTURER', fullName: 'Dr Owusu', emailVerified: true };

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('signing in', () => {
  it('asks signed-out visitors to sign in, then shows the student check-in screen', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': reply(401, { error: { code: 'UNAUTHENTICATED' } }),
      'POST /auth/login': reply(200, { user: student }),
      'GET /me/attendance': reply(200, { courses: [] }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('heading', { name: /sign in/i, level: 2 }));

    type('E-mail', 'ama@school.test');
    type('Password', 'a-long-password-1');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => screen.getByRole('heading', { name: /check in to class/i }));

    const login = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/auth/login'))!;
    expect(bodyOf(login)).toEqual({ email: 'ama@school.test', password: 'a-long-password-1' });
    expect((login[1] as { headers: Record<string, string> }).headers['X-Requested-With']).toBe(
      'scanin',
    );
  });

  it('shows clear, non-revealing errors', async () => {
    mockApi({
      'GET /auth/me': reply(401, {}),
      'POST /auth/login': reply(401, { error: { code: 'INVALID_CREDENTIALS' } }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByLabelText('E-mail'));
    type('E-mail', 'x@school.test');
    type('Password', 'wrong-password');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => screen.getByText('E-mail or password is incorrect.'));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('wrong-password');
  });

  it('tells the visitor when they are being rate limited, and when the network is down', async () => {
    mockApi({
      'GET /auth/me': reply(401, {}),
      'POST /auth/login': reply(429, {}, { 'Retry-After': '300' }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByLabelText('E-mail'));
    type('E-mail', 'x@school.test');
    type('Password', 'whatever-password');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => screen.getByText(/too many failed attempts/i));
    cleanup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/auth/me')) return reply(401, {});
        throw new TypeError('offline');
      }),
    );
    render(<App pathname="/" />);
    await waitFor(() => screen.getByLabelText('E-mail'));
    type('E-mail', 'x@school.test');
    type('Password', 'whatever-password');
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => screen.getByText(/could not reach the server/i));
  });

  it('shows lecturers a lecturer view, not the student scanner', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      'GET /courses': reply(200, { courses: [] }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByText(/no courses yet/i));
    expect(screen.queryByRole('button', { name: /start camera/i })).toBeNull();
  });

  it('signs out through the server', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/attendance': reply(200, { courses: [] }),
      'POST /auth/logout': reply(204, null),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('button', { name: /sign out/i }));
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => screen.getByLabelText('E-mail'));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/auth/logout'))).toBe(true);
  });
});

describe('creating an account (AUTH-02 confirmation step)', () => {
  const openRegistration = async (routes: Parameters<typeof mockApi>[0]) => {
    const fetchMock = mockApi({ 'GET /auth/me': reply(401, {}), ...routes });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('button', { name: /create an account/i }));
    fireEvent.click(screen.getByRole('button', { name: /create an account/i }));
    await waitFor(() => screen.getByLabelText('Student ID'));
    type('Student ID', 'ab 100200');
    type('Full name', '  Ama   Mensah ');
    type('School e-mail', 'Ama@School.test');
    type('Password', 'a-long-password-1');
    return fetchMock;
  };

  it('does not create the account until the student confirms exactly what will be stored', async () => {
    const fetchMock = await openRegistration({
      'POST /auth/register/preview': reply(200, {
        studentId: 'ab 100200',
        fullName: 'Ama Mensah',
        email: 'ama@school.test',
      }),
      'POST /auth/register/commit': reply(201, { status: 'registered' }),
    });
    fireEvent.click(screen.getByRole('button', { name: /review details/i }));
    await waitFor(() => screen.getByRole('heading', { name: /is this correct/i }));

    expect(screen.getByText('ab 100200')).toBeTruthy();
    expect(screen.getByText('Ama Mensah')).toBeTruthy();
    expect(screen.getByText('ama@school.test')).toBeTruthy();
    expect(screen.getByText(/cannot change your student id or name/i)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/register/commit'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => screen.getByText(/account created/i));
    const commit = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/register/commit'))!;
    expect(bodyOf(commit)).toMatchObject({
      confirmed: true,
      studentId: 'ab 100200',
      email: 'Ama@School.test',
    });
  });

  it('lets the student go back and edit without losing what they typed', async () => {
    await openRegistration({
      'POST /auth/register/preview': reply(200, {
        studentId: 'ab 100200',
        fullName: 'Ama Mensah',
        email: 'ama@school.test',
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: /review details/i }));
    await waitFor(() => screen.getByRole('heading', { name: /is this correct/i }));
    fireEvent.click(screen.getByRole('button', { name: /go back and edit/i }));
    await waitFor(() => screen.getByLabelText('Student ID'));
    expect((screen.getByLabelText('Student ID') as HTMLInputElement).value).toBe('ab 100200');
  });

  it('explains validation problems and an already-registered student ID', async () => {
    await openRegistration({
      'POST /auth/register/preview': reply(400, { error: { code: 'PASSWORD_TOO_SHORT' } }),
    });
    fireEvent.click(screen.getByRole('button', { name: /review details/i }));
    await waitFor(() =>
      screen.getByText(/at least 10 characters/i, { selector: '[role="alert"] *' }),
    );
    cleanup();

    await openRegistration({
      'POST /auth/register/preview': reply(200, {
        studentId: 'AB100200',
        fullName: 'Ama Mensah',
        email: 'ama@school.test',
      }),
      'POST /auth/register/commit': reply(409, { error: { code: 'STUDENT_ID_TAKEN' } }),
    });
    fireEvent.click(screen.getByRole('button', { name: /review details/i }));
    await waitFor(() => screen.getByRole('button', { name: /create account/i }));
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => screen.getByText(/already registered/i));
  });
});

describe('email verification link', () => {
  it('verifies the token once and removes it from the address bar', async () => {
    window.history.replaceState(null, '', '/verify-email#t=abcDEF123-_token');
    const fetchMock = mockApi({ 'POST /auth/verify-email': reply(200, { status: 'verified' }) });
    render(<App pathname="/verify-email" />);
    await waitFor(() => screen.getByText(/e-mail verified/i));
    expect(window.location.hash).toBe('');
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({ token: 'abcDEF123-_token' });
  });

  it('reports an invalid or expired link', async () => {
    window.history.replaceState(null, '', '/verify-email#t=expired-token-value');
    mockApi({
      'POST /auth/verify-email': reply(400, { error: { code: 'INVALID_OR_EXPIRED_LINK' } }),
    });
    render(<App pathname="/verify-email" />);
    await waitFor(() => screen.getByText(/invalid or has expired/i));
  });
});

describe('projector page access', () => {
  const COURSE = '11111111-1111-4111-8111-111111111111';
  const SESSION = '22222222-2222-4222-8222-222222222222';

  it('requires sign-in, and refuses students', async () => {
    mockApi({ 'GET /auth/me': reply(401, {}) });
    render(<App pathname={`/present/${COURSE}/${SESSION}`} />);
    await waitFor(() => screen.getByLabelText('E-mail'));
    cleanup();

    mockApi({ 'GET /auth/me': reply(200, { user: student }) });
    render(<App pathname={`/present/${COURSE}/${SESSION}`} />);
    await waitFor(() => screen.getByText(/only a lecturer can show/i));
  });

  it('shows the QR display to a signed-in lecturer', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET /courses/${COURSE}/sessions/${SESSION}/qr`]: reply(200, {
        qrUrl: 'https://app.test/c#t=ST1.k1.a.b',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
        refreshAfterSeconds: 30,
        checkInDeadline: new Date(Date.now() + 1_500_000).toISOString(),
      }),
    });
    render(<App pathname={`/present/${COURSE}/${SESSION}`} />);
    await waitFor(() => screen.getByRole('img', { name: /qr code/i }));
  });
});
