import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractToken, submitCheckIn } from '../src/features/student/checkin';
import { mockApi, reply } from './helpers/net';

const TOKEN =
  'ST1.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractToken', () => {
  it('reads the code from a link fragment, a bare code, or surrounding text', () => {
    expect(extractToken(`https://app.example/c#t=${TOKEN}`)).toBe(TOKEN);
    expect(extractToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(extractToken(`#t=${TOKEN}`)).toBe(TOKEN);
  });

  it.each([
    '',
    '   ',
    'hello',
    'https://example.com/',
    'https://x/c#t=notacode',
    'ST1.k1.only-two',
    'WIFI:S:net;T:WPA;P:pw;;',
  ])('rejects %j as not a ScanIn code', (text) => {
    expect(extractToken(text)).toBeNull();
  });
});

describe('submitCheckIn', () => {
  const record = (result: string, extra = {}) => ({
    result,
    attendanceStatus: 'PRESENT',
    associationState: 'PROVISIONAL',
    course: { code: 'CS101', title: 'Intro' },
    sessionTitle: 'Week 3',
    ...extra,
  });

  it('sends the code and attempt id with the CSRF header, and nothing else', async () => {
    const fetchMock = mockApi({ 'POST /checkins': reply(201, record('RECORDED')) });
    await submitCheckIn(TOKEN, '11111111-1111-4111-8111-111111111111');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/checkins');
    expect(JSON.parse(init!.body as string)).toEqual({
      token: TOKEN,
      clientAttemptId: '11111111-1111-4111-8111-111111111111',
    });
    expect((init!.headers as Record<string, string>)['X-Requested-With']).toBe('scanin');
  });

  it.each([
    [201, record('RECORDED'), 'recorded'],
    [200, record('ALREADY_RECORDED'), 'already'],
    [410, { error: { code: 'CODE_EXPIRED' } }, 'expired'],
    [410, { error: { code: 'CODE_REVOKED' } }, 'revoked'],
    [409, { error: { code: 'SESSION_NOT_STARTED' } }, 'not-started'],
    [409, { error: { code: 'SESSION_CLOSED' } }, 'closed'],
    [409, { error: { code: 'SESSION_ENDED' } }, 'ended'],
    [400, { error: { code: 'INVALID_CODE' } }, 'invalid'],
    [401, { error: { code: 'UNAUTHENTICATED' } }, 'signed-out'],
    [503, { error: { code: 'TRY_AGAIN' } }, 'retryable'],
    [500, { error: {} }, 'error'],
  ])('maps %i %j to %s', async (status, body, kind) => {
    mockApi({ 'POST /checkins': reply(status, body) });
    expect((await submitCheckIn(TOKEN, 'a')).kind).toBe(kind);
  });

  it('reports an invalidated record distinctly, and a rate limit with its wait', async () => {
    mockApi({
      'POST /checkins': reply(200, record('ALREADY_RECORDED', { attendanceStatus: 'INVALIDATED' })),
    });
    expect(await submitCheckIn(TOKEN, 'a')).toMatchObject({ kind: 'already', invalidated: true });
    mockApi({
      'POST /checkins': reply(429, { error: { code: 'RATE_LIMITED' } }, { 'Retry-After': '42' }),
    });
    expect(await submitCheckIn(TOKEN, 'a')).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: 42,
    });
  });

  it('treats a network failure as safe to retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(await submitCheckIn(TOKEN, 'a')).toEqual({ kind: 'retryable' });
  });
});
