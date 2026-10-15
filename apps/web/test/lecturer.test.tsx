import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  courseChrome,
  courseSession,
  emptyClassList,
  overview,
  overviewCourse,
  studentCourse,
  studentHistory,
  summaryFor,
} from './helpers/fixtures';
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
const lecturer = { id: 'l1', role: 'LECTURER', fullName: 'Dr Owusu', emailVerified: true };
const student = { id: 's1', role: 'STUDENT', fullName: 'Ama Mensah', emailVerified: true };

const course = {
  id: COURSE,
  code: 'CS101',
  title: 'Intro to CS',
  term: { id: 't', name: 'Autumn 2026', startsOn: '2026-09-01', endsOn: '2026-12-20' },
};
const sessionView = (over: Record<string, unknown> = {}) => ({
  id: SESSION,
  courseId: COURSE,
  title: 'Week 3 lecture',
  sessionDate: '2026-10-10',
  state: 'CHECK_IN_OPEN',
  startedAt: '2026-10-10T09:00:00.000Z',
  checkInDeadline: '2026-10-10T09:30:00.123456Z',
  checkInClosedAt: null,
  endedAt: null,
  ...over,
});
const roster = (over: Record<string, unknown> = {}) => ({
  counts: {
    presentTotal: 3,
    confirmed: 1,
    provisional: 1,
    reviewRequired: 1,
    invalidated: 1,
    flaggedPresent: 1,
  },
  records: [
    {
      attendanceId: 'a1',
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
      status: 'PRESENT',
      source: 'MANUAL',
      associationState: 'PROVISIONAL',
      associationBasis: null,
      flagged: true,
      flagKinds: ['PROXY_SUSPECTED'],
    },
    {
      attendanceId: 'a3',
      studentId: 'AB102',
      fullName: 'Esi Owusu',
      status: 'INVALIDATED',
      source: 'QR_SCAN',
      associationState: 'REVIEW_REQUIRED',
      associationBasis: null,
      flagged: false,
      flagKinds: [],
    },
  ],
  noRecord: [{ entryId: 'e9', studentId: 'AB109', fullName: 'Yaw Darko', registered: false }],
  ...over,
});

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
const signedInLecturer = {
  'GET /auth/me': reply(200, { user: lecturer }),
  'GET /terms': reply(200, { terms: [] }),
};

describe('lecturer: courses and sessions', () => {
  it("lists the lecturer's courses and links to each", async () => {
    mockApi({ ...signedInLecturer, 'GET /courses/overview': overview() });
    render(<App pathname="/" />);
    const link = await waitFor(() => screen.getByRole('link', { name: /CS101 Intro to CS/ }));
    expect(link.getAttribute('href')).toBe(`/courses/${COURSE}`);
    expect(screen.getByText(/Autumn 2026/)).toBeTruthy();
  });

  it('invites a lecturer with no courses to create their first one', async () => {
    mockApi({ ...signedInLecturer, 'GET /courses/overview': overview([]) });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByText(/create your first course below/i));
    expect(screen.getByRole('form', { name: /create course/i })).toBeTruthy();
  });

  it('creates a course with a new term of their own, and shows it in the list', async () => {
    let created = false;
    const fetchMock = mockApi({
      ...signedInLecturer,
      'GET /courses/overview': () => overview(created ? [overviewCourse()] : []),
      'POST /courses': () => {
        created = true;
        return reply(201, { course });
      },
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('form', { name: /create course/i }));
    fireEvent.change(screen.getByLabelText('Course code'), { target: { value: 'CS101' } });
    fireEvent.change(screen.getByLabelText('Course title'), { target: { value: 'Intro to CS' } });
    fireEvent.change(screen.getByLabelText('Term name'), { target: { value: 'Autumn 2026' } });
    fireEvent.change(screen.getByLabelText('Term starts on'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('Term ends on'), { target: { value: '2026-12-20' } });
    fireEvent.click(screen.getByRole('button', { name: /create course/i }));

    await waitFor(() => screen.getByRole('link', { name: /CS101 Intro to CS/ }));
    const call = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(bodyOf(call)).toEqual({
      code: 'CS101',
      title: 'Intro to CS',
      newTerm: { name: 'Autumn 2026', startsOn: '2026-09-01', endsOn: '2026-12-20' },
    });
  });

  it('uses an existing term from the list, and explains a refusal', async () => {
    const fetchMock = mockApi({
      ...signedInLecturer,
      'GET /terms': reply(200, {
        terms: [{ id: 't9', name: 'Autumn 2026', startsOn: '2026-09-01', endsOn: '2026-12-20' }],
      }),
      'GET /courses/overview': overview(),
      'POST /courses': reply(409, { error: { code: 'COURSE_EXISTS' } }),
    });
    render(<App pathname="/" />);
    await waitFor(() => screen.getByRole('form', { name: /create course/i }));
    await waitFor(() =>
      expect((screen.getByLabelText('Term') as HTMLSelectElement).value).toBe('t9'),
    );
    expect(screen.queryByLabelText('Term name')).toBeNull();
    fireEvent.change(screen.getByLabelText('Course code'), { target: { value: 'CS101' } });
    fireEvent.change(screen.getByLabelText('Course title'), { target: { value: 'Intro' } });
    fireEvent.click(screen.getByRole('button', { name: /create course/i }));
    await waitFor(() => screen.getByText(/course with that code already exists/i));
    const call = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(bodyOf(call)).toEqual({ code: 'CS101', title: 'Intro', termId: 't9' });
  });

  it("shows a course with its sessions and creates a new session with the lecturer's local date", async () => {
    let sessions = [sessionView({ state: 'ENDED' })];
    const fetchMock = mockApi({
      ...signedInLecturer,
      [`GET /courses/${COURSE}`]: reply(200, { course }),
      'GET /courses/overview': overview(),
      [`GET /courses/${COURSE}/attendance-summary`]: () => reply(200, summaryFor(sessions)),
      [`POST /courses/${COURSE}/sessions`]: (init) => {
        sessions = [
          sessionView({
            id: 'new',
            title: JSON.parse(init.body as string).title,
            state: 'NOT_STARTED',
          }),
          ...sessions,
        ];
        return reply(201, { session: sessions[0] });
      },
    });
    render(<App pathname={`/courses/${COURSE}`} />);
    await waitFor(() => screen.getByRole('heading', { name: /CS101 Intro to CS/ }));
    expect(screen.getByText(/Week 3 lecture/).closest('li')?.textContent).toContain('Ended');

    fireEvent.change(screen.getByLabelText(/new session title/i), {
      target: { value: 'Week 4 lab' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create session/i }));
    await waitFor(() => screen.getByText(/Week 4 lab/));
    expect(screen.getByText(/Week 4 lab/).closest('li')?.textContent).toContain('Not started');

    const create = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith('/sessions') && (i as RequestInit)?.method === 'POST',
    )!;
    const body = bodyOf(create);
    expect(body.title).toBe('Week 4 lab');
    expect(body.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('says so plainly when the course is not found or not theirs', async () => {
    mockApi({
      ...signedInLecturer,
      [`GET /courses/${COURSE}`]: reply(404, { error: { code: 'NOT_FOUND' } }),
      'GET /courses/overview': overview([]),
      [`GET /courses/${COURSE}/attendance-summary`]: reply(404, { error: { code: 'NOT_FOUND' } }),
    });
    render(<App pathname={`/courses/${COURSE}`} />);
    await waitFor(() => screen.getByRole('heading', { name: /course not found/i, level: 1 }));
  });
});

describe('lecturer: roster import', () => {
  const open = () =>
    mockApi({
      ...signedInLecturer,
      [`GET /courses/${COURSE}`]: reply(200, { course }),
      ...courseChrome([]),
      [`GET /courses/${COURSE}/roster`]: emptyClassList,
    });

  it('shows what will change before anything is applied, then applies with the preview token', async () => {
    const routes = {
      ...signedInLecturer,
      [`GET /courses/${COURSE}`]: reply(200, { course }),
      ...courseChrome([]),
      [`GET /courses/${COURSE}/roster`]: emptyClassList,
      [`POST /courses/${COURSE}/roster/preview`]: reply(200, {
        previewToken: 'p'.repeat(64),
        counts: { added: 1, changed: 1, unchanged: 5, missing: 1 },
        added: [{ studentId: 'N1', fullName: 'New Person' }],
        changed: [
          {
            entryId: 'c1',
            studentId: 'C1',
            before: { fullName: 'Alice' },
            after: { fullName: 'Alice Johnson' },
          },
        ],
        missing: [{ entryId: 'm1', studentId: 'M1', fullName: 'Carl', heldBy: 'link-1' }],
      }),
      [`POST /courses/${COURSE}/roster/apply`]: reply(200, {
        noChanges: false,
        added: 1,
        changed: 1,
        retired: 1,
      }),
    };
    const fetchMock = mockApi(routes);
    render(<App pathname={`/courses/${COURSE}/class-list`} />);
    await waitFor(() => screen.getByLabelText(/or paste the csv/i));
    fireEvent.change(screen.getByLabelText(/or paste the csv/i), {
      target: { value: 'student_id,full_name\nN1,New Person' },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));

    await waitFor(() =>
      screen.getByText(/1 to add · 1 to change · 5 unchanged · 1 not in this file/),
    );
    expect(screen.getByText(/C1: Alice → Alice Johnson/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/roster/apply'))).toBe(false); // nothing applied yet

    // Absence from the file is not a decision: removal is an explicit tick.
    const box = screen.getByRole('checkbox', { name: /M1 Carl/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/will need review/i)).toBeTruthy();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /apply changes/i }));
    await waitFor(() => screen.getByText(/1 added, 1 changed, 1 removed/));
    const apply = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/roster/apply'))!;
    expect(bodyOf(apply)).toMatchObject({ previewToken: 'p'.repeat(64), retireEntryIds: ['m1'] });
  });

  describe('importing spreadsheets', () => {
    const previewReply = () =>
      reply(200, {
        previewToken: 'p'.repeat(64),
        counts: { added: 1, changed: 0, unchanged: 0, missing: 0 },
        added: [{ studentId: 'A1', fullName: 'Ann Smith' }],
        changed: [],
        missing: [],
      });
    const routes = () => ({
      ...signedInLecturer,
      [`GET /courses/${COURSE}`]: reply(200, { course }),
      ...courseChrome([]),
      [`GET /courses/${COURSE}/roster`]: emptyClassList,
      [`POST /courses/${COURSE}/roster/preview`]: previewReply(),
    });
    const previewBody = (fetchMock: ReturnType<typeof mockApi>) =>
      bodyOf(fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/roster/preview'))!);
    const COMMA_CSV = 'student_id,full_name\nA1,Ann Smith\n';
    const TAB_CSV = 'student_id\tfull_name\nA1\tAnn Smith\n';

    it('turns an uploaded tab-separated file into comma-separated text, shows it, and previews that', async () => {
      const fetchMock = mockApi(routes());
      render(<App pathname={`/courses/${COURSE}/class-list`} />);
      await waitFor(() => screen.getByLabelText(/spreadsheet or csv file/i));
      fireEvent.change(screen.getByLabelText(/spreadsheet or csv file/i), {
        target: { files: [new File([TAB_CSV], 'class.tsv')] },
      });
      await waitFor(() => screen.getByText(/class\.tsv: file read/i));
      const box = screen.getByLabelText(/or paste the csv/i) as HTMLTextAreaElement;
      expect(box.value).toBe(COMMA_CSV);

      fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
      await waitFor(() => screen.getByText(/1 to add/i));
      expect(previewBody(fetchMock).csv).toBe(COMMA_CSV);
    });

    it('converts cells pasted from a spreadsheet when previewing', async () => {
      const fetchMock = mockApi(routes());
      render(<App pathname={`/courses/${COURSE}/class-list`} />);
      await waitFor(() => screen.getByLabelText(/or paste the csv/i));
      fireEvent.change(screen.getByLabelText(/or paste the csv/i), { target: { value: TAB_CSV } });
      fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
      await waitFor(() => screen.getByText(/1 to add/i));
      expect(previewBody(fetchMock).csv).toBe(COMMA_CSV);
    });

    it('tells the lecturer what to do with a file it cannot read', async () => {
      mockApi(routes());
      render(<App pathname={`/courses/${COURSE}/class-list`} />);
      await waitFor(() => screen.getByLabelText(/spreadsheet or csv file/i));
      const old = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2])], 'old.xls');
      fireEvent.change(screen.getByLabelText(/spreadsheet or csv file/i), {
        target: { files: [old] },
      });
      await waitFor(() => screen.getByText(/old excel file \(\.xls\).*save as/i));
    });
  });

  it('explains an unusable file and a stale preview', async () => {
    open();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).replace('/api', '');
        if (path === '/auth/me') return reply(200, { user: lecturer });
        if (path.endsWith(`/courses/${COURSE}`)) return reply(200, { course });
        if (path.endsWith('/attendance-summary')) return reply(200, summaryFor([]));
        if (path.endsWith('/courses/overview')) return overview();
        if (path.endsWith('/roster')) return emptyClassList;
        if (path.endsWith('/roster/preview'))
          return reply(400, { error: { code: 'INVALID_ROSTER' } });
        throw new Error(`unrouted ${init?.method} ${path}`);
      }),
    );
    render(<App pathname={`/courses/${COURSE}/class-list`} />);
    await waitFor(() => screen.getByLabelText(/or paste the csv/i));
    fireEvent.change(screen.getByLabelText(/or paste the csv/i), { target: { value: 'garbage' } });
    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    await waitFor(() => screen.getByText(/could not be used/i));
  });
});

describe('lecturer: a live session', () => {
  const routes = (over: Record<string, unknown> = {}) => ({
    ...signedInLecturer,
    [`GET /courses/${COURSE}/sessions/${SESSION}`]: () => reply(200, { session: sessionView() }),
    [`GET /courses/${COURSE}/sessions/${SESSION}/attendance`]: () => reply(200, roster()),
    ...over,
  });

  it('shows the counts as a clear breakdown that never double counts', async () => {
    mockApi(routes());
    render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
    await waitFor(() => screen.getByRole('heading', { name: 'Attendance counts' }));
    const counts = screen.getByRole('heading', { name: 'Attendance counts' }).closest('section')!;
    const value = (label: string) =>
      within(counts).getByText(label).nextElementSibling?.textContent;
    expect(value('Present (all)')).toBe('3');
    expect(value('Confirmed')).toBe('1');
    expect(value('Provisional')).toBe('1');
    expect(value('Needs review')).toBe('1');
    expect(value('Invalidated')).toBe('1');
    expect(counts.textContent).toMatch(/have an open flag/);
    expect(counts.textContent).toMatch(/not proof of who holds the phone/i);
  });

  it('UX-04: the attendance table shows state, source, match and flags but no scan times', async () => {
    mockApi(routes());
    render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
    const table = await waitFor(() => screen.getByRole('table'));
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Student ID',
      'Name',
      'Attendance',
      'Recorded by',
      'Class-list match',
      'Flags',
      'Actions',
    ]);

    const text = table.textContent ?? '';
    expect(text).not.toMatch(/\d{1,2}:\d{2}/); // no clock times
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).toContain('Matched to class list by student ID');
    expect(text).toContain('Provisional (self-reported)');
    expect(text).toContain('Marked by lecturer'); // manual attendance is distinguishable
    expect(text).toContain('Suspected proxy');
    expect(text).toContain('✕ Invalidated');
    // Responsive: every cell carries its column name for the stacked mobile layout.
    expect(
      within(table)
        .getAllByRole('cell')
        .every((c) => c.getAttribute('data-label')),
    ).toBe(true);
    expect(screen.getByText(/On the class list, no record/i)).toBeTruthy();
    expect(screen.getByText(/AB109 Yaw Darko/)).toBeTruthy();
    expect(screen.queryByText(/absent/i)).toBeNull();
  });

  it('keeps scan history out of the page until asked, then shows times, results and paging', async () => {
    const pages: Record<string, unknown> = {
      first: {
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
        nextCursor: 'CUR1',
      },
      second: {
        scans: [
          {
            id: 's2',
            receivedAt: '2026-10-10T09:04:00.000000Z',
            studentId: 'AB101',
            fullName: 'Kofi Boateng',
            outcome: 'REJECTED_TOKEN_EXPIRED',
            browser: 'Chrome',
            network: null,
          },
        ],
        nextCursor: null,
      },
    };
    const fetchMock = mockApi(
      routes({
        [`GET /courses/${COURSE}/sessions/${SESSION}/scans?limit=50`]: reply(200, pages.first),
        [`GET /courses/${COURSE}/sessions/${SESSION}/scans?before=CUR1&limit=50`]: reply(
          200,
          pages.second,
        ),
        [`GET /courses/${COURSE}/sessions/${SESSION}/scans?student=kofi&limit=50`]: reply(
          200,
          pages.second,
        ),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
    await waitFor(() => screen.getByRole('button', { name: /show scan history/i }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/scans'))).toBe(false); // not loaded by default

    fireEvent.click(screen.getByRole('button', { name: /show scan history/i }));
    await waitFor(() => screen.getByText('Recorded'));
    expect(screen.getByText(/AB100 Ama Mensah/)).toBeTruthy();
    expect(screen.getByText('a1b2c3d4')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => screen.getByText('Rejected: code expired'));
    expect(screen.getByText(/AB100 Ama Mensah/)).toBeTruthy(); // earlier page kept
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();

    fireEvent.change(screen.getByLabelText(/student id or name/i), { target: { value: 'kofi' } });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.queryByText(/AB100 Ama Mensah/)).toBeNull());
  });

  it('starts check-in from the not-started state', async () => {
    let state = 'NOT_STARTED';
    const fetchMock = mockApi(
      routes({
        [`GET /courses/${COURSE}/sessions/${SESSION}`]: () =>
          reply(200, {
            session: sessionView({
              state,
              checkInDeadline: state === 'NOT_STARTED' ? null : '2026-10-10T09:30:00.000000Z',
            }),
          }),
        [`POST /courses/${COURSE}/sessions/${SESSION}/start`]: () => {
          state = 'CHECK_IN_OPEN';
          return reply(200, { session: sessionView({ state }) });
        },
      }),
    );
    render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /start check-in/i })));
    await waitFor(() => screen.getByRole('link', { name: /show qr code for the room/i }));
    expect(screen.getByRole('link', { name: /show qr code/i }).getAttribute('href')).toBe(
      `/present/${COURSE}/${SESSION}`,
    );
    expect(
      fetchMock.mock.calls.some(
        ([u, i]) => String(u).endsWith('/start') && (i as RequestInit).method === 'POST',
      ),
    ).toBe(true);
  });

  it('extends with the deadline the lecturer saw (so a double click cannot stack) and a reason', async () => {
    const fetchMock = mockApi(
      routes({
        [`POST /courses/${COURSE}/sessions/${SESSION}/extend`]: reply(200, {
          session: sessionView({ checkInDeadline: '2026-10-10T09:40:00.000000Z' }),
        }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
    await waitFor(() => screen.getByRole('form', { name: /extend check-in/i }));
    fireEvent.change(screen.getByLabelText(/extend by/i), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Late projector' } });
    fireEvent.click(screen.getByRole('button', { name: /extend check-in/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/extend'))).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/extend'))!;
    expect(bodyOf(call)).toEqual({
      minutes: 15,
      reason: 'Late projector',
      expectedDeadline: '2026-10-10T09:30:00.123456Z',
    });
  });

  it('asks before ending, and does nothing if the lecturer declines', async () => {
    const fetchMock = mockApi(
      routes({
        [`POST /courses/${COURSE}/sessions/${SESSION}/end`]: reply(200, {
          session: sessionView({ state: 'ENDED' }),
        }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
    const end = await waitFor(() => screen.getByRole('button', { name: /end session/i }));

    fireEvent.click(end);
    const dialog = await waitFor(() =>
      screen.getByRole('dialog', { name: /end this class session/i }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/end'))).toBe(false);

    fireEvent.click(end);
    const again = await waitFor(() => screen.getByRole('dialog'));
    fireEvent.click(within(again).getByRole('button', { name: 'End session now' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/end'))).toBe(true),
    );
  });

  it('shows a closed session as closed with no extend or start controls, but review stays available', async () => {
    mockApi(
      routes({
        [`GET /courses/${COURSE}/sessions/${SESSION}`]: () =>
          reply(200, {
            session: sessionView({
              state: 'CHECK_IN_CLOSED',
              checkInClosedAt: '2026-10-10T09:30:00.000000Z',
            }),
          }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
    await waitFor(() => screen.getAllByText(/check-in closed/i));
    expect(screen.queryByRole('form', { name: /extend check-in/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /start check-in/i })).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('button', { name: /end session/i })).toBeTruthy();
  });

  it('refreshes from the server when an action is refused because the state changed', async () => {
    let calls = 0;
    mockApi(
      routes({
        [`GET /courses/${COURSE}/sessions/${SESSION}`]: () =>
          reply(200, { session: sessionView({ state: ++calls > 1 ? 'ENDED' : 'CHECK_IN_OPEN' }) }),
        [`POST /courses/${COURSE}/sessions/${SESSION}/extend`]: reply(409, {
          error: { code: 'INVALID_TRANSITION', state: 'CHECK_IN_CLOSED' },
        }),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/sessions/${SESSION}`} />);
    await waitFor(() => screen.getByRole('form', { name: /extend check-in/i }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Overran' } });
    fireEvent.click(screen.getByRole('button', { name: /extend check-in/i }));
    await waitFor(() => screen.getByText(/not possible in the session/i));
    await waitFor(() => screen.getByText(/this session has ended/i));
  });
});

describe('student: my courses', () => {
  const studentRoutes = (extra: Record<string, unknown> = {}) => ({
    'GET /auth/me': reply(200, { user: student }),
    ...extra,
  });

  it('shows each course on its own card with confirmed attendance, never one mixed total', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    mockApi(
      studentRoutes({
        'GET /me/courses': reply(200, {
          courses: [
            studentCourse(),
            studentCourse({
              id: other,
              code: 'MA201',
              title: 'Linear algebra',
              association: { state: 'PROVISIONAL' },
              summary: {
                sessionsStarted: 4,
                eligibleSessions: 4,
                inProgress: 0,
                notCounted: 0,
                tally: {
                  confirmed: 0,
                  provisional: 3,
                  awaitingConfirmation: 0,
                  invalidated: 0,
                  noRecord: 1,
                },
                percent: null,
                percentReason: 'NOT_CONFIRMED',
              },
              latestSession: null,
            }),
          ],
        }),
      }),
    );
    render(<App pathname="/" />);
    const cs = await waitFor(() => screen.getByRole('article', { name: /CS101/ }));
    const ma = screen.getByRole('article', { name: /MA201/ });
    expect(cs.textContent).toContain('1 confirmed of 2 counted sessions');
    expect(within(cs).getByRole('progressbar')).toBeTruthy();
    expect(within(ma).queryByRole('progressbar')).toBeNull(); // no percentage until the match is confirmed
    expect(ma.textContent).toContain('3 awaiting confirmation');
    expect(within(cs).getByRole('link', { name: 'Intro to CS' }).getAttribute('href')).toBe(
      `/my/courses/${COURSE}`,
    );
    expect(within(ma).getByRole('link', { name: 'Linear algebra' }).getAttribute('href')).toBe(
      `/my/courses/${other}`,
    );
    expect(document.body.textContent?.toLowerCase()).not.toContain('flag');
    expect(document.body.textContent?.toLowerCase()).not.toContain('absent');
  });

  it('invites a new student to check in', async () => {
    mockApi(studentRoutes({ 'GET /me/courses': reply(200, { courses: [] }) }));
    render(<App pathname="/" />);
    await waitFor(() => screen.getByText(/after your first check-in/i));
  });

  it('says so when the courses cannot be loaded, and retries', async () => {
    let fail = true;
    mockApi(
      studentRoutes({
        'GET /me/courses': () =>
          fail ? reply(500, {}) : reply(200, { courses: [studentCourse()] }),
      }),
    );
    render(<App pathname="/" />);
    await waitFor(() => screen.getByText(/could not load your courses/i));
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => screen.getByRole('article', { name: /CS101/ }));
  });

  it('lists every course on the My courses page and searches them when there are many', async () => {
    const many = ['AA100', 'BB200', 'CC300', 'DD400'].map((code, i) =>
      studentCourse({
        id: `4444444${i}-4444-4444-8444-444444444444`,
        code,
        title: `Title ${code}`,
      }),
    );
    mockApi(studentRoutes({ 'GET /me/courses': reply(200, { courses: many }) }));
    render(<App pathname="/my/courses" />);
    await waitFor(() => screen.getAllByRole('article'));
    expect(screen.getAllByRole('article')).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Search courses'), { target: { value: 'cc3' } });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search courses'), { target: { value: 'zzz' } });
    expect(screen.getByText(/no courses match/i)).toBeTruthy();
  });
});

describe('student: one course', () => {
  const sessions = [
    courseSession({ id: 'a', title: 'Week 3', date: '2026-10-10', outcome: 'CONFIRMED' }),
    courseSession({ id: 'b', title: 'Week 2', date: '2026-10-03', outcome: 'PROVISIONAL' }),
    courseSession({
      id: 'c',
      title: 'Week 1',
      date: '2026-09-26',
      outcome: 'INVALIDATED',
      invalidationCategory: 'CONFIRMED_PROXY',
    }),
    courseSession({
      id: 'd',
      title: 'Week 0',
      date: '2026-09-19',
      outcome: 'NO_RECORD',
      source: null,
    }),
    courseSession({
      id: 'e',
      title: 'Week 4',
      date: '2026-10-17',
      outcome: 'IN_PROGRESS',
      phase: 'IN_PROGRESS',
      counted: false,
      source: null,
    }),
  ];
  const open = (history = studentHistory(sessions)) => {
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      [`GET /me/courses/${COURSE}`]: reply(200, history),
    });
    render(<App pathname={`/my/courses/${COURSE}`} />);
  };
  const rowsNow = () =>
    within(screen.getByRole('list', { name: 'Sessions' })).getAllByRole('listitem');

  it('summarises this course only, then lists its sessions with plain outcomes and no flags', async () => {
    open();
    await waitFor(() => screen.getByRole('heading', { name: /CS101 Intro to CS/, level: 1 }));
    await waitFor(() => screen.getByRole('list', { name: 'Sessions' }));
    const rows = rowsNow();
    expect(rows).toHaveLength(5);
    expect(rows[0]!.textContent).toContain('Week 3');
    expect(rows[0]!.textContent).toContain('Present');
    expect(rows[1]!.textContent).toContain('Recorded, not yet confirmed');
    expect(rows[2]!.textContent).toContain('Invalidated');
    expect(rows[3]!.textContent).toContain('No record');
    expect(rows[4]!.textContent).toContain('In progress');
    expect(document.body.textContent).toContain('50%');
    expect(document.body.textContent?.toLowerCase()).not.toContain('flag');
    expect(document.body.textContent?.toLowerCase()).not.toContain('absent');
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(crumbs).getByRole('link', { name: 'My courses' }).getAttribute('href')).toBe(
      '/my/courses',
    );
  });

  it('explains what a session means when its details are opened', async () => {
    open();
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /show details for week 1/i })),
    );
    expect(screen.getByText(/ask your lecturer/i)).toBeTruthy();
  });

  it('filters by outcome and searches by title', async () => {
    open();
    await waitFor(() => screen.getByRole('list', { name: 'Sessions' }));
    const show = screen.getByLabelText('Show', { selector: 'select' });
    fireEvent.change(show, { target: { value: 'PROVISIONAL' } });
    expect(rowsNow()).toHaveLength(1);
    fireEvent.change(show, { target: { value: 'ALL' } });
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'week 0' } });
    expect(rowsNow()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search sessions'), { target: { value: 'nothing' } });
    expect(screen.getByText(/no sessions match/i)).toBeTruthy();
  });

  it('gives the reason instead of a percentage when the match is not confirmed', async () => {
    open(
      studentHistory(sessions, {
        association: { state: 'PROVISIONAL' },
        summary: {
          sessionsStarted: 5,
          eligibleSessions: 4,
          inProgress: 1,
          notCounted: 0,
          tally: {
            confirmed: 0,
            provisional: 1,
            awaitingConfirmation: 0,
            invalidated: 1,
            noRecord: 1,
          },
          percent: null,
          percentReason: 'NOT_CONFIRMED',
        },
      }),
    );
    await waitFor(() => screen.getByRole('list', { name: 'Sessions' }));
    expect(document.body.textContent).not.toMatch(/\d+(\.\d)?%/);
  });

  it('says plainly when the course is not one of theirs', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      [`GET /me/courses/${COURSE}`]: reply(404, { error: { code: 'NOT_FOUND' } }),
    });
    render(<App pathname={`/my/courses/${COURSE}`} />);
    await waitFor(() => screen.getAllByText(/course not found|could not find/i));
  });

  it('shows an empty state when no session has started', async () => {
    open(studentHistory([]));
    await waitFor(() => screen.getByText(/no session has started/i));
  });
});
