import { useEffect, useState } from 'react';
import { studentApi, type MyAttendance as Data } from '../../api/lecturer';
import { Badge, Notice } from '../../components/ui';
import { INVALIDATION_LABEL, STATUS_LABEL, STATUS_TONE } from '../lecturer/labels';

type Review = NonNullable<Data['courses'][number]['sessions'][number]['review']>;

const REPLY_PROBLEMS: Record<string, string> = {
  TOO_MANY_RESPONSES: 'You have added the most replies allowed. Please speak to your lecturer.',
  INVALID_TRANSITION: 'This review has already been closed.',
  RATE_LIMITED: 'Too many replies just now. Wait a moment and try again.',
  NETWORK: 'Could not reach the server. Try again.',
};

/**
 * Shown only when a lecturer is reviewing one of the student's records. It says that, that the record
 * still counts, and lets the student reply. It never says why, who else was involved, or anything
 * about how the lecturer decided to look.
 */
function ReviewNotice({ review, onSent }: { review: Review; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  if (review.state === 'RESOLVED_UPHELD') {
    return <p className="muted">Your lecturer reviewed this record and it stands.</p>;
  }
  if (review.state === 'RESOLVED_INVALIDATED') {
    return (
      <p className="muted">Your lecturer reviewed this record. Ask them if you have questions.</p>
    );
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await studentApi.respondToReview(review.id, text.trim());
    setBusy(false);
    if (r.ok) {
      setText('');
      setMessage({ tone: 'success', text: 'Your reply was sent to your lecturer.' });
      onSent();
    } else {
      setMessage({ tone: 'danger', text: REPLY_PROBLEMS[r.code] ?? 'Could not send your reply.' });
    }
  };

  return (
    <div className="stack">
      <Notice tone="info" title="Your lecturer is reviewing this record">
        It still counts as present while they look at it. You can add a note below, and you can also
        speak to your lecturer.
      </Notice>
      {review.repliesLeft > 0 ? (
        <form className="stack" onSubmit={(e) => void send(e)} aria-label="Reply about this record">
          <div className="field">
            <label htmlFor={`reply-${review.id}`}>Your reply</label>
            <textarea
              id={`reply-${review.id}`}
              rows={3}
              maxLength={1000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <button type="submit" className="btn" disabled={busy || !text.trim()}>
            {busy ? 'Sending…' : 'Send reply'}
          </button>
        </form>
      ) : (
        <p className="muted">You have used all your replies. Please speak to your lecturer.</p>
      )}
      {message && (
        <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
      )}
    </div>
  );
}

/** The student's own attendance only. The server never returns anyone else's. */
export function MyAttendance({ reloadKey = 0 }: { reloadKey?: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);

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
  }, [reloadKey, refresh]);

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
                {s.date} · {s.title}:{' '}
                <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{STATUS_LABEL[s.status]}</Badge>
                {s.status === 'INVALIDATED' && s.invalidationCategory && (
                  <span className="muted">
                    {' '}
                    ({INVALIDATION_LABEL[s.invalidationCategory] ?? s.invalidationCategory}; ask
                    your lecturer)
                  </span>
                )}
                {s.review && (
                  <ReviewNotice review={s.review} onSent={() => setRefresh((n) => n + 1)} />
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
