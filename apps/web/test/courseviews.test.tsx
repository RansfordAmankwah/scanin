import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ConfirmDialog } from '../src/components/ui';
import {
  COURSE_ID as COURSE,
  courseSession,
  overview,
  overviewCourse,
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

const LINK = '55555555-5555-4555-8555-555555555555';
const lecturer = {
  id: 'l1',
  role: 'LECTURER',
  fullName: 'Dr Owusu',
  email: 'owusu@school.test',
  studentId: null,
  emailVerified: true,
};
const student = {
  id: 's1',
  role: 'STUDENT',
  fullName: 'Ama Mensah',
  email: 'ama@school.test',
  studentId: 'AB100',
  emailVerified: false,
};
const course = {
  id: COURSE,
  code: 'CS101',
  title: 'Intro to CS',
  term: { id: 't', name: 'Autumn 2026', startsOn: '2026-09-01', endsOn: '2026-12-20' },
};

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

async function violations(container: Element = document.body) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

const studentRow = (over: Record<string, unknown> = {}) => ({
  linkId: LINK,
  studentId: 'AB100',
  fullName: 'Ama Mensah',
  associationState: 'CONFIRMED',
  summary: {
    sessionsStarted: 3,
    eligibleSessions: 3,
    inProgress: 0,
    notCounted: 0,
    tally: { confirmed: 2, provisional: 0, awaitingConfirmation: 0, invalidated: 1, noRecord: 0 },
    percent: 66.7,
    percentReason: 'OK',
  },
  flaggedRecords: 0,
  openReviews: 0,
  ...over,
});

describe('lecturer dashboard', () => {
  it('puts live sessions and unresolved records first, across all courses', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      'GET /terms': reply(200, { terms: [] }),
      'GET /courses/overview': overview([
        overviewCourse({
          openSession: {
            id: 'live',
            title: 'Week 3 lecture',
            date: '2026-10-10',
            present: 12,
            checkInDeadline: null,
          },
          attention: { matchesToReview: 2, openFlags: 0, openReviews: 1 },
        }),
        overviewCourse({ id: other, code: 'MA201', title: 'Linear algebra' }),
      ]),
    });
    render(<App pathname="/" />);
    const card = await waitFor(() => screen.getByRole('region', { name: /needs your attention/i }));
    const links = within(card).getAllByRole('link');
    expect(links[0]!.textContent).toContain('Check-in is open in CS101');
    expect(links[0]!.getAttribute('href')).toBe(`/courses/${COURSE}/sessions/live`);
    expect(card.textContent).toContain('2 students to match in CS101');
    expect(card.textContent).toContain('1 record under review in CS101');
    // A course with nothing pending adds nothing to the list.
    expect(card.textContent).not.toContain('MA201');
    expect(screen.getByRole('article', { name: /MA201/ })).toBeTruthy();
  });
});

describe('lecturer course workspace', () => {
  const routes = (summary: unknown, extra: Record<string, unknown> = {}) => ({
    'GET /auth/me': reply(200, { user: lecturer }),
    [`GET /courses/${COURSE}`]: reply(200, { course }),
    'GET /courses/overview': overview([
      overviewCourse({
        attention: { matchesToReview: 1, openFlags: 2, openReviews: 0 },
        students: { registered: 3, notRegistered: 1 },
      }),
    ]),
    [`GET /courses/${COURSE}/attendance-summary`]: reply(200, summary),
    ...extra,
  });

  it('has four tabs, each at its own address, with the current one marked', async () => {
    mockApi(routes(summaryFor([])));
    render(<App pathname={`/courses/${COURSE}/attendance`} />);
    const tabs = await waitFor(() => screen.getByRole('navigation', { name: /course sections/i }));
    const names = within(tabs)
      .getAllByRole('link')
      .map((a) => [a.textContent?.replace(/\d+$/, '').trim(), a.getAttribute('href')]);
    expect(names).toEqual([
      ['Sessions', `/courses/${COURSE}`],
      ['Attendance', `/courses/${COURSE}/attendance`],
      ['Class list', `/courses/${COURSE}/class-list`],
      ['Review', `/courses/${COURSE}/review`],
    ]);
    expect(
      within(tabs)
        .getByRole('link', { name: /^Attendance/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(await violations()).toEqual([]);
  });

  it('shows attendance by session, and says nothing is counted before a session starts', async () => {
    const sessions = [
      { id: 'a', title: 'Week 3', sessionDate: '2026-10-10', state: 'ENDED' },
      { id: 'b', title: 'Week 4', sessionDate: '2026-10-17', state: 'NOT_STARTED' },
    ];
    const summary = summaryFor(sessions);
    summary.sessions[0] = {
      ...summary.sessions[0]!,
      present: 5,
      confirmed: 3,
      provisional: 1,
      awaitingConfirmation: 0,
      invalidated: 1,
      headcount: 6,
    };
    mockApi(routes(summary));
    render(<App pathname={`/courses/${COURSE}/attendance`} />);
    const table = await waitFor(() => screen.getByRole('table'));
    const rows = within(table).getAllByRole('row');
    expect(rows[1]!.textContent).toContain('Week 3');
    expect(
      within(rows[1]!)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(expect.arrayContaining(['5', '3', '1', '6']));
    expect(rows[2]!.textContent).toContain('—');
    expect(within(rows[1]!).getByRole('link', { name: 'Week 3' }).getAttribute('href')).toBe(
      `/courses/${COURSE}/sessions/a`,
    );
  });

  it('shows attendance by student, a percentage only for confirmed students, and filters', async () => {
    const summary = summaryFor([], {
      students: [
        studentRow(),
        studentRow({
          linkId: 'other',
          studentId: 'AB200',
          fullName: 'Kofi Boateng',
          associationState: 'PROVISIONAL',
          flaggedRecords: 1,
          summary: {
            sessionsStarted: 3,
            eligibleSessions: 3,
            inProgress: 0,
            notCounted: 0,
            tally: {
              confirmed: 0,
              provisional: 2,
              awaitingConfirmation: 0,
              invalidated: 0,
              noRecord: 1,
            },
            percent: null,
            percentReason: 'NOT_CONFIRMED',
          },
        }),
      ],
      notRegistered: [{ entryId: 'e', studentId: 'AB300', fullName: 'Yaw Darko' }],
    });
    mockApi(routes(summary));
    render(<App pathname={`/courses/${COURSE}/attendance`} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'By student' })));
    const table = await waitFor(() => screen.getByRole('table'));
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain('66.7%');
    expect(rows[2]!.textContent).not.toContain('%');
    expect(rows[2]!.textContent).toContain('Flagged');
    expect(within(rows[1]!).getByRole('link', { name: 'Ama Mensah' }).getAttribute('href')).toBe(
      `/courses/${COURSE}/students/${LINK}`,
    );
    expect(screen.getByText(/1 on the class list without an account/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'ATTENTION' } });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'ALL' } });
    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'zzz' } });
    expect(screen.getByText(/no students match/i)).toBeTruthy();
  });

  it('keeps each student with the course they belong to: another course never appears here', async () => {
    mockApi(routes(summaryFor([], { students: [studentRow()] })));
    render(<App pathname={`/courses/${COURSE}/attendance`} />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'By student' })));
    await waitFor(() => screen.getByRole('table'));
    expect(document.body.textContent).not.toContain('MA201');
  });

  it('offers a retry when attendance cannot be loaded', async () => {
    let fail = true;
    mockApi(
      routes(null, {
        [`GET /courses/${COURSE}/attendance-summary`]: () =>
          fail ? reply(500, {}) : reply(200, summaryFor([])),
      }),
    );
    render(<App pathname={`/courses/${COURSE}/attendance`} />);
    await waitFor(() => screen.getByText(/could not load attendance/i));
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => screen.getByText(/no sessions yet/i));
  });
});

describe('lecturer: one student in one course', () => {
  const history = (over: Record<string, unknown> = {}) => ({
    student: {
      linkId: LINK,
      studentId: 'AB100',
      fullName: 'Ama Mensah',
      associationState: 'CONFIRMED',
    },
    summary: studentRow().summary,
    countedFrom: '2026-09-01T00:00:00.000Z',
    sessions: [
      {
        ...courseSession({ id: 'a', title: 'Week 3', outcome: 'CONFIRMED' }),
        attendanceId: 'r1',
        flagged: true,
        verification: 'NOT_FOUND',
        disputeState: null,
      },
      {
        ...courseSession({ id: 'b', title: 'Week 2', outcome: 'NO_RECORD', source: null }),
        attendanceId: null,
        flagged: false,
        verification: null,
        disputeState: null,
      },
    ],
    ...over,
  });

  it('shows the cumulative summary and every session, with lecturer-only detail', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET /courses/${COURSE}`]: reply(200, { course }),
      [`GET /courses/${COURSE}/students/${LINK}/attendance`]: reply(200, history()),
    });
    render(<App pathname={`/courses/${COURSE}/students/${LINK}`} />);
    await waitFor(() => screen.getByRole('heading', { name: 'Ama Mensah', level: 1 }));
    const list = await waitFor(() => screen.getByRole('list', { name: 'Sessions' }));
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Flagged');
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(crumbs).getByRole('link', { name: 'CS101' }).getAttribute('href')).toBe(
      `/courses/${COURSE}`,
    );
    fireEvent.click(screen.getByRole('button', { name: /show details for week 3/i }));
    expect(screen.getByText(/Spot check/)).toBeTruthy();
    expect(await violations()).toEqual([]);
  });

  it('says so when the student is not in this course', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      [`GET /courses/${COURSE}`]: reply(200, { course }),
      [`GET /courses/${COURSE}/students/${LINK}/attendance`]: reply(404, {
        error: { code: 'NOT_FOUND' },
      }),
    });
    render(<App pathname={`/courses/${COURSE}/students/${LINK}`} />);
    await waitFor(() => screen.getByText(/could not find that student in this course/i));
  });
});

describe('navigation and account', () => {
  it('shows each role only its own destinations', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'GET /me/courses': reply(200, { courses: [] }),
    });
    render(<App pathname="/" />);
    const nav = await waitFor(() => screen.getByRole('navigation', { name: 'Main' }));
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Home', 'My courses', 'Account']);
    cleanup();
    mockApi({
      'GET /auth/me': reply(200, { user: lecturer }),
      'GET /terms': reply(200, { terms: [] }),
      'GET /courses/overview': overview([]),
    });
    render(<App pathname="/" />);
    const lnav = await waitFor(() => screen.getByRole('navigation', { name: 'Main' }));
    expect(
      within(lnav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Sessions', 'Billing', 'Account']);
  });

  it('shows the account, offers to verify an unverified e-mail, and changes the password', async () => {
    const fetchMock = mockApi({
      'GET /auth/me': reply(200, { user: student }),
      'POST /auth/password': reply(204, null),
    });
    render(<App pathname="/account" />);
    await waitFor(() => screen.getByRole('heading', { name: 'Account', level: 1 }));
    expect(screen.getAllByText('ama@school.test').length).toBeGreaterThan(0);
    expect(screen.getByText('AB100')).toBeTruthy();
    expect(screen.getByText('Not verified')).toBeTruthy();

    const submit = screen.getByRole('button', { name: 'Change password' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-password-1' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password-22' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Change password' }));
    await waitFor(() => screen.getByText(/password changed/i));
    expect(bodyOf(fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!)).toEqual({
      currentPassword: 'old-password-1',
      newPassword: 'new-password-22',
    });
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
    expect(await violations()).toEqual([]);
  });

  it('explains a wrong current password in plain words', async () => {
    mockApi({
      'GET /auth/me': reply(200, { user: { ...student, emailVerified: true } }),
      'POST /auth/password': reply(401, { error: { code: 'INVALID_CREDENTIALS' } }),
    });
    render(<App pathname="/account" />);
    await waitFor(() => screen.getByText('Verified'));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'nope-nope-nope' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password-22' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Change password' }));
    await waitFor(() => screen.getByText('Your current password is incorrect.'));
  });
});

describe('confirmation dialog', () => {
  function Harness({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Do it</button>
        <ConfirmDialog
          open={open}
          title="Are you sure?"
          confirmLabel="Yes, do it"
          onConfirm={() => {
            setOpen(false);
            onConfirm();
          }}
          onCancel={() => setOpen(false)}
        >
          <p>This matters.</p>
        </ConfirmDialog>
      </>
    );
  }

  it('moves focus to Cancel, closes on Escape without confirming, and returns focus', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const opener = screen.getByRole('button', { name: 'Do it' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: 'Are you sure?' }));
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the dialog and confirms only on the explicit button', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    const confirm = within(dialog).getByRole('button', { name: 'Yes, do it' });
    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    expect(await violations(dialog)).toEqual([]);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
