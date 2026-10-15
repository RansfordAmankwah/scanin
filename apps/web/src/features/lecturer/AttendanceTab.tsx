import { useMemo, useState } from 'react';
import type { CourseAttendanceSummary, CourseStudentRow } from '../../api/lecturer';
import { formatDate } from '../../components/format';
import type { LoadState } from '../../components/useLoad';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  SearchField,
  SelectField,
} from '../../components/ui';
import { Link } from '../../router';
import { LINK_STATE_LABEL, LINK_STATE_TONE, SESSION_STATE_LABEL } from './labels';

type View = 'sessions' | 'students';
type Filter = 'ALL' | 'ATTENTION' | 'UNCONFIRMED';

const needsAttention = (s: CourseStudentRow) =>
  s.flaggedRecords > 0 || s.openReviews > 0 || s.summary.tally.awaitingConfirmation > 0;

function BySession({ courseId, data }: { courseId: string; data: CourseAttendanceSummary }) {
  if (data.sessions.length === 0) {
    return (
      <EmptyState title="No sessions yet">
        Attendance appears here once a session has started.
      </EmptyState>
    );
  }
  return (
    <Card
      flush
      title="By session"
      description="How each class went. Open a session for its records, headcount and spot checks."
    >
      <table className="responsive">
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Present
            </th>
            <th scope="col" className="num">
              Confirmed
            </th>
            <th scope="col" className="num">
              Not yet confirmed
            </th>
            <th scope="col" className="num">
              Invalidated
            </th>
            <th scope="col" className="num">
              Headcount
            </th>
          </tr>
        </thead>
        <tbody>
          {data.sessions.map((s) => (
            <tr key={s.id}>
              <td data-label="Session">
                <Link to={`/courses/${courseId}/sessions/${s.id}`}>{s.title}</Link>
                <div className="subtle">{formatDate(s.date)}</div>
              </td>
              <td data-label="Status">
                <Badge tone={s.state === 'CHECK_IN_OPEN' ? 'info' : 'neutral'}>
                  {SESSION_STATE_LABEL[s.state]}
                </Badge>
              </td>
              <td data-label="Present" className="num">
                {s.state === 'NOT_STARTED' ? '—' : s.present}
              </td>
              <td data-label="Confirmed" className="num">
                {s.state === 'NOT_STARTED' ? '—' : s.confirmed}
              </td>
              <td data-label="Not yet confirmed" className="num">
                {s.state === 'NOT_STARTED' ? '—' : s.provisional + s.awaitingConfirmation}
              </td>
              <td data-label="Invalidated" className="num">
                {s.state === 'NOT_STARTED' ? '—' : s.invalidated}
              </td>
              <td data-label="Headcount" className="num">
                {s.headcount ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ByStudent({ courseId, data }: { courseId: string; data: CourseAttendanceSummary }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.students.filter(
      (s) =>
        (q === '' || `${s.studentId} ${s.fullName}`.toLowerCase().includes(q)) &&
        (filter === 'ALL' ||
          (filter === 'ATTENTION' && needsAttention(s)) ||
          (filter === 'UNCONFIRMED' && s.associationState !== 'CONFIRMED')),
    );
  }, [data.students, query, filter]);

  return (
    <Card
      flush
      title="By student"
      description="Each student's attendance across the course. Open a student to see every session."
    >
      <div className="table-toolbar">
        <SearchField
          label="Search students"
          value={query}
          onChange={setQuery}
          placeholder="Name or student ID"
        />
        <SelectField
          label="Show"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          <option value="ALL">All students</option>
          <option value="ATTENTION">Need attention</option>
          <option value="UNCONFIRMED">Not yet confirmed</option>
        </SelectField>
      </div>

      {data.students.length === 0 ? (
        <div className="card__pad">
          <EmptyState title="No students yet">
            Students appear here after they check in or are matched to the class list.
          </EmptyState>
        </div>
      ) : shown.length === 0 ? (
        <div className="card__pad">
          <EmptyState title="No students match">
            Try a different search or show everyone.
          </EmptyState>
        </div>
      ) : (
        <table className="responsive">
          <thead>
            <tr>
              <th scope="col">Student</th>
              <th scope="col">Class-list match</th>
              <th scope="col" className="num">
                Counted
              </th>
              <th scope="col" className="num">
                Confirmed
              </th>
              <th scope="col" className="num">
                Not yet confirmed
              </th>
              <th scope="col" className="num">
                Invalidated
              </th>
              <th scope="col" className="num">
                No record
              </th>
              <th scope="col" className="num">
                Attendance
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.linkId}>
                <td data-label="Student">
                  <Link to={`/courses/${courseId}/students/${s.linkId}`}>{s.fullName}</Link>
                  <div className="subtle">{s.studentId}</div>
                </td>
                <td data-label="Class-list match">
                  <span className="badges">
                    <Badge tone={LINK_STATE_TONE[s.associationState]}>
                      {LINK_STATE_LABEL[s.associationState]}
                    </Badge>
                    {s.openReviews > 0 && <Badge tone="attention">Under review</Badge>}
                    {s.flaggedRecords > 0 && <Badge tone="attention">Flagged</Badge>}
                  </span>
                </td>
                <td data-label="Counted" className="num">
                  {s.summary.eligibleSessions}
                </td>
                <td data-label="Confirmed" className="num">
                  {s.summary.tally.confirmed}
                </td>
                <td data-label="Not yet confirmed" className="num">
                  {s.summary.tally.provisional + s.summary.tally.awaitingConfirmation}
                </td>
                <td data-label="Invalidated" className="num">
                  {s.summary.tally.invalidated}
                </td>
                <td data-label="No record" className="num">
                  {s.summary.tally.noRecord}
                </td>
                <td data-label="Attendance" className="num">
                  {s.summary.percent !== null ? (
                    <strong>{s.summary.percent}%</strong>
                  ) : (
                    <span
                      className="subtle"
                      title="A confirmed percentage needs the student to be confirmed against the class list."
                    >
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.notRegistered.length > 0 && (
        <details className="card__pad">
          <summary>{data.notRegistered.length} on the class list without an account</summary>
          <p className="subtle">
            Nothing can be recorded for them until they sign up, so no attendance is calculated.
          </p>
          <ul className="list">
            {data.notRegistered.map((e) => (
              <li key={e.entryId}>
                {e.studentId} {e.fullName}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/** A course's attendance two ways: how each class went, and how each student is doing. */
export function AttendanceTab({
  courseId,
  summary,
  onRetry,
}: {
  courseId: string;
  summary: LoadState<CourseAttendanceSummary>;
  onRetry: () => void;
}) {
  const [view, setView] = useState<View>('sessions');

  if (summary.status === 'loading') return <Loading label="Loading attendance…" />;
  if (summary.status !== 'ready') {
    return (
      <ErrorState title="Could not load attendance" onRetry={onRetry}>
        Check your connection and try again.
      </ErrorState>
    );
  }

  return (
    <div className="stack">
      <div className="segmented" role="group" aria-label="Group attendance by">
        <button
          type="button"
          aria-pressed={view === 'sessions'}
          onClick={() => setView('sessions')}
        >
          By session
        </button>
        <button
          type="button"
          aria-pressed={view === 'students'}
          onClick={() => setView('students')}
        >
          By student
        </button>
      </div>
      {view === 'sessions' ? (
        <BySession courseId={courseId} data={summary.data} />
      ) : (
        <ByStudent courseId={courseId} data={summary.data} />
      )}
    </div>
  );
}
