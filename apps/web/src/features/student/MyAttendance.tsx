import { useEffect, useState } from 'react';
import { studentApi, type MyAttendance as Data } from '../../api/lecturer';
import { Notice } from '../../components/ui';
import { INVALIDATION_LABEL, STATUS_LABEL } from '../lecturer/labels';

/** The student's own attendance only. The server never returns anyone else's. */
export function MyAttendance({ reloadKey = 0 }: { reloadKey?: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void studentApi.attendance().then((r) => {
      if (cancelled) return;
      if (r.ok) setData(r.data);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (failed) return <Notice tone="danger" title="Could not load your attendance" urgent />;
  if (!data) return <p role="status">Loading your attendance…</p>;
  if (data.courses.length === 0) {
    return (
      <section className="card">
        <h2>My attendance</h2>
        <p className="muted">Your classes will appear here after your first check-in.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="my-attendance-heading" className="stack">
      <h2 id="my-attendance-heading">My attendance</h2>
      {data.courses.map((c) => (
        <article key={c.id} className="card" aria-label={`${c.code} ${c.title}`}>
          <h3>
            {c.code} {c.title}
          </h3>
          <p>
            Present at {c.presentCount} of {c.sessionCount} classes
          </p>
          {c.associationState !== 'CONFIRMED' && (
            <p className="muted">Your lecturer is still matching you to the class list.</p>
          )}
          <ul className="list">
            {c.sessions.map((s) => (
              <li key={s.id}>
                {s.date} · {s.title}: <strong>{STATUS_LABEL[s.status]}</strong>
                {s.status === 'INVALIDATED' && s.invalidationCategory && (
                  <span className="muted">
                    {' '}
                    ({INVALIDATION_LABEL[s.invalidationCategory] ?? s.invalidationCategory}; ask
                    your lecturer)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
