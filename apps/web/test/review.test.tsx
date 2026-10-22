import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { courseChrome } from './helpers/fixtures';
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
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,AAAA' } }));

const COURSE = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const FLAG = '44444444-4444-4444-8444-444444444444';
const ATT = '55555555-5555-4555-8555-555555555555';
const lecturer = { id: 'l1', role: 'LECTURER', fullName: 'Dr Owusu', emailVerified: true };
const course = {
  id: COURSE,
  code: 'CS101',
  title: 'Intro',
  term: { id: 't', name: 'T1', startsOn: '2026-09-01', endsOn: '2026-12-20' },
};
const LONG = 'This is a sufficiently long explanation';

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const queue = {
  links: [
    {
      linkId: LINK,
      state: 'REVIEW_REQUIRED',
      studentId: 'ZZ100',
      fullName: 'Ama Mensa',
      email: 'ama@school.test',
      emailVerified: false,
      rosterEntry: null,
      attendanceCount: 2,
    },
  ],
  flags: [
    {
      flagId: FLAG,
      kind: 'CONFLICTING_STUDENT_ID',
      state: 'OPEN',
      origin: 'SYSTEM',
      linkId: LINK,
      attendanceId: null,
      studentId: 'ZZ100',
      fullName: 'Ama Mensa',
    },
  ],
};

function courseRoutes(over: Record<string, unknown> = {}) {
  return {
    'GET /auth/me': reply(200, { user: lecturer }),
    [`GET /courses/${COURSE}`]: reply(200, { course }),
    ...courseChrome([]),
    [`GET /courses/${COURSE}/review-queue`]: () => reply(200, queue),
    [`GET /courses/${COURSE}/links/${LINK}/suggestions`]: reply(200, {
      suggestionOnly: true,
      candidates: [{ entryId: 'e1', studentId: 'FZ900', fullName: 'Ama Mensah', similarity: 0.82 }],
    }),
    ...over,
  };
}
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('review queue', () => {
  it('lists matches and flags that need a decision, with honest wording about self-reported details', async () => {
    mockApi(courseRoutes());
    render(<App pathname={`/courses/${COURSE}/review`} />);
    const card = await waitFor(() => screen.getByRole('article', { name: /ZZ100 Ama Mensa/ }));
    expect(card.textContent).toContain('Not on the class list');
    expect(card.textContent).toContain('(not verified)');
    expect(card.textContent).toContain('Self-reported details');
    expect(card.textContent).toContain('2 attendance record(s)');
    expect(screen.getByRole('article', { name: /Flag: Conflicting student ID/ })).toBeTruthy();
    expect(screen.getByText(/does not verify\s+anyone elsewhere/i)).toBeTruthy();
  });

  it('says so when there is nothing to review', async () => {
    mockApi(
      courseRoutes({
        [`GET /courses/${COURSE}/review-queue`]: reply(200, { links: [], flags: [] }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/review`} />);
    await waitFor(() => screen.getByText(/nothing needs review right now/i));
  });

  it('records a decision only with a written explanation, shows suggestions as suggestions, and refreshes', async () => {
    let calls = 0;
    const fetchMock = mockApi(
      courseRoutes({
        [`GET /courses/${COURSE}/review-queue`]: () =>
          reply(200, ++calls === 1 ? queue : { links: [], flags: queue.flags }),
        [`POST /courses/${COURSE}/links/${LINK}/decision`]: reply(200, { state: 'CONFIRMED' }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/review`} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /more options/i })));
    const form = await waitFor(() => screen.getByRole('form', { name: /decide ZZ100/i }));

    const submit = within(form).getByRole('button', { name: /record decision/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true); // no explanation yet
    fireEvent.change(within(form).getByLabelText(/decision/i), {
      target: { value: 'CONFIRM_IDENTITY' },
    });
    expect(within(form).getByText(/suggestions only/i)).toBeTruthy();
    await waitFor(() =>
      within(form).getByRole('option', { name: /FZ900 Ama Mensah \(similarity 0.82\)/ }),
    );
    fireEvent.change(within(form).getByLabelText(/class-list entry/i), { target: { value: 'e1' } });
    fireEvent.change(within(form).getByLabelText(/written explanation/i), {
      target: { value: 'too short' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/written explanation/i), {
      target: { value: 'I know this student from tutorials' },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: /ZZ100 Ama Mensa/ })).toBeNull(),
    ); // left the queue
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/decision'))!;
    expect(bodyOf(call)).toEqual({
      decision: 'CONFIRM',
      basis: 'LECTURER_IDENTITY_CONFIRMED',
      entryId: 'e1',
      explanation: 'I know this student from tutorials',
    });
  });

  it('sends the other decisions without an entry or basis, and explains refusals in plain words', async () => {
    const fetchMock = mockApi(
      courseRoutes({
        [`POST /courses/${COURSE}/links/${LINK}/decision`]: reply(409, {
          error: { code: 'ENTRY_HELD' },
        }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/review`} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /more options/i })));
    const form = await waitFor(() => screen.getByRole('form', { name: /decide ZZ100/i }));
    fireEvent.change(within(form).getByLabelText(/decision/i), { target: { value: 'REJECT' } });
    fireEvent.change(within(form).getByLabelText(/written explanation/i), {
      target: { value: LONG },
    });
    fireEvent.click(within(form).getByRole('button', { name: /record decision/i }));
    await waitFor(() => screen.getByText(/another student is linked/i));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/decision'))!;
    expect(bodyOf(call)).toEqual({ decision: 'REJECT', explanation: LONG });
    expect(screen.getByRole('article', { name: /ZZ100/ })).toBeTruthy(); // still in the queue
  });

  it("shows a match's history with who decided what and why", async () => {
    mockApi(
      courseRoutes({
        [`GET /courses/${COURSE}/links/${LINK}/history`]: reply(200, {
          reviews: [
            {
              reviewNo: 1,
              decision: 'SYSTEM_MATCH',
              fromState: null,
              toState: 'REVIEW_REQUIRED',
              actor: 'System',
              explanation: null,
              decidedAt: '',
            },
            {
              reviewNo: 2,
              decision: 'REJECT',
              fromState: 'REVIEW_REQUIRED',
              toState: 'REJECTED',
              actor: 'Dr Owusu',
              explanation: 'Not the owner of this ID',
              decidedAt: '',
            },
          ],
        }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/review`} />);
    const card = await waitFor(() => screen.getByRole('article', { name: /ZZ100 Ama Mensa/ }));
    fireEvent.click(within(card).getByRole('button', { name: /history/i }));
    const list = await waitFor(() => within(card).getByRole('list', { name: /match history/i }));
    expect(list.textContent).toContain('System: system match → review required');
    expect(list.textContent).toContain('Dr Owusu: reject → rejected (“Not the owner of this ID”)');
  });

  it('flags move through review with notes, and say that resolving them does not change attendance', async () => {
    const fetchMock = mockApi(
      courseRoutes({
        [`POST /courses/${COURSE}/flags/${FLAG}/transition`]: reply(200, { state: 'UNDER_REVIEW' }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/review`} />);
    const flag = await waitFor(() =>
      screen.getByRole('article', { name: /Flag: Conflicting student ID/ }),
    );
    fireEvent.click(within(flag).getByRole('button', { name: /start review/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/transition'))).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/transition'))!;
    expect(bodyOf(call)).toEqual({ to: 'UNDER_REVIEW', note: '' });
  });

  it('resolving a flag needs a written note and states it does not touch attendance', async () => {
    const underReview = { links: [], flags: [{ ...queue.flags[0], state: 'UNDER_REVIEW' }] };
    const fetchMock = mockApi(
      courseRoutes({
        [`GET /courses/${COURSE}/review-queue`]: reply(200, underReview),
        [`POST /courses/${COURSE}/flags/${FLAG}/transition`]: reply(200, { state: 'DISMISSED' }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/review`} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /dismiss…/i })));
    const form = await waitFor(() => screen.getByRole('form', { name: /dismiss flag/i }));
    expect(within(form).getByText(/does not change attendance/i)).toBeTruthy();
    const submit = within(form).getByRole('button', { name: /dismiss flag/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/written explanation/i), {
      target: { value: 'Looked into it: a misunderstanding' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/transition'))).toBe(true),
    );
    expect(bodyOf(fetchMock.mock.calls.find(([u]) => String(u).endsWith('/transition'))!)).toEqual({
      to: 'DISMISSED',
      note: 'Looked into it: a misunderstanding',
    });
  });
});

describe('correcting attendance from the session page', () => {
  const roster = (status: 'PRESENT' | 'INVALIDATED' = 'PRESENT') => ({
    counts: {
      presentTotal: 1,
      confirmed: 0,
      provisional: 1,
      reviewRequired: 0,
      invalidated: 0,
      flaggedPresent: 0,
    },
    records: [
      {
        attendanceId: ATT,
        studentId: 'AB100',
        fullName: 'Ama Mensah',
        status,
        source: 'QR_SCAN',
        associationState: 'PROVISIONAL',
        associationBasis: null,
        flagged: false,
        flagKinds: [],
      },
    ],
    noRecord: [],
  });
  const base = `/courses/${COURSE}/sessions/${SESSION}`;
  const session = {
    id: SESSION,
    courseId: COURSE,
    title: 'Week 3',
    sessionDate: '2026-10-10',
    state: 'CHECK_IN_OPEN',
    startedAt: 'x',
    checkInDeadline: '2026-10-10T09:30:00.000000Z',
    checkInClosedAt: null,
    endedAt: null,
  };
  const routes = (over: Record<string, unknown> = {}) => ({
    'GET /auth/me': reply(200, { user: lecturer }),
    [`GET ${base}`]: reply(200, { session }),
    [`GET ${base}/attendance`]: () => reply(200, roster()),
    ...over,
  });

  it('invalidates with a reason category and a written explanation, then refreshes', async () => {
    const fetchMock = mockApi(
      routes({
        [`POST ${base}/attendance/${ATT}/invalidate`]: reply(200, { status: 'INVALIDATED' }),
      }),
    );
    render(<App pathname={base} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /invalidate…/i })));
    const form = await waitFor(() => screen.getByRole('form', { name: /invalidate AB100/i }));
    const options = within(form)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'Incorrect attendance entry',
      'Confirmed proxy attendance',
      'Duplicate or erroneous record',
      'Identity/enrollment mismatch',
      'Other',
    ]);

    const submit = within(form).getByRole('button', {
      name: /invalidate attendance/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/reason/i), {
      target: { value: 'CONFIRMED_PROXY' },
    });
    fireEvent.change(within(form).getByLabelText(/written explanation/i), {
      target: { value: 'Student admitted a friend scanned for them' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/invalidate'))).toBe(true),
    );
    expect(bodyOf(fetchMock.mock.calls.find(([u]) => String(u).endsWith('/invalidate'))!)).toEqual({
      category: 'CONFIRMED_PROXY',
      explanation: 'Student admitted a friend scanned for them',
    });
  });

  it('offers Restore (with an explanation) instead of Invalidate for an invalidated record', async () => {
    const fetchMock = mockApi(
      routes({
        [`GET ${base}/attendance`]: () => reply(200, roster('INVALIDATED')),
        [`POST ${base}/attendance/${ATT}/restore`]: reply(200, { status: 'PRESENT' }),
      }),
    );
    render(<App pathname={base} />);
    expect(await waitFor(() => screen.getByRole('button', { name: /restore…/i }))).toBeTruthy();
    expect(screen.queryByRole('button', { name: /invalidate…/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /restore…/i }));
    const form = await waitFor(() => screen.getByRole('form', { name: /restore AB100/i }));
    fireEvent.change(within(form).getByLabelText(/written explanation/i), {
      target: { value: 'Verified they were in the room' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /restore attendance/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/restore'))).toBe(true),
    );
  });

  it('shows the full revision history of a record', async () => {
    mockApi(
      routes({
        [`GET ${base}/attendance/${ATT}/history`]: reply(200, {
          revisions: [
            {
              revNo: 1,
              kind: 'CREATED_QR',
              fromStatus: null,
              toStatus: 'PRESENT',
              category: null,
              explanation: null,
              actor: 'Ama Mensah',
              at: '',
            },
            {
              revNo: 2,
              kind: 'INVALIDATED',
              fromStatus: 'PRESENT',
              toStatus: 'INVALIDATED',
              category: 'OTHER',
              explanation: 'Entered in error',
              actor: 'Dr Owusu',
              at: '',
            },
          ],
        }),
      }),
    );
    render(<App pathname={base} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /^history$/i })));
    await waitFor(() => screen.getByText(/History for AB100/));
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toContain('Checked in by QR scan by Ama Mensah');
    expect(items).toContain('Invalidated by Dr Owusu (Other): “Entered in error”');
  });

  it('raising a flag from a record says it does not change attendance', async () => {
    const fetchMock = mockApi(
      routes({ [`POST /courses/${COURSE}/flags`]: reply(201, { flagId: FLAG }) }),
    );
    render(<App pathname={base} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /flag…/i })));
    const form = await waitFor(() => screen.getByRole('form', { name: /flag AB100/i }));
    expect(within(form).getByText(/does not change this attendance record/i)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(/written explanation/i), {
      target: { value: 'Phone passed along the row' },
    });
    fireEvent.click(within(form).getByRole('button', { name: /raise flag/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/flags'))).toBe(true),
    );
    expect(bodyOf(fetchMock.mock.calls.find(([u]) => String(u).endsWith('/flags'))!)).toEqual({
      kind: 'PROXY_SUSPECTED',
      attendanceId: ATT,
      note: 'Phone passed along the row',
    });
  });

  it('marks a registered student present with a reason, and explains why an unregistered one cannot be', async () => {
    let attempt = 0;
    const fetchMock = mockApi(
      routes({
        [`POST ${base}/attendance/manual`]: () =>
          ++attempt === 1
            ? reply(404, { error: { code: 'STUDENT_NOT_REGISTERED' } })
            : reply(201, { student: { studentId: 'ZZ500', fullName: 'Kofi Boateng' } }),
      }),
    );
    render(<App pathname={base} />);
    const form = await waitFor(() => screen.getByRole('form', { name: /mark present/i }));
    const submit = within(form).getByRole('button', { name: /mark present/i }) as HTMLButtonElement;
    type('Student ID', 'ZZ500');
    expect(submit.disabled).toBe(true); // reason required
    fireEvent.change(within(form).getByLabelText(/reason/i), {
      target: { value: 'Camera broken, saw them in class' },
    });
    fireEvent.click(submit);
    await waitFor(() => screen.getByText(/has not created an account yet/i));

    fireEvent.click(submit);
    await waitFor(() => screen.getByText(/Kofi Boateng \(ZZ500\) is marked present by you/));
    expect(bodyOf(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/manual'))[1]!)).toEqual(
      { studentId: 'ZZ500', explanation: 'Camera broken, saw them in class' },
    );
    await flush();
  });

  it('hides manual marking until the session has started', async () => {
    mockApi(
      routes({
        [`GET ${base}`]: reply(200, {
          session: { ...session, state: 'NOT_STARTED', checkInDeadline: null },
        }),
      }),
    );
    render(<App pathname={base} />);
    await waitFor(() => screen.getByRole('button', { name: /start check-in/i }));
    expect(screen.queryByRole('form', { name: /mark present/i })).toBeNull();
  });
});

describe('exporting from the session page', () => {
  const base = `/courses/${COURSE}/sessions/${SESSION}`;
  const session = {
    id: SESSION,
    courseId: COURSE,
    title: 'Week 3',
    sessionDate: '2026-10-10',
    state: 'ENDED',
    startedAt: 'x',
    checkInDeadline: '2026-10-10T09:30:00.000000Z',
    checkInClosedAt: 'x',
    endedAt: 'x',
  };
  const routes = (over: Record<string, unknown> = {}) => ({
    'GET /auth/me': reply(200, { user: lecturer }),
    [`GET ${base}`]: reply(200, { session }),
    [`GET ${base}/attendance`]: reply(200, {
      counts: {
        presentTotal: 0,
        confirmed: 0,
        provisional: 0,
        reviewRequired: 0,
        invalidated: 0,
        flaggedPresent: 0,
      },
      records: [],
      noRecord: [],
    }),
    ...over,
  });

  it('offers all four formats and both reports, and says which one includes scan times', async () => {
    mockApi(routes());
    render(<App pathname={base} />);
    const form = await waitFor(() => screen.getByRole('form', { name: /create export/i }));
    expect(
      within(form)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Attendance report (no scan times)',
      'Scan history (includes every scan time)',
      'CSV (spreadsheet-friendly text)',
      'Excel (.xlsx)',
      'PDF',
      'Word (.docx)',
    ]);
  });

  it('requests the chosen report and format, then offers a download link and the expiry', async () => {
    const fetchMock = mockApi(
      routes({
        [`POST /courses/${COURSE}/exports`]: reply(201, {
          export: {
            id: 'e1',
            filename: 'attendance-CS101-2026-10-10-abcd1234.xlsx',
            format: 'XLSX',
            kind: 'SCAN_HISTORY',
            rowCount: 12,
            expiresAt: new Date(Date.now() + 59 * 60_000).toISOString(),
            downloadPath: '/exports/e1/download',
          },
        }),
      }),
    );
    render(<App pathname={base} />);
    const form = await waitFor(() => screen.getByRole('form', { name: /create export/i }));
    fireEvent.change(within(form).getByLabelText('Report'), { target: { value: 'SCAN_HISTORY' } });
    fireEvent.change(within(form).getByLabelText('Format'), { target: { value: 'XLSX' } });
    fireEvent.click(within(form).getByRole('button', { name: /create export/i }));

    const link = await waitFor(() =>
      screen.getByRole('link', { name: /download attendance-CS101/i }),
    );
    expect(link.getAttribute('href')).toBe('/api/exports/e1/download');
    expect(screen.getByText(/12 row\(s\)/)).toBeTruthy();
    expect(screen.getByText(/removed in about 5[89] minute/)).toBeTruthy();
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/exports'))!;
    expect(bodyOf(call)).toEqual({ sessionId: SESSION, kind: 'SCAN_HISTORY', format: 'XLSX' });
  });

  it('explains a rate limit in plain words', async () => {
    mockApi(
      routes({
        [`POST /courses/${COURSE}/exports`]: reply(429, { error: { code: 'RATE_LIMITED' } }),
      }),
    );
    render(<App pathname={base} />);
    const form = await waitFor(() => screen.getByRole('form', { name: /create export/i }));
    fireEvent.click(within(form).getByRole('button', { name: /create export/i }));
    await waitFor(() => screen.getByText(/too many exports/i));
  });

  it('is not offered before a session has started', async () => {
    mockApi(
      routes({
        [`GET ${base}`]: reply(200, {
          session: { ...session, state: 'NOT_STARTED', checkInDeadline: null },
        }),
      }),
    );
    render(<App pathname={base} />);
    await waitFor(() => screen.getByRole('button', { name: /start check-in/i }));
    expect(screen.queryByRole('form', { name: /create export/i })).toBeNull();
  });
});
