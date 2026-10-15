import { useState } from 'react';
import { lecturerApi, type CourseAttendanceSummary } from '../../api/lecturer';
import { formatDate, plural } from '../../components/format';
import type { LoadState } from '../../components/useLoad';
import { Badge, Card, EmptyState, Loading, Notice, TextField } from '../../components/ui';
import { Link } from '../../router';
import { SESSION_STATE_LABEL } from './labels';

const STATE_TONE = {
  NOT_STARTED: 'neutral',
  CHECK_IN_OPEN: 'info',
  CHECK_IN_CLOSED: 'warning',
  ENDED: 'neutral',
} as const;

/** A course's sessions: start a new one, or open one to run it or review it. */
export function SessionsTab({
  courseId,
  summary,
  onCreated,
}: {
  courseId: string;
  summary: LoadState<CourseAttendanceSummary>;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    // The lecturer's own local calendar date, not the server's.
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = await lecturerApi.createSession(courseId, title, date);
    setBusy(false);
    if (r.ok) {
      setTitle('');
      onCreated();
    } else setError('Could not create the session. Check the title and try again.');
  };

  const sessions = summary.status === 'ready' ? summary.data.sessions : null;

  return (
    <Card
      title="Class sessions"
      description="Create a session, then start check-in when class begins."
    >
      <form onSubmit={(e) => void create(e)} aria-label="New session" className="stack">
        <TextField
          label="New session title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          placeholder="e.g. Week 3 lecture"
        />
        {error && <Notice tone="danger" title={error} urgent />}
        <div className="actions">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Creating…' : 'Create session'}
          </button>
        </div>
      </form>

      {summary.status === 'loading' && <Loading label="Loading sessions…" />}
      {(summary.status === 'error' || summary.status === 'not-found') && (
        <Notice tone="danger" title="Could not load the sessions" urgent>
          Refresh the page to try again.
        </Notice>
      )}
      {sessions && sessions.length === 0 && (
        <EmptyState title="No sessions yet">Create the first one above.</EmptyState>
      )}
      {sessions && sessions.length > 0 && (
        <ul className="rowlist rowlist--bleed" aria-label="Sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <Link to={`/courses/${courseId}/sessions/${s.id}`} className="row">
                <span className="row__main">
                  <span className="row__title">{s.title}</span>
                  <span className="row__meta">{formatDate(s.date)}</span>
                </span>
                <span className="cluster">
                  {s.state !== 'NOT_STARTED' && (
                    <span className="subtle">{plural(s.present, 'student')} present</span>
                  )}
                  <Badge tone={STATE_TONE[s.state]}>{SESSION_STATE_LABEL[s.state]}</Badge>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
