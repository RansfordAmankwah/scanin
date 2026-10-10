import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QrDisplay } from '../src/features/lecturer/QrDisplay';

const toDataURL = vi.fn(async (value: string) => `data:image/png;base64,${btoa(value)}`);
vi.mock('qrcode', () => ({ default: { toDataURL: (...args: [string]) => toDataURL(...args) } }));

const COURSE = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const START = new Date('2026-10-10T12:00:00.000Z');

let tokenCounter = 0;
function minted(overrides: Record<string, unknown> = {}) {
  tokenCounter += 1;
  const issued = Date.now();
  return {
    token: `ST1.k1.SECRET-PAYLOAD-${tokenCounter}.SECRET-MAC-${tokenCounter}`,
    qrUrl: `https://app.test/c#t=ST1.k1.SECRET-PAYLOAD-${tokenCounter}.SECRET-MAC-${tokenCounter}`,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 180_000).toISOString(),
    refreshAfterSeconds: 30,
    checkInDeadline: new Date(issued + 25 * 60_000).toISOString(),
    ...overrides,
  };
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name] ?? null },
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  toDataURL.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('QrDisplay (projector view)', () => {
  it('shows the code with an accessible label and calls the API the way the server requires', async () => {
    fetchMock.mockResolvedValue(reply(200, minted()));
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();

    expect(screen.getByRole('img', { name: /qr code for checking in/i })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Scan to check in');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/courses/${COURSE}/sessions/${SESSION}/qr`);
    expect(init.headers['X-Requested-With']).toBe('scanin');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
  });

  it('draws the QR from the server-provided URL with a quiet zone', async () => {
    const body = minted();
    fetchMock.mockResolvedValue(reply(200, body));
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    expect(toDataURL).toHaveBeenCalledWith(
      body.qrUrl,
      expect.objectContaining({ margin: 4, errorCorrectionLevel: 'M' }),
    );
  });

  it('fetches a new code about every 30 seconds and swaps the image', async () => {
    fetchMock.mockImplementation(async () => reply(200, minted()));
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    const first = (screen.getByRole('img') as HTMLImageElement).src;

    await advance(29_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((screen.getByRole('img') as HTMLImageElement).src).not.toBe(first);

    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('counts down to the check-in deadline', async () => {
    fetchMock.mockResolvedValue(reply(200, minted()));
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    await advance(1000);
    expect(screen.getByText(/check-in closes in 24:5\d/i)).toBeTruthy();
  });

  it('stops asking and removes the code once check-in is closed', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, minted()))
      .mockResolvedValue(
        reply(409, { error: { code: 'CHECK_IN_NOT_OPEN', state: 'CHECK_IN_CLOSED' } }),
      );
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    await advance(31_000);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Check-in is closed');
    const calls = fetchMock.mock.calls.length;
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls); // no polling of a closed session
    expect(screen.queryByText(/invalidate/i)).toBeNull();
  });

  it('keeps the last code through a short outage, retrying quickly, but never shows an expired one', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, minted()))
      .mockRejectedValue(new TypeError('network down'));
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();

    await advance(31_000);
    expect(screen.getByRole('status').textContent).toContain('Reconnecting');
    expect(screen.getByRole('img')).toBeTruthy(); // still within its three minutes
    const during = fetchMock.mock.calls.length;
    await advance(10_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(during); // retrying every few seconds

    await advance(160_000); // past the code's expiry
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('recovers by itself when the network returns', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, minted()))
      .mockRejectedValueOnce(new TypeError('blip'))
      .mockResolvedValue(reply(200, minted()));
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    await advance(31_000);
    expect(screen.getByRole('status').textContent).toContain('Reconnecting');
    await advance(6_000);
    expect(screen.getByRole('status').textContent).toContain('Scan to check in');
  });

  it('asks the lecturer to sign in on 401 and obeys Retry-After on 429', async () => {
    fetchMock.mockResolvedValue(reply(401, { error: { code: 'UNAUTHENTICATED' } }));
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    expect(screen.getByRole('status').textContent).toContain('sign in');
    expect(screen.queryByRole('img')).toBeNull();
    cleanup();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        reply(429, { error: { code: 'RATE_LIMITED' } }, { 'Retry-After': '20' }),
      )
      .mockResolvedValue(reply(200, minted()));
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(11_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates shown codes only after confirmation, then fetches a fresh code', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/invalidate')
        ? reply(200, { invalidatedAt: '2026-10-10T12:00:05.000000Z' })
        : reply(200, minted()),
    );
    render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    const button = screen.getByRole('button', { name: /invalidate shown codes/i });

    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(button);
    await flush();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/invalidate'))).toBe(false);

    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(button);
    await flush();
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/invalidate'))!;
    expect(post[1].method).toBe('POST');
    expect(post[1].headers['X-Requested-With']).toBe('scanin');
    const mints = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/qr')).length;
    expect(mints).toBe(2); // the initial code, plus an immediate replacement
  });

  it('never writes codes to the console or leaves them as visible text', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    fetchMock.mockImplementation(async () => reply(200, minted()));
    const { container } = render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    await advance(31_000);

    expect(container.textContent).not.toContain('SECRET-');
    for (const spy of spies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('SECRET-');
    }
  });

  it('stops polling when the page is closed', async () => {
    fetchMock.mockImplementation(async () => reply(200, minted()));
    const { unmount } = render(<QrDisplay courseId={COURSE} sessionId={SESSION} />);
    await flush();
    unmount();
    const calls = fetchMock.mock.calls.length;
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
});
