import { useCallback, useEffect, useState } from 'react';
import { antiProxyApi, type Reconciliation } from '../../api/lecturer';
import { Badge, Notice } from '../../components/ui';
import { RECONCILIATION_LABEL, RECONCILIATION_TONE } from './labels';

const PROBLEMS: Record<string, string> = {
  INVALID_HEADCOUNT: 'Enter a whole number of people.',
  SESSION_NOT_STARTED: 'Start the session before recording a headcount.',
  NO_HEADCOUNT: 'Record a headcount before adding a note about it.',
  RATE_LIMITED: 'Too many changes just now. Wait a moment and try again.',
  NETWORK: 'Could not reach the server. Try again.',
};

const when = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const MESSAGE: Record<string, string> = {
  NO_HEADCOUNT:
    'Count the people in the room and enter the number. It is compared with how many students are recorded present.',
  CONSISTENT: 'The headcount and the recorded attendance agree, within the allowed difference.',
  REVIEW_RECOMMENDED:
    'More students are recorded present than people counted. That can be innocent (a miscount, or people who left), so look at it before drawing any conclusion. A spot check below can help.',
  MORE_PEOPLE_THAN_RECORDS:
    'More people were counted than students recorded. Some may not have checked in yet.',
};

/**
 * The lecturer's count of people physically in the room, next to the number of students recorded
 * present. A gap is a prompt to look closer, never a finding about any student, and nothing on this
 * panel changes anyone's attendance.
 */
export function ReconciliationPanel({
  courseId,
  sessionId,
  presentTotal,
  onHeadcountKnown,
}: {
  courseId: string;
  sessionId: string;
  /** When this changes (someone checked in or was corrected) the comparison is fetched again. */
  presentTotal: number;
  /** Reports whether a headcount exists yet, so the page can keep the recorded total hidden until then. */
  onHeadcountKnown?: (entered: boolean) => void;
}) {
  const [data, setData] = useState<Reconciliation | null>(null);
  const [failed, setFailed] = useState(false);
  const [value, setValue] = useState('');
  const [why, setWhy] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await antiProxyApi.reconciliation(courseId, sessionId);
    if (r.ok) {
      setData(r.data);
      setFailed(false);
      onHeadcountKnown?.(r.data.headcount != null);
    } else {
      setFailed(true);
      onHeadcountKnown?.(false);
    }
  }, [courseId, sessionId, onHeadcountKnown]);

  useEffect(() => {
    void load();
  }, [load, presentTotal]);

  if (failed) return <Notice tone="danger" title="Could not load the headcount" urgent />;
  if (!data) return <p role="status">Loading the headcount…</p>;
  if (data.sessionState === 'NOT_STARTED') return null;

  const max = data.limits.headcountMax;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setMessage(null);
    const text = value.trim();
    // The server checks this again; checking here just saves a round trip.
    if (!/^\d+$/.test(text) || Number(text) > max) {
      setFieldError(`Enter a whole number from 0 to ${max}.`);
      return;
    }
    setFieldError(null);
    setBusy(true);
    const r = await antiProxyApi.setHeadcount(
      courseId,
      sessionId,
      Number(text),
      why.trim() || undefined,
    );
    setBusy(false);
    if (r.ok) {
      setData(r.data.reconciliation);
      onHeadcountKnown?.(r.data.reconciliation.headcount != null);
      setValue('');
      setWhy('');
      setMessage({
        tone: 'success',
        text: r.data.unchanged ? 'That is already the recorded headcount.' : 'Headcount saved.',
      });
    } else {
      setMessage({ tone: 'danger', text: PROBLEMS[r.code] ?? 'Could not save the headcount.' });
    }
  };

  const saveNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await antiProxyApi.addNote(courseId, sessionId, note.trim());
    setBusy(false);
    if (r.ok) {
      setData(r.data);
      setNote('');
      setMessage({ tone: 'success', text: 'Note saved.' });
    } else {
      setMessage({
        tone: 'danger',
        text:
          r.code === 'INVALID_REQUEST'
            ? 'Write a note of at least 10 characters.'
            : (PROBLEMS[r.code] ?? 'Could not save the note.'),
      });
    }
  };

  const hc = data.headcount;
  return (
    <section className="card" aria-labelledby="headcount-heading">
      <h2 id="headcount-heading">Room headcount</h2>
      <p className="muted">
        A prompt to look closer, not proof of anything. Students arrive late, step out, or have
        trouble checking in.
      </p>

      {!hc && (
        <Notice tone="info" title="Count the room before you see the recorded total">
          Enter your own count first. The number of students recorded present is hidden until then,
          so your count is independent of it.
        </Notice>
      )}

      <dl className="counts">
        <div>
          <dt>People in the room</dt>
          <dd>{hc ? hc.headcount : '—'}</dd>
        </div>
        <div>
          <dt>Students recorded present</dt>
          <dd>{hc ? data.recordedAttendance : '—'}</dd>
        </div>
        <div>
          <dt>Difference</dt>
          <dd>
            {!hc || data.difference === null
              ? '—'
              : data.difference > 0
                ? `+${data.difference}`
                : data.difference}
          </dd>
        </div>
      </dl>

      <p>
        <Badge tone={RECONCILIATION_TONE[data.status] ?? 'neutral'}>
          {RECONCILIATION_LABEL[data.status] ?? data.status}
        </Badge>
      </p>
      <p>{MESSAGE[data.status]}</p>
      {hc && (
        <p className="muted">
          Counted at {when(hc.recordedAt)} by {hc.recordedBy}
          {hc.revNo > 1 ? ` (correction ${hc.revNo - 1}; it was ${hc.previousHeadcount})` : ''}.
          {data.tolerance.allowed !== null &&
            ` A difference of up to ${data.tolerance.allowed} is treated as normal.`}
        </p>
      )}
      {data.status === 'NO_HEADCOUNT' && data.recordedAttendance > 0 && (
        <Notice tone="warning" title="No headcount recorded for this class yet" />
      )}
      {data.stale.isStale && (
        <Notice tone="warning" title="This headcount may be out of date">
          {data.stale.checkInsSince} student(s) have been recorded since it was taken{' '}
          {data.stale.minutesSince} minutes ago. Count again if people have come or gone.
        </Notice>
      )}

      <form className="stack" onSubmit={(e) => void save(e)} aria-label="Record headcount">
        <div className="field">
          <label htmlFor="headcount-value">
            {hc ? 'Correct the headcount' : 'People in the room'}
          </label>
          <input
            id="headcount-value"
            inputMode="numeric"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'headcount-error' : undefined}
            required
          />
          {fieldError && (
            <span id="headcount-error" className="hint" role="alert">
              {fieldError}
            </span>
          )}
        </div>
        {hc && (
          <div className="field">
            <label htmlFor="headcount-why">Why are you changing it? (optional)</label>
            <input
              id="headcount-why"
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              maxLength={1000}
            />
          </div>
        )}
        <button type="submit" className="btn" disabled={busy || !value.trim()}>
          {busy ? 'Saving…' : hc ? 'Save correction' : 'Save headcount'}
        </button>
      </form>

      {message && (
        <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
      )}

      {hc && (
        <form
          className="stack"
          onSubmit={(e) => void saveNote(e)}
          aria-label="Add a note about this count"
        >
          <div className="field">
            <label htmlFor="headcount-note">Add a note about this difference (optional)</label>
            <textarea
              id="headcount-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="For example: six students arrived late and left early"
            />
          </div>
          <button
            type="submit"
            className="btn btn--secondary"
            disabled={busy || note.trim().length < 10}
          >
            Save note
          </button>
        </form>
      )}
      {data.notes.length > 0 && (
        <ul className="list">
          {data.notes.map((n) => (
            <li key={n.recordedAt}>
              <span className="muted">
                {when(n.recordedAt)} · {n.recordedBy}:
              </span>{' '}
              {n.note}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
