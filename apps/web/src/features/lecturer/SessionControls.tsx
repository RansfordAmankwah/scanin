import { useState } from 'react';
import { lecturerApi, type SessionView } from '../../api/lecturer';
import { Button, Notice, TextField } from '../../components/ui';
import { Link } from '../../router';
import { SESSION_STATE_LABEL } from './labels';

const MESSAGES: Record<string, string> = {
  INVALID_TRANSITION:
    "That is not possible in the session's current state. The page has been refreshed.",
  STALE_DEADLINE: 'The deadline changed in the meantime. The page has been refreshed; try again.',
  EXTENSION_TOO_FAR: 'The deadline cannot be more than 120 minutes from now.',
  NETWORK: 'Could not reach the server. Try again.',
};

function timeLabel(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

/** Start, extend and end a session. The server decides what is allowed; this only asks. */
export function SessionControls({
  session,
  onChange,
}: {
  session: SessionView;
  onChange: (s: SessionView | null) => void;
}) {
  const [minutes, setMinutes] = useState(10);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { courseId, id } = session;

  const run = async (action: () => ReturnType<typeof lecturerApi.start>) => {
    setBusy(true);
    setError(null);
    const r = await action();
    setBusy(false);
    if (r.ok) onChange(r.data.session);
    else {
      setError(MESSAGES[r.code] ?? 'Something went wrong. Try again.');
      if (r.status === 409) onChange(null); // ask the page to reload the current state
    }
  };

  const end = () => {
    if (
      !window.confirm(
        'End this class session now? Check-in closes immediately and this cannot be undone.',
      )
    )
      return;
    void run(() => lecturerApi.end(courseId, id));
  };

  const extend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!session.checkInDeadline) return;
    void run(() =>
      lecturerApi.extend(courseId, id, minutes, reason, session.checkInDeadline as string),
    ).then(() => setReason(''));
  };

  return (
    <section className="card" aria-labelledby="controls-heading">
      <h2 id="controls-heading">Session controls</h2>
      <p>
        Status: <strong>{SESSION_STATE_LABEL[session.state]}</strong>
        {session.state === 'CHECK_IN_OPEN' && session.checkInDeadline && (
          <> · closes at {timeLabel(session.checkInDeadline)}</>
        )}
        {session.state === 'CHECK_IN_CLOSED' && (
          <> · closed at {timeLabel(session.checkInClosedAt)}</>
        )}
      </p>

      {session.state === 'NOT_STARTED' && (
        <div>
          <Button onClick={() => void run(() => lecturerApi.start(courseId, id))} disabled={busy}>
            Start check-in (30 minutes)
          </Button>
        </div>
      )}

      {session.state === 'CHECK_IN_OPEN' && (
        <>
          <Link to={`/present/${courseId}/${id}`} className="btn">
            Show QR code for the room
          </Link>
          <form className="stack" onSubmit={extend} aria-label="Extend check-in">
            <div className="field">
              <label htmlFor="extend-minutes">Extend by</label>
              <select
                id="extend-minutes"
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              >
                {[5, 10, 15, 30].map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={3}
            />
            <button type="submit" className="btn btn--secondary" disabled={busy}>
              Extend check-in
            </button>
          </form>
        </>
      )}

      {(session.state === 'CHECK_IN_OPEN' || session.state === 'CHECK_IN_CLOSED') && (
        <Button variant="secondary" onClick={end} disabled={busy}>
          End session
        </Button>
      )}

      {session.state === 'ENDED' && (
        <p className="muted">This session has ended. You can still review attendance.</p>
      )}
      {session.extensions && session.extensions.length > 0 && (
        <p className="muted">Extended {session.extensions.length} time(s).</p>
      )}
      {error && <Notice tone="danger" title={error} urgent />}
    </section>
  );
}
