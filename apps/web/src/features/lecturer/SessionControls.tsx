import { useState } from 'react';
import { lecturerApi, type SessionView } from '../../api/lecturer';
import {
  Badge,
  Button,
  ConfirmDialog,
  LinkButton,
  Notice,
  SelectField,
  TextField,
} from '../../components/ui';
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
  const [confirmEnd, setConfirmEnd] = useState(false);
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
    setConfirmEnd(false);
    void run(() => lecturerApi.end(courseId, id));
  };

  const extend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!session.checkInDeadline) return;
    void run(() =>
      lecturerApi.extend(courseId, id, minutes, reason, session.checkInDeadline as string),
    ).then(() => setReason(''));
  };

  const STATE_TONE = {
    NOT_STARTED: 'neutral',
    CHECK_IN_OPEN: 'info',
    CHECK_IN_CLOSED: 'warning',
    ENDED: 'neutral',
  } as const;

  return (
    <section className="card" aria-labelledby="controls-heading">
      <div className="card__header">
        <div>
          <h2 id="controls-heading">Session controls</h2>
          <p className="card__description cluster">
            <span>Status:</span>
            <Badge tone={STATE_TONE[session.state]}>{SESSION_STATE_LABEL[session.state]}</Badge>
            {session.state === 'CHECK_IN_OPEN' && session.checkInDeadline && (
              <span>closes at {timeLabel(session.checkInDeadline)}</span>
            )}
            {session.state === 'CHECK_IN_CLOSED' && (
              <span>closed at {timeLabel(session.checkInClosedAt)}</span>
            )}
          </p>
        </div>
        {session.state === 'CHECK_IN_OPEN' && (
          <LinkButton to={`/present/${courseId}/${id}`}>Show QR code for the room</LinkButton>
        )}
        {session.state === 'NOT_STARTED' && (
          <Button onClick={() => void run(() => lecturerApi.start(courseId, id))} disabled={busy}>
            Start check-in (30 minutes)
          </Button>
        )}
      </div>

      {session.state === 'CHECK_IN_OPEN' && (
        <form className="stack" onSubmit={extend} aria-label="Extend check-in">
          <div className="form-grid form-grid--2">
            <SelectField
              label="Extend by"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            >
              {[5, 10, 15, 30].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </SelectField>
            <TextField
              label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={3}
              hint="Recorded with the extension."
            />
          </div>
          <div className="actions">
            <button type="submit" className="btn btn--secondary" disabled={busy}>
              Extend check-in
            </button>
          </div>
        </form>
      )}

      {(session.state === 'CHECK_IN_OPEN' || session.state === 'CHECK_IN_CLOSED') && (
        <div className="actions">
          <Button variant="danger" onClick={() => setConfirmEnd(true)} disabled={busy}>
            End session
          </Button>
        </div>
      )}

      {session.state === 'ENDED' && (
        <p className="muted">This session has ended. You can still review attendance.</p>
      )}
      {session.extensions && session.extensions.length > 0 && (
        <p className="muted">Extended {session.extensions.length} time(s).</p>
      )}
      {error && <Notice tone="danger" title={error} urgent />}

      <ConfirmDialog
        open={confirmEnd}
        title="End this class session now?"
        confirmLabel="End session now"
        danger
        busy={busy}
        onConfirm={end}
        onCancel={() => setConfirmEnd(false)}
      >
        <p>Check-in closes immediately and this cannot be undone.</p>
      </ConfirmDialog>
    </section>
  );
}
