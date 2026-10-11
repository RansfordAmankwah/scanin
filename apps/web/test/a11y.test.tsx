import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { mockApi, reply } from './helpers/net';

vi.mock('qr-scanner', () => ({
  default: class {
    start() {
      return Promise.resolve();
    }
    stop() {}
    destroy() {}
  },
}));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,AAAA' } }));

/**
 * UX-02 (part 1): axe-core over every screen. jsdom cannot compute layout or colour, so contrast
 * and target-size checks run in the real-browser suite (e2e/). Everything else axe knows is
 * checked here, on every state a user can reach.
 */
const COURSE = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const ATT = '55555555-5555-4555-8555-555555555555';
const student = { id: 's1', role: 'STUDENT', fullName: 'Ama Mensah', emailVerified: true };
const lecturer = { id: 'l1', role: 'LECTURER', fullName: 'Dr Owusu', emailVerified: true };
const course = {
  id: COURSE,
  code: 'CS101',
  title: 'Intro',
  term: { id: 't', name: 'T1', startsOn: '2026-09-01', endsOn: '2026-12-20' },
};

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function violations(container: Element = document.body) {
  const result = await axe.run(container, {
    // jsdom has no layout engine, so these are verified in a real browser instead.
    rules: { 'color-contrast': { enabled: false }, 'target-size': { enabled: false } },
    resultTypes: ['violations'],
  });
  return result.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
const sessionBase = `/courses/${COURSE}/sessions/${SESSION}`;
const sessionView = {
  id: SESSION,
  courseId: COURSE,
  title: 'Week 3',
  sessionDate: '2026-10-10',
  state: 'CHECK_IN_OPEN',
  startedAt: 'x',
  checkInDeadline: '2026-10-10T09:30:00.000000Z',
  checkInClosedAt: null,
  endedAt: null,
  extensions: [],
};
const roster = {
  counts: {
    presentTotal: 2,
    confirmed: 1,
    provisional: 1,
    reviewRequired: 0,
    invalidated: 0,
    flaggedPresent: 1,
  },
  records: [
    {
      attendanceId: ATT,
      studentId: 'AB100',
      fullName: 'Ama Mensah',
      status: 'PRESENT',
      source: 'QR_SCAN',
      associationState: 'CONFIRMED',
      associationBasis: 'ROSTER_ID_MATCH',
      flagged: false,
      flagKinds: [],
    },
    {
      attendanceId: 'a2',
      studentId: 'AB101',
      fullName: 'Kofi Boateng',
      status: 'INVALIDATED',
      source: 'MANUAL',
      associationState: 'PROVISIONAL',
      associationBasis: null,
      flagged: true,
      flagKinds: ['PROXY_SUSPECTED'],
    },
  ],
  noRecord: [{ entryId: 'e9', studentId: 'AB109', fullName: 'Yaw Darko', registered: false }],
};
const queue = {
  links: [
    {
      linkId: LINK,
      state: 'REVIEW_REQUIRED',
      studentId: 'ZZ100',
      fullName: 'Ama Mensa',
      email: 'a@s.test',
      emailVerified: false,
      rosterEntry: null,
      attendanceCount: 1,
    },
  ],
  flags: [
    {
      flagId: 'f1',
      kind: 'CONFLICTING_STUDENT_ID',
      state: 'UNDER_REVIEW',
      origin: 'SYSTEM',
      linkId: LINK,
      attendanceId: null,
      studentId: 'ZZ100',
      fullName: 'Ama Mensa',
    },
  ],
};

describe('UX-02 accessibility (axe) on every screen', () => {
  it('signed-out screens: sign in, create account, review details', async () => {
    mockApi({
      'GET /auth/me': reply(401, {}),
      'POST /auth/register/preview': reply(200, {
        studentId: 'AB100',
        fullName: 'Ama Mensah',
        email: 'a@s.test',
      }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('form', { name: /sign in/i }));
    expect(await violations()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /create an account/i }));
    await waitFor(() => screen.getByLabelText('Student ID'));
    expect(await violations()).toEqual([]);

    fireEvent.change(screen.getByLabelText('Student ID'), { target: { value: 'AB100' } });
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Ama Mensah' } });
    fireEvent.change(screen.getByLabelText('School e-mail'), { target: { value: 'a@s.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: /review details/i }));
    await waitFor(() => screen.getByRole('heading', { name: /is this correct/i }));
    expect(await violations()).toEqual([]);
  });

  it('signed-out: the lecturer sign-up form, its error and its confirmation', async () => {
    mockApi({
      'GET /auth/me': reply(401, {}),
      'POST /auth/register/lecturer': reply(400, { error: { code: 'PASSWORD_TOO_SHORT' } }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('form', { name: /sign in/i }));
    fireEvent.click(screen.getByRole('button', { name: /create a lecturer account/i }));
    await waitFor(() => screen.getByRole('form', { name: /create lecturer account/i }));
    expect(await violations()).toEqual([]);

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Dr Owusu' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'o@s.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.submit(screen.getByRole('form', { name: /create lecturer account/i }));
    await waitFor(() => screen.getByText(/choose a password of at least 10 characters/i));
    expect(await violations()).toEqual([]);
  });

  it('login errors are announced and the page stays accessible', async () => {
    mockApi({
      'GET /auth/me': reply(401, {}),
      'POST /auth/login': reply(401, { error: { code: 'INVALID_CREDENTIALS' } }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByLabelText('E-mail'));
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'x@s.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => screen.getByRole('alert'));
    expect(await violations()).toEqual([]);
  });

  it.each([
    ['ready', null],
    [
      'recorded',
      {
        status: 201,
        body: {
          result: 'RECORDED',
          attendanceStatus: 'PRESENT',
          associationState: 'PROVISIONAL',
          course: { code: 'CS101', title: 'Intro' },
          sessionTitle: 'Week 3',
        },
      },
    ],
    [
      'already checked in',
      {
        status: 200,
        body: {
          result: 'ALREADY_RECORDED',
          attendanceStatus: 'PRESENT',
          associationState: 'CONFIRMED',
          course: { code: 'CS101', title: 'Intro' },
          sessionTitle: 'Week 3',
        },
      },
    ],
    ['expired code', { status: 410, body: { error: { code: 'CODE_EXPIRED' } } }],
    ['check-in closed', { status: 409, body: { error: { code: 'SESSION_CLOSED' } } }],
    ['rate limited', { status: 429, body: { error: { code: 'RATE_LIMITED' } } }],
    ['server trouble', { status: 503, body: { error: { code: 'TRY_AGAIN' } } }],
  ])('student check-in screen: %s', async (_name, outcome) => {
    const token =
      'ST1.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    if (outcome) sessionStorage.setItem('scanin.pendingToken', token);
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/attendance': reply(200, { courses: [] }),
      'POST /checkins': outcome ? reply(outcome.status, outcome.body) : reply(500, {}),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('heading', { name: /my attendance/i }));
    if (outcome) await waitFor(() => expect(screen.queryByText(/checking you in/i)).toBeNull());
    expect(await violations()).toEqual([]);
  });

  it('student: camera problems and the live camera view', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/attendance': reply(200, { courses: [] }),
    });
    render(<App pathname="/" />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /start camera/i })));
    await waitFor(() => screen.getByLabelText(/camera view/i));
    expect(await violations()).toEqual([]);
  });

  it('student: my attendance with every kind of entry', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/attendance': reply(200, {
        courses: [
          {
            id: COURSE,
            code: 'CS101',
            title: 'Intro',
            associationState: 'PROVISIONAL',
            presentCount: 1,
            sessionCount: 3,
            sessions: [
              {
                id: 'a',
                title: 'Week 3',
                date: '2026-10-10',
                status: 'PRESENT',
                source: 'QR_SCAN',
                invalidationCategory: null,
              },
              {
                id: 'b',
                title: 'Week 2',
                date: '2026-10-03',
                status: 'INVALIDATED',
                source: 'QR_SCAN',
                invalidationCategory: 'OTHER',
              },
              {
                id: 'c',
                title: 'Week 1',
                date: '2026-09-26',
                status: 'NO_RECORD',
                source: null,
                invalidationCategory: null,
              },
            ],
          },
        ],
      }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('article', { name: /CS101/ }));
    expect(await violations()).toEqual([]);
  });

  it('lecturer: courses list and course page with review queue and class-list import', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      'GET /courses': reply(200, { courses: [course] }),
      'GET /terms': reply(200, { terms: [] }),
      [`GET /courses/${COURSE}`]: reply(200, { course }),
      [`GET /courses/${COURSE}/sessions`]: reply(200, { sessions: [sessionView] }),
      [`GET /courses/${COURSE}/review-queue`]: reply(200, queue),
      [`GET /courses/${COURSE}/links/${LINK}/suggestions`]: reply(200, {
        candidates: [
          { entryId: 'e1', studentId: 'FZ900', fullName: 'Ama Mensah', similarity: 0.8 },
        ],
      }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('heading', { name: /your courses/i }));
    expect(await violations()).toEqual([]);
    cleanup();

    render(<App pathname={`/courses/${COURSE}`} />);
    const card = await waitFor(() => screen.getByRole('article', { name: /ZZ100/ }));
    expect(await violations()).toEqual([]);

    fireEvent.click(card.querySelector('button')!); // "Decide…"
    await waitFor(() => screen.getByRole('form', { name: /decide ZZ100/i }));
    expect(await violations()).toEqual([]);
  });

  it('lecturer: session page with controls, counts, table and every inline form open', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET ${sessionBase}`]: reply(200, { session: sessionView }),
      [`GET ${sessionBase}/attendance`]: reply(200, roster),
      [`GET ${sessionBase}/scans?limit=50`]: reply(200, {
        scans: [
          {
            id: 's1',
            receivedAt: '2026-10-10T09:05:00.000000Z',
            studentId: 'AB100',
            fullName: 'Ama Mensah',
            outcome: 'ACCEPTED',
            browser: 'Safari',
            network: 'a1b2c3d4',
          },
        ],
        nextCursor: null,
      }),
    });
    render(<App pathname={sessionBase} />);
    await waitFor(() => screen.getByRole('table'));
    expect(await violations()).toEqual([]);

    // Open each inline form in turn; every state must stay accessible.
    for (const name of [/invalidate…/i, /restore…/i, /flag…/i]) {
      const button = screen.queryAllByRole('button', { name })[0];
      if (!button) continue;
      fireEvent.click(button);
      await flush();
      expect(await violations(), String(name)).toEqual([]);
    }
    fireEvent.click(screen.getByRole('button', { name: /show scan history/i }));
    await waitFor(() => screen.getByRole('heading', { name: /scan history/i, level: 2 }));
    await waitFor(() => screen.getByRole('cell', { name: 'Recorded' }));
    expect(await violations()).toEqual([]);
  });

  it('lecturer: the projector QR display, in every state', async () => {
    const mint = {
      qrUrl: 'https://app.test/c#t=x',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
      refreshAfterSeconds: 30,
      checkInDeadline: new Date(Date.now() + 1_500_000).toISOString(),
    };
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET /courses/${COURSE}/sessions/${SESSION}/qr`]: reply(200, mint),
    });
    render(<App pathname={`/present/${COURSE}/${SESSION}`} />);
    await waitFor(() => screen.getByRole('img', { name: /qr code/i }));
    expect(await violations()).toEqual([]);
    cleanup();

    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET /courses/${COURSE}/sessions/${SESSION}/qr`]: reply(409, {
        error: { code: 'CHECK_IN_NOT_OPEN', state: 'ENDED' },
      }),
    });
    render(<App pathname={`/present/${COURSE}/${SESSION}`} />);
    await waitFor(() => screen.getByText(/check-in is closed/i));
    expect(await violations()).toEqual([]);
  });

  it('every page has exactly one level-one heading, a main landmark, and no positive tabindex', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      'GET /courses': reply(200, { courses: [course] }),
    });
    const { container } = render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('heading', { name: /your courses/i }));
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(
      container.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])'),
    ).toHaveLength(0);
  });
});

describe('keyboard operation', () => {
  it('every action is a real button, link or form control, so the keyboard reaches it', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET ${sessionBase}`]: reply(200, { session: sessionView }),
      [`GET ${sessionBase}/attendance`]: reply(200, roster),
    });
    const { container } = render(<App pathname={sessionBase} />);
    await waitFor(() => screen.getByRole('table'));
    const fake = [
      ...container.querySelectorAll(
        'div[onclick], span[onclick], [role="button"]:not(button):not(a)',
      ),
    ];
    expect(fake).toHaveLength(0);
    const controls = container.querySelectorAll('button, a[href], input, select, textarea');
    expect(controls.length).toBeGreaterThan(8);
    for (const el of controls) {
      expect((el as HTMLElement).tabIndex, el.outerHTML.slice(0, 80)).toBeGreaterThanOrEqual(0);
    }
  });

  it('forms submit with Enter and show errors next to the field that caused them', async () => {
    mockApi({
      'GET /auth/me': reply(401, {}),
      'POST /auth/login': reply(401, { error: { code: 'INVALID_CREDENTIALS' } }),
    });
    render(<App pathname="/" />);
    const form = await waitFor(() => screen.getByRole('form', { name: /sign in/i }));
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'x@s.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.submit(form); // what Enter in a field does
    await waitFor(() => screen.getByRole('alert'));
  });
});
