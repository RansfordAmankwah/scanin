import { useCallback, useEffect, useState } from 'react';
import { lecturerApi, type Course, type SessionView } from '../../api/lecturer';
import { Notice, TextField } from '../../components/ui';
import { Link } from '../../router';
import { SESSION_STATE_LABEL } from './labels';
import { ReviewQueue } from './ReviewQueue';
import { RosterImport } from './RosterImport';

export function CoursePage({ courseId }: { courseId: string }) {
  const [course, setCourse] = useState<Course | null>(null);
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([
      lecturerApi.course(courseId),
      lecturerApi.sessions(courseId),
    ]);
    if (!c.ok) return setNotFound(true);
    setCourse(c.data.course);
    if (s.ok) setSessions(s.data.sessions);
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // The lecturer's own local calendar date, not the server's.
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = await lecturerApi.createSession(courseId, title, date);
    if (r.ok) {
      setTitle('');
      void load();
    } else setError('Could not create the session. Check the title and try again.');
  };

  if (notFound) {
    return (
      <Notice tone="danger" title="Course not found" urgent>
        It may not exist, or you may not be assigned to it.
      </Notice>
    );
  }
  if (!course || !sessions) return <p role="status">Loading…</p>;

  return (
    <div className="stack">
      <p>
        <Link to="/" className="back-link">
          ← All courses
        </Link>
      </p>
      <h2>
        {course.code} {course.title}
      </h2>
      <p className="muted">{course.term.name}</p>

      <section className="card" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading">Class sessions</h2>
        <form onSubmit={(e) => void create(e)} aria-label="New session" className="stack">
          <TextField
            label="New session title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder="e.g. Week 3 lecture"
          />
          {error && <Notice tone="danger" title={error} urgent />}
          <button type="submit" className="btn">
            Create session
          </button>
        </form>
        {sessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <ul className="list">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link to={`/courses/${courseId}/sessions/${s.id}`}>
                  {s.sessionDate} · {s.title}
                </Link>{' '}
                <span className="muted">({SESSION_STATE_LABEL[s.state]})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ReviewQueue courseId={courseId} />
      <RosterImport courseId={courseId} />
    </div>
  );
}
