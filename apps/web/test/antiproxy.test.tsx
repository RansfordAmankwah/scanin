import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { courseSession, studentHistory } from './helpers/fixtures';
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

const COURSE = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lecturer = { id: 'l1', role: 'LECTURER', fullName: 'Dr Owusu', emailVerified: true };
const student = { id: 's1', role: 'STUDENT', fullName: 'Ama Mensah', emailVerified: true };
const base = `/courses/${COURSE}/sessions/${SESSION}`;

const session = {
  id: SESSION,
  courseId: COURSE,
  title: 'Week 3 lecture',
  sessionDate: '2026-10-10',
  state: 'CHECK_IN_OPEN',
  startedAt: '2026-10-10T09:00:00.000Z',
  checkInDeadline: '2026-10-10T09:30:00.123456Z',
  checkInClosedAt: null,
  endedAt: null,
};
const record = (n: number, over: Record<string, unknown> = {}) => ({
  attendanceId: `a${n}`,
  studentId: `AB10${n}`,
  fullName: `Student ${n}`,
  status: 'PRESENT',
  source: 'QR_SCAN',
  associationState: 'PROVISIONAL',
  associationBasis: null,
  flagged: false,
  flagKinds: [],
  verification: null,
  disputeState: null,
  ...over,
});
const rosterWith = (records: unknown[], presentTotal = records.length) => ({
  counts: {
    presentTotal,
    confirmed: 0,
    provisional: presentTotal,
    reviewRequired: 0,
    invalidated: 0,
    flaggedPresent: 0,
  },
  records,
  noRecord: [],
});

const reconciliation = (over: Record<string, unknown> = {}) => ({
  sessionState: 'CHECK_IN_OPEN',
  headcount: null,
  history: [],
  recordedAttendance: 12,
  invalidated: 0,
  difference: null,
  status: 'NO_HEADCOUNT',
  tolerance: { percent: 15, minimum: 3, allowed: null },
  stale: { isStale: false, checkInsSince: 0, minutesSince: 0 },
  notes: [],
  limits: { headcountMax: 2000 },
  ...over,
});
const counted = (headcount: number, over: Record<string, unknown> = {}) =>
  reconciliation({
    headcount: {
      revNo: 1,
      headcount,
      previousHeadcount: null,
      explanation: null,
      recordedAt: '2026-10-10T09:10:00.000Z',
      recordedBy: 'Dr Owusu',
    },
    history: [],
    difference: 12 - headcount,
    status: 12 - headcount > 3 ? 'REVIEW_RECOMMENDED' : 'CONSISTENT',
    tolerance: { percent: 15, minimum: 3, allowed: 3 },
    ...over,
  });

const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: `item-${n}`,
  attendanceId: `a${n}`,
  studentId: `AB10${n}`,
  fullName: `Student ${n}`,
  selectionReason: 'RANDOM',
  riskFactors: [],
  state: 'PENDING',
  disputeId: null,
  disputeState: null,
  history: [],
  ...over,
});
const spot = (items: unknown[] = []) => ({
  rounds: items.length
    ? [
        {
          id: 'r1',
          createdAt: '2026-10-10T09:12:00.000Z',
          createdBy: 'Dr Owusu',
          requestedSize: 5,
          eligibleCount: 12,
          selectedCount: items.length,
          items,
        },
      ]
    : [],
  summary: { pending: items.length, verified: 0, notPresent: 0, couldNotVerify: 0 },
  limits: { defaultSize: 5, maxSize: 20 },
});

const dispute = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  attendanceId: 'a1',
  studentId: 'AB101',
  fullName: 'Student 1',
  state: 'OPEN',
  attendanceStatus: 'PRESENT',
  openedAt: '2026-10-10T09:20:00.000Z',
  resolvedAt: null,
  fromSpotCheck: true,
  events: [
    {
      eventNo: 1,
      kind: 'OPENED',
      note: null,
      at: '2026-10-10T09:20:00.000Z',
      by: 'Dr Owusu',
      byRole: 'LECTURER',
    },
    {
      eventNo: 2,
      kind: 'STUDENT_RESPONSE',
      note: 'I was in the lab next door.',
      at: '2026-10-10T09:25:00.000Z',
      by: 'Student 1',
      byRole: 'STUDENT',
    },
  ],
  ...over,
});

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function violations(container: Element = document.body) {
  const result = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, 'target-size': { enabled: false } },
    resultTypes: ['violations'],
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

/** The routes every session page needs, with the anti-proxy ones overridable per test. */
const sessionRoutes = (extra: Record<string, unknown> = {}) => ({
  'GET /auth/me': reply(200, { user: lecturer }),
  [`GET ${base}`]: () => reply(200, { session }),
  [`GET ${base}/attendance`]: () => reply(200, rosterWith([record(1), record(2)], 12)),
  [`GET ${base}/reconciliation`]: () => reply(200, reconciliation()),
  [`GET ${base}/spot-checks`]: () => reply(200, spot()),
  [`GET ${base}/disputes`]: () => reply(200, { disputes: [] }),
  [`GET ${base}/scans?limit=50`]: () => reply(200, { scans: [], nextCursor: null }),
  ...extra,
});
const open = () => render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
const sentTo = (fetchMock: ReturnType<typeof mockApi>, method: string, suffix: string) =>
  fetchMock.mock.calls.filter(
    (c) => (c[1]?.method ?? 'GET') === method && String(c[0]).endsWith(suffix),
  );

describe('room headcount', () => {
  it('asks for a headcount when there is none, and says what a gap does and does not mean', async () => {
    mockApi(sessionRoutes());
    open();
    await waitFor(() => screen.getByRole('heading', { name: 'Room headcount' }));
    expect(screen.getByText('No headcount yet')).toBeTruthy();
    expect(screen.getByText('No headcount recorded for this class yet')).toBeTruthy();
    expect(screen.getByText(/not proof of anything/i)).toBeTruthy();
    expect(screen.getByLabelText('People in the room')).toBeTruthy();
  });

  it('rejects a missing, malformed, negative, fractional or oversized number before sending anything', async () => {
    const fetchMock = mockApi(sessionRoutes());
    open();
    const input = await waitFor(() => screen.getByLabelText('People in the room'));
    for (const bad of ['abc', '-1', '2.5', '99999', '1e3']) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.submit(screen.getByRole('form', { name: /record headcount/i }));
      await waitFor(() => screen.getByRole('alert'));
      expect(screen.getByRole('alert').textContent).toMatch(/whole number from 0 to 2000/i);
    }
    expect(sentTo(fetchMock, 'PUT', '/headcount')).toHaveLength(0);
  });

  it('saves a headcount, then shows the difference, the status and the tolerance in plain words', async () => {
    const fetchMock = mockApi(
      sessionRoutes({
        [`PUT ${base}/headcount`]: () =>
          reply(200, { unchanged: false, reconciliation: counted(5) }),
      }),
    );
    open();
    fireEvent.change(await waitFor(() => screen.getByLabelText('People in the room')), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save headcount/i }));
    await waitFor(() => screen.getByText('Review recommended'));
    expect(bodyOf(sentTo(fetchMock, 'PUT', '/headcount')[0]!)).toEqual({ headcount: 5 });
    expect(screen.getByText('+7')).toBeTruthy();
    expect(screen.getByText(/can be innocent/i)).toBeTruthy();
    expect(screen.getByText(/up to 3 is treated as normal/i)).toBeTruthy();
    expect(screen.getByText('Headcount saved.')).toBeTruthy();
    // It is only ever a signal: nothing on this panel offers to change anyone's attendance.
    const panel = screen.getByRole('heading', { name: 'Room headcount' }).closest('section')!;
    expect(within(panel).queryByRole('button', { name: /invalidate|reject|remove/i })).toBeNull();
  });

  it('sends a correction with its reason, and does nothing when the number has not changed', async () => {
    let first = true;
    const fetchMock = mockApi(
      sessionRoutes({
        [`GET ${base}/reconciliation`]: () => reply(200, counted(5)),
        [`PUT ${base}/headcount`]: () => {
          const unchanged = !first;
          first = false;
          return reply(200, {
            unchanged,
            reconciliation: counted(8, {
              headcount: {
                revNo: 2,
                headcount: 8,
                previousHeadcount: 5,
                explanation: 'Recounted',
                recordedAt: '2026-10-10T09:30:00.000Z',
                recordedBy: 'Dr Owusu',
              },
            }),
          });
        },
      }),
    );
    open();
    const input = await waitFor(() => screen.getByLabelText('Correct the headcount'));
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText(/why are you changing it/i), {
      target: { value: 'Recounted' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }));
    await waitFor(() => screen.getByText('Headcount saved.'));
    expect(bodyOf(sentTo(fetchMock, 'PUT', '/headcount')[0]!)).toEqual({
      headcount: 8,
      explanation: 'Recounted',
    });
    expect(screen.getByText(/correction 1; it was 5/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Correct the headcount'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }));
    await waitFor(() => screen.getByText('That is already the recorded headcount.'));
  });

  it('ignores a second press while the first save is still in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = mockApi(
      sessionRoutes({
        [`PUT ${base}/headcount`]: async () => {
          await gate;
          return reply(200, { unchanged: false, reconciliation: counted(5) });
        },
      }),
    );
    open();
    fireEvent.change(await waitFor(() => screen.getByLabelText('People in the room')), {
      target: { value: '5' },
    });
    const form = screen.getByRole('form', { name: /record headcount/i });
    fireEvent.submit(form);
    fireEvent.submit(form);
    release();
    await waitFor(() => screen.getByText('Headcount saved.'));
    expect(sentTo(fetchMock, 'PUT', '/headcount')).toHaveLength(1);
  });

  it('warns when the count may be out of date, and shows lecturer notes', async () => {
    mockApi(
      sessionRoutes({
        [`GET ${base}/reconciliation`]: () =>
          reply(
            200,
            counted(5, {
              stale: { isStale: true, checkInsSince: 4, minutesSince: 41 },
              notes: [
                {
                  note: 'Six arrived late and left early',
                  statusAtTime: 'REVIEW_RECOMMENDED',
                  recordedAt: '2026-10-10T09:40:00.000Z',
                  recordedBy: 'Dr Owusu',
                },
              ],
            }),
          ),
      }),
    );
    open();
    await waitFor(() => screen.getByText('This headcount may be out of date'));
    expect(
      screen.getByText(/4 student\(s\) have been recorded since it was taken 41 minutes ago/i),
    ).toBeTruthy();
    expect(screen.getByText('Six arrived late and left early')).toBeTruthy();
  });

  it('only enables the note button once the note is long enough, and sends it', async () => {
    const fetchMock = mockApi(
      sessionRoutes({
        [`GET ${base}/reconciliation`]: () => reply(200, counted(5)),
        [`POST ${base}/reconciliation/notes`]: () =>
          reply(
            201,
            counted(5, {
              notes: [
                {
                  note: 'Six arrived late',
                  statusAtTime: 'REVIEW_RECOMMENDED',
                  recordedAt: '2026-10-10T09:40:00.000Z',
                  recordedBy: 'Dr Owusu',
                },
              ],
            }),
          ),
      }),
    );
    open();
    const note = await waitFor(() => screen.getByLabelText(/add a note about this difference/i));
    const save = screen.getByRole('button', { name: 'Save note' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(note, { target: { value: 'Six arrived late' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => screen.getByText('Note saved.'));
    expect(bodyOf(sentTo(fetchMock, 'POST', '/reconciliation/notes')[0]!)).toEqual({
      note: 'Six arrived late',
    });
  });

  it('is not shown before the session starts', async () => {
    mockApi(
      sessionRoutes({
        [`GET ${base}`]: () =>
          reply(200, {
            session: { ...session, state: 'NOT_STARTED', startedAt: null, checkInDeadline: null },
          }),
        [`GET ${base}/reconciliation`]: () =>
          reply(200, reconciliation({ sessionState: 'NOT_STARTED' })),
      }),
    );
    open();
    await waitFor(() => screen.getByRole('heading', { name: /week 3 lecture/i }));
    expect(screen.queryByRole('heading', { name: 'Room headcount' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Spot checks' })).toBeNull();
  });
});

describe('spot checks', () => {
  it('chooses students with the default size and an idempotency id, and explains why each was picked', async () => {
    const picked = [
      item(1),
      item(2, { selectionReason: 'RISK_WEIGHTED', riskFactors: ['DEVICE_SHARED_FLAG'] }),
    ];
    const fetchMock = mockApi(
      sessionRoutes({ [`POST ${base}/spot-checks`]: () => reply(201, spot(picked)) }),
    );
    open();
    await waitFor(() => screen.getByRole('heading', { name: 'Spot checks' }));
    expect(screen.getByText(/not an accusation/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /choose students to check/i }));
    await waitFor(() => screen.getByLabelText('AB101 Student 1'));
    const body = bodyOf(sentTo(fetchMock, 'POST', '/spot-checks')[0]!);
    expect(body.size).toBe(5);
    expect(String(body.requestId)).toMatch(UUID);
    expect(
      within(screen.getByLabelText('AB101 Student 1')).getByText('Picked at random.'),
    ).toBeTruthy();
    const risky = within(screen.getByLabelText('AB102 Student 2'));
    expect(
      risky.getByText(/higher chance because several students checked in from the same device/i),
    ).toBeTruthy();
    expect(risky.getByText(/not a finding about the student/i)).toBeTruthy();
  });

  it('refuses a sample outside the limits before asking the server', async () => {
    const fetchMock = mockApi(sessionRoutes());
    open();
    const size = await waitFor(() => screen.getByLabelText(/how many students/i));
    for (const bad of ['0', '21', '2.5', 'ten']) {
      fireEvent.change(size, { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: /choose students to check/i }));
      await waitFor(() => screen.getByText('Choose a whole number from 1 to 20.'));
    }
    expect(sentTo(fetchMock, 'POST', '/spot-checks')).toHaveLength(0);
  });

  it('explains when there is no one left to check', async () => {
    mockApi(
      sessionRoutes({
        [`POST ${base}/spot-checks`]: () => reply(409, { error: { code: 'NO_ELIGIBLE_STUDENTS' } }),
      }),
    );
    open();
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /choose students to check/i })),
    );
    await waitFor(() => screen.getByText(/no one left to check/i));
  });

  it('records "verified" with how it was checked, and a stable request id', async () => {
    const after = spot([
      item(1, {
        state: 'VERIFIED',
        history: [
          {
            eventNo: 1,
            from: 'PENDING',
            to: 'VERIFIED',
            method: 'ROSTER_PHOTO',
            explanation: null,
            at: '2026-10-10T09:15:00.000Z',
            by: 'Dr Owusu',
          },
        ],
      }),
    ]);
    const fetchMock = mockApi(
      sessionRoutes({
        [`GET ${base}/spot-checks`]: () => reply(200, spot([item(1)])),
        [`POST ${base}/spot-checks/items/item-1/result`]: () => reply(200, after),
      }),
    );
    open();
    const card = await waitFor(() => screen.getByLabelText('AB101 Student 1'));
    fireEvent.click(within(card).getByRole('button', { name: 'Verified in person' }));
    fireEvent.change(within(card).getByLabelText(/how did you verify/i), {
      target: { value: 'ROSTER_PHOTO' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Save result' }));
    await waitFor(() =>
      within(screen.getByLabelText('AB101 Student 1')).getByText('Verified in person'),
    );
    const sent = bodyOf(sentTo(fetchMock, 'POST', '/result')[0]!);
    expect(sent).toMatchObject({ outcome: 'VERIFIED', method: 'ROSTER_PHOTO' });
    expect(String(sent.requestId)).toMatch(UUID);
  });

  it('will not record "not found" without an explanation, and says it opens a review rather than changing attendance', async () => {
    const fetchMock = mockApi(
      sessionRoutes({
        [`GET ${base}/spot-checks`]: () => reply(200, spot([item(1)])),
        [`POST ${base}/spot-checks/items/item-1/result`]: () =>
          reply(
            200,
            spot([item(1, { state: 'NOT_PRESENT', disputeId: 'd1', disputeState: 'OPEN' })]),
          ),
      }),
    );
    open();
    const card = await waitFor(() => screen.getByLabelText('AB101 Student 1'));
    fireEvent.click(within(card).getByRole('button', { name: 'Not found in the room' }));
    expect(within(card).getByText(/opens a review/i)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Save result' }));
    await waitFor(() => within(card).getByText(/at least 10 characters/i));
    expect(sentTo(fetchMock, 'POST', '/result')).toHaveLength(0);

    fireEvent.change(within(card).getByLabelText(/what did you find/i), {
      target: { value: 'Called twice, no answer.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Save result' }));
    await waitFor(() =>
      within(screen.getByLabelText('AB101 Student 1')).getByText('Not found in the room'),
    );
    expect(
      within(screen.getByLabelText('AB101 Student 1')).getByText(
        /still counts while it is reviewed/i,
      ),
    ).toBeTruthy();
  });

  it('offers only the legal next results, and a correction needs a reason', async () => {
    mockApi(
      sessionRoutes({
        [`GET ${base}/spot-checks`]: () =>
          reply(
            200,
            spot([
              item(1, { state: 'VERIFIED' }),
              item(2, { state: 'COULD_NOT_VERIFY' }),
              item(3, { state: 'NOT_PRESENT', disputeId: 'd', disputeState: 'OPEN' }),
            ]),
          ),
      }),
    );
    open();
    const names = (n: number) =>
      within(screen.getByLabelText(`AB10${n} Student ${n}`))
        .queryAllByRole('button')
        .map((b) => b.textContent);
    await waitFor(() => screen.getByLabelText('AB101 Student 1'));
    expect(names(1)).toEqual(['Correct to: Not found in the room']);
    expect(names(2)).toEqual(['Verified in person', 'Not found in the room']);
    expect(names(3)).toEqual(['Correct to: Verified in person']);
    fireEvent.click(
      within(screen.getByLabelText('AB101 Student 1')).getByRole('button', { name: /correct to/i }),
    );
    expect(
      within(screen.getByLabelText('AB101 Student 1')).getByLabelText(
        /what did you find\? \(required\)/i,
      ),
    ).toBeTruthy();
  });

  it('sends one result when the button is pressed twice', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = mockApi(
      sessionRoutes({
        [`GET ${base}/spot-checks`]: () => reply(200, spot([item(1)])),
        [`POST ${base}/spot-checks/items/item-1/result`]: async () => {
          await gate;
          return reply(200, spot([item(1, { state: 'COULD_NOT_VERIFY' })]));
        },
      }),
    );
    open();
    const card = await waitFor(() => screen.getByLabelText('AB101 Student 1'));
    fireEvent.click(within(card).getByRole('button', { name: 'Could not verify' }));
    const form = within(card).getByRole('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    release();
    await waitFor(() =>
      within(screen.getByLabelText('AB101 Student 1')).getByText('Could not verify'),
    );
    expect(sentTo(fetchMock, 'POST', '/result')).toHaveLength(1);
  });
});

describe('records under review (lecturer)', () => {
  it('is hidden when nothing is under review', async () => {
    mockApi(sessionRoutes());
    open();
    await waitFor(() => screen.getByRole('heading', { name: 'Spot checks' }));
    expect(screen.queryByRole('heading', { name: 'Records under review' })).toBeNull();
  });

  it('shows the student’s reply and closes a review only with a reason, and a category when invalidating', async () => {
    const fetchMock = mockApi(
      sessionRoutes({
        [`GET ${base}/disputes`]: () => reply(200, { disputes: [dispute()] }),
        [`POST ${base}/disputes/d1/resolve`]: () =>
          reply(200, { disputeId: 'd1', state: 'RESOLVED_INVALIDATED', attendanceChanged: true }),
      }),
    );
    open();
    const card = await waitFor(() => screen.getByLabelText('Review of AB101 Student 1'));
    expect(within(card).getByText('Under review')).toBeTruthy();
    expect(within(card).getByText('I was in the lab next door.')).toBeTruthy();
    expect(
      within(card).getByText(/their attendance|attendance is currently recorded as present/i),
    ).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Invalidate this attendance' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Close the review' }));
    await waitFor(() => within(card).getByText(/at least 10 characters/i));
    expect(sentTo(fetchMock, 'POST', '/resolve')).toHaveLength(0);

    fireEvent.change(within(card).getByLabelText('Reason'), {
      target: { value: 'CONFIRMED_PROXY' },
    });
    fireEvent.change(within(card).getByLabelText(/your reason/i), {
      target: { value: 'A friend admitted scanning for them.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Close the review' }));
    await waitFor(() => expect(sentTo(fetchMock, 'POST', '/resolve')).toHaveLength(1));
    expect(bodyOf(sentTo(fetchMock, 'POST', '/resolve')[0]!)).toEqual({
      resolution: 'INVALIDATE',
      category: 'CONFIRMED_PROXY',
      explanation: 'A friend admitted scanning for them.',
    });
  });

  it('can keep the attendance without a category', async () => {
    const fetchMock = mockApi(
      sessionRoutes({
        [`GET ${base}/disputes`]: () => reply(200, { disputes: [dispute()] }),
        [`POST ${base}/disputes/d1/resolve`]: () =>
          reply(200, { disputeId: 'd1', state: 'RESOLVED_UPHELD', attendanceChanged: false }),
      }),
    );
    open();
    const card = await waitFor(() => screen.getByLabelText('Review of AB101 Student 1'));
    fireEvent.click(within(card).getByRole('button', { name: 'Keep this attendance' }));
    fireEvent.change(within(card).getByLabelText(/your reason/i), {
      target: { value: 'Another lecturer confirmed they were present.' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Close the review' }));
    await waitFor(() => expect(sentTo(fetchMock, 'POST', '/resolve')).toHaveLength(1));
    expect(bodyOf(sentTo(fetchMock, 'POST', '/resolve')[0]!)).toEqual({
      resolution: 'UPHOLD',
      explanation: 'Another lecturer confirmed they were present.',
    });
  });

  it('marks sampled and reviewed students in the attendance table', async () => {
    mockApi(
      sessionRoutes({
        [`GET ${base}/attendance`]: () =>
          reply(
            200,
            rosterWith([
              record(1, { verification: 'VERIFIED' }),
              record(2, { verification: 'NOT_PRESENT', disputeState: 'OPEN' }),
              record(3, { verification: 'PENDING' }),
            ]),
          ),
      }),
    );
    open();
    const table = await waitFor(() => screen.getByRole('table'));
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('Verified in person')).toBeTruthy();
    expect(within(rows[2]!).getByText('Not found in the room')).toBeTruthy();
    expect(within(rows[2]!).getByText('Under review')).toBeTruthy();
    expect(within(rows[3]!).queryByText('Not checked yet')).toBeNull(); // pending is not shown as a result
  });
});

describe('what a student sees', () => {
  const attendance = (review: unknown) =>
    studentHistory([courseSession({ id: SESSION, title: 'Week 3 lecture', review })]);
  const studentRoutes = (review: unknown, extra: Record<string, unknown> = {}) => ({
    'GET /auth/me': reply(200, { user: student }),
    [`GET /me/courses/${COURSE}`]: () => reply(200, attendance(review)),
    ...extra,
  });
  const openStudentCourse = async () => {
    const result = render(<App pathname={`/my/courses/${COURSE}`} />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /show details for week 3 lecture/i })),
    );
    return result;
  };
  const openReview = {
    id: 'd1',
    state: 'OPEN',
    openedAt: '2026-10-10T09:20:00.000Z',
    resolvedAt: null,
    repliesLeft: 5,
  };

  it('is told only that the record is being reviewed and that it still counts', async () => {
    mockApi(studentRoutes(openReview));
    await openStudentCourse();
    await waitFor(() => screen.getByText('Your lecturer is reviewing this record'));
    expect(screen.getByText(/still counts as present/i)).toBeTruthy();
    const page = document.body.textContent!.toLowerCase();
    for (const hidden of [
      'spot check',
      'sampled',
      'picked',
      'not found',
      'proxy',
      'flag',
      'headcount',
    ]) {
      expect(page).not.toContain(hidden);
    }
  });

  it('can reply, and a reply is sent once even if the button is pressed twice', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = mockApi(
      studentRoutes(openReview, {
        'POST /me/disputes/d1/response': async () => {
          await gate;
          return reply(201, { disputeId: 'd1' });
        },
      }),
    );
    await openStudentCourse();
    const box = await waitFor(() => screen.getByLabelText('Your reply'));
    expect((screen.getByRole('button', { name: 'Send reply' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(box, { target: { value: 'I was in the lab next door.' } });
    const form = screen.getByRole('form', { name: /reply about this record/i });
    fireEvent.submit(form);
    fireEvent.submit(form);
    release();
    await waitFor(() => screen.getByText('Your reply was sent to your lecturer.'));
    expect(sentTo(fetchMock, 'POST', '/response')).toHaveLength(1);
    expect(bodyOf(sentTo(fetchMock, 'POST', '/response')[0]!)).toEqual({
      note: 'I was in the lab next door.',
    });
  });

  it('explains when replies have run out, and shows the outcome once closed', async () => {
    mockApi(studentRoutes({ ...openReview, repliesLeft: 0 }));
    await openStudentCourse();
    await waitFor(() => screen.getByText(/used all your replies/i));
    expect(screen.queryByLabelText('Your reply')).toBeNull();
    cleanup();
    mockApi(
      studentRoutes({
        ...openReview,
        state: 'RESOLVED_UPHELD',
        resolvedAt: '2026-10-10T10:00:00.000Z',
      }),
    );
    await openStudentCourse();
    await waitFor(() => screen.getByText('Your lecturer reviewed this record and it stands.'));
    expect(screen.queryByLabelText('Your reply')).toBeNull();
  });

  it('shows nothing extra for a record that is not under review', async () => {
    mockApi(studentRoutes(null));
    await openStudentCourse();
    await waitFor(() => screen.getByText(/Recorded by/i));
    expect(screen.queryByText(/reviewing/i)).toBeNull();
  });
});

describe('accessibility of the new screens', () => {
  it('headcount, spot checks and reviews (forms open) have no axe violations', async () => {
    mockApi(
      sessionRoutes({
        [`GET ${base}/reconciliation`]: () =>
          reply(
            200,
            counted(5, {
              stale: { isStale: true, checkInsSince: 4, minutesSince: 41 },
              notes: [
                {
                  note: 'Six arrived late',
                  statusAtTime: 'REVIEW_RECOMMENDED',
                  recordedAt: '2026-10-10T09:40:00.000Z',
                  recordedBy: 'Dr Owusu',
                },
              ],
            }),
          ),
        [`GET ${base}/spot-checks`]: () =>
          reply(
            200,
            spot([
              item(1),
              item(2, {
                state: 'VERIFIED',
                history: [
                  {
                    eventNo: 1,
                    from: 'PENDING',
                    to: 'VERIFIED',
                    method: 'STUDENT_ID_CARD',
                    explanation: null,
                    at: '2026-10-10T09:15:00.000Z',
                    by: 'Dr Owusu',
                  },
                ],
              }),
              item(3, {
                selectionReason: 'RISK_WEIGHTED',
                riskFactors: ['PRIOR_NOT_PRESENT_RESULT'],
              }),
            ]),
          ),
        [`GET ${base}/disputes`]: () => reply(200, { disputes: [dispute()] }),
      }),
    );
    const { container } = open();
    await waitFor(() => screen.getByLabelText('Review of AB101 Student 1'));
    fireEvent.click(
      within(screen.getByLabelText('AB101 Student 1')).getByRole('button', {
        name: 'Verified in person',
      }),
    );
    fireEvent.click(
      within(screen.getByLabelText('AB103 Student 3')).getByRole('button', {
        name: 'Not found in the room',
      }),
    );
    fireEvent.click(
      within(screen.getByLabelText('Review of AB101 Student 1')).getByRole('button', {
        name: 'Invalidate this attendance',
      }),
    );
    expect(await violations(container)).toEqual([]);
  });

  it('the student review notice and reply form have no axe violations', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      [`GET /me/courses/${COURSE}`]: () =>
        reply(
          200,
          studentHistory([
            courseSession({
              id: SESSION,
              title: 'Week 3 lecture',
              review: {
                id: 'd1',
                state: 'OPEN',
                openedAt: '2026-10-10T09:20:00.000Z',
                resolvedAt: null,
                repliesLeft: 5,
              },
            }),
          ]),
        ),
    });
    const { container } = render(<App pathname={`/my/courses/${COURSE}`} />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /show details for week 3 lecture/i })),
    );
    await waitFor(() => screen.getByLabelText('Your reply'));
    expect(await violations(container)).toEqual([]);
  });
});
