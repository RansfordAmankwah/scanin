import { useCallback, useEffect, useRef, useState } from 'react';
import { antiProxyApi, type Dispute } from '../../api/lecturer';
import { Badge, Button, Notice } from '../../components/ui';
import { DISPUTE_LABEL, DISPUTE_TONE, INVALIDATION_LABEL } from './labels';

const PROBLEMS: Record<string, string> = {
  CATEGORY_REQUIRED: 'Choose a reason category for invalidating the record.',
  INVALID_REQUEST: 'Choose a resolution and write a reason of at least 10 characters.',
  INVALID_TRANSITION: 'This review has already been closed. The list has been refreshed.',
  RATE_LIMITED: 'Too many requests just now. Wait a moment and try again.',
  NETWORK: 'Could not reach the server. Try again.',
};

const MIN_REASON = 10;

function DisputeCard({
  dispute,
  courseId,
  sessionId,
  onResolved,
}: {
  dispute: Dispute;
  courseId: string;
  sessionId: string;
  onResolved: () => void;
}) {
  const [choice, setChoice] = useState<'UPHOLD' | 'INVALIDATE' | null>(null);
  const [category, setCategory] = useState('CONFIRMED_PROXY');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!choice || busy) return;
    if (why.trim().length < MIN_REASON) {
      setError('Write a reason of at least 10 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await antiProxyApi.resolve(courseId, sessionId, dispute.id, {
      resolution: choice,
      ...(choice === 'INVALIDATE' ? { category } : {}),
      explanation: why.trim(),
    });
    setBusy(false);
    if (r.ok) {
      setChoice(null);
      setWhy('');
      onResolved();
    } else {
      setError(PROBLEMS[r.code] ?? 'Could not resolve this review.');
      if (r.code === 'INVALID_TRANSITION') onResolved();
    }
  };

  const heading = `${dispute.studentId} ${dispute.fullName}`;
  return (
    <li className="subcard" aria-label={`Review of ${heading}`}>
      <p>
        <strong>{dispute.studentId}</strong> {dispute.fullName}{' '}
        <Badge tone={DISPUTE_TONE[dispute.state] ?? 'neutral'}>
          {DISPUTE_LABEL[dispute.state] ?? dispute.state}
        </Badge>
      </p>
      <p className="muted">
        Attendance is currently{' '}
        {dispute.attendanceStatus === 'PRESENT' ? 'recorded as present' : 'invalidated'}. Opened{' '}
        {new Date(dispute.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {dispute.fromSpotCheck ? ' after a spot check could not find them in the room' : ''}.
      </p>
      <ul className="list">
        {dispute.events
          .filter((ev) => ev.note)
          .map((ev) => (
            <li key={ev.eventNo}>
              <span className="muted">
                {ev.byRole === 'STUDENT' ? 'Student’s reply' : `Resolved by ${ev.by}`}:
              </span>{' '}
              {ev.note}
            </li>
          ))}
      </ul>

      {dispute.state === 'OPEN' && !choice && (
        <div className="actions">
          <Button variant="secondary" onClick={() => setChoice('UPHOLD')}>
            Keep this attendance
          </Button>
          <Button variant="secondary" onClick={() => setChoice('INVALIDATE')}>
            Invalidate this attendance
          </Button>
        </div>
      )}
      {choice && (
        <form
          className="stack"
          onSubmit={(e) => void resolve(e)}
          aria-label={`Resolve review of ${heading}`}
        >
          <p>
            <strong>
              {choice === 'UPHOLD' ? 'Keep this attendance' : 'Invalidate this attendance'}
            </strong>
          </p>
          {choice === 'INVALIDATE' && (
            <div className="field">
              <label htmlFor={`cat-${dispute.id}`}>Reason</label>
              <select
                id={`cat-${dispute.id}`}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {Object.entries(INVALIDATION_LABEL).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor={`res-${dispute.id}`}>Your reason (required)</label>
            <textarea
              id={`res-${dispute.id}`}
              rows={2}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
            />
          </div>
          {error && <Notice tone="danger" title={error} urgent />}
          <div className="actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : 'Close the review'}
            </button>
            <Button variant="secondary" onClick={() => setChoice(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

/** Records a lecturer is reviewing. Hidden entirely when there are none. */
export function DisputesPanel({
  courseId,
  sessionId,
  reloadKey,
  onResolved,
}: {
  courseId: string;
  sessionId: string;
  reloadKey: number;
  onResolved: () => void;
}) {
  const [disputes, setDisputes] = useState<Dispute[] | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const r = await antiProxyApi.disputes(courseId, sessionId);
    if (!mounted.current) return;
    if (r.ok) {
      setDisputes(r.data.disputes);
      setFailed(false);
    } else setFailed(true);
  }, [courseId, sessionId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load, reloadKey]);

  if (failed)
    return <Notice tone="danger" title="Could not load the records under review" urgent />;
  if (!disputes || disputes.length === 0) return null;

  const open = disputes.filter((d) => d.state === 'OPEN').length;
  return (
    <section className="card" aria-labelledby="disputes-heading">
      <h2 id="disputes-heading">Records under review</h2>
      <p className="muted">
        {open > 0
          ? `${open} awaiting your decision. The student keeps their attendance until you decide, and can send you a reply.`
          : 'All reviews are closed.'}
      </p>
      <ul className="list">
        {disputes.map((d) => (
          <DisputeCard
            key={d.id}
            dispute={d}
            courseId={courseId}
            sessionId={sessionId}
            onResolved={() => {
              void load();
              onResolved();
            }}
          />
        ))}
      </ul>
    </section>
  );
}
