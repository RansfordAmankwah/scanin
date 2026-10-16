import { useCallback, useEffect, useRef, useState } from 'react';
import {
  antiProxyApi,
  type SpotCheckItem,
  type SpotChecks,
  type SpotOutcome,
  type VerificationMethod,
} from '../../api/lecturer';
import { Badge, Button, Notice } from '../../components/ui';
import { METHOD_LABEL, RISK_FACTOR_LABEL, SPOT_STATE_LABEL, SPOT_STATE_TONE } from './labels';

const PROBLEMS: Record<string, string> = {
  INVALID_SAMPLE_SIZE: 'Choose a whole number of students within the limit.',
  NO_ELIGIBLE_STUDENTS:
    'There is no one left to check: everyone recorded present by QR scan has already been picked.',
  SESSION_NOT_STARTED: 'Start the session before running spot checks.',
  INVALID_TRANSITION:
    'That result cannot follow the one already recorded. The list has been refreshed.',
  METHOD_REQUIRED: 'Say how you verified the student.',
  EXPLANATION_REQUIRED: 'Explain what you found, in at least 10 characters.',
  CONFLICT: 'This check changed while you were recording it. Reload and try again.',
  RATE_LIMITED: 'Too many requests just now. Wait a moment and try again.',
  NETWORK: 'Could not reach the server. Try again.',
};

const OUTCOME_LABEL: Record<SpotOutcome, string> = {
  VERIFIED: 'Verified in person',
  NOT_PRESENT: 'Not found in the room',
  COULD_NOT_VERIFY: 'Could not verify',
};

/** Which result may follow which; the server enforces the same table. */
const NEXT: Record<SpotCheckItem['state'], SpotOutcome[]> = {
  PENDING: ['VERIFIED', 'NOT_PRESENT', 'COULD_NOT_VERIFY'],
  COULD_NOT_VERIFY: ['VERIFIED', 'NOT_PRESENT'],
  VERIFIED: ['NOT_PRESENT'],
  NOT_PRESENT: ['VERIFIED'],
};

const MIN_EXPLANATION = 10;

function SpotItem({
  item,
  courseId,
  sessionId,
  onResult,
}: {
  item: SpotCheckItem;
  courseId: string;
  sessionId: string;
  onResult: (data: SpotChecks) => void;
}) {
  const [choice, setChoice] = useState<SpotOutcome | null>(null);
  const [method, setMethod] = useState<VerificationMethod>('STUDENT_ID_CARD');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per attempt: pressing the button twice, or retrying after a dropped connection, is one result.
  const requestId = useRef(crypto.randomUUID());

  const correction = item.state === 'VERIFIED' || item.state === 'NOT_PRESENT';
  const needsWhy = choice === 'NOT_PRESENT' || correction;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!choice || busy) return;
    if (needsWhy && why.trim().length < MIN_EXPLANATION) {
      setError(PROBLEMS.EXPLANATION_REQUIRED as string);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await antiProxyApi.record(courseId, sessionId, item.id, {
      requestId: requestId.current,
      outcome: choice,
      ...(choice === 'VERIFIED' ? { method } : {}),
      ...(why.trim() ? { explanation: why.trim() } : {}),
    });
    setBusy(false);
    if (r.ok) {
      requestId.current = crypto.randomUUID();
      setChoice(null);
      setWhy('');
      onResult(r.data);
    } else {
      setError(PROBLEMS[r.code] ?? 'Could not record the result.');
      if (r.code === 'INVALID_TRANSITION') {
        const fresh = await antiProxyApi.spotChecks(courseId, sessionId);
        if (fresh.ok) onResult(fresh.data);
      }
    }
  };

  const heading = `${item.studentId} ${item.fullName}`;
  return (
    <li className="subcard" aria-label={heading}>
      <p>
        <strong>{item.studentId}</strong> {item.fullName}{' '}
        <Badge tone={SPOT_STATE_TONE[item.state] ?? 'neutral'}>
          {SPOT_STATE_LABEL[item.state] ?? item.state}
        </Badge>
      </p>
      <p className="muted">
        {item.selectionReason === 'IN_PERSON_REQUIRED'
          ? 'An in-person check is required for this student. This is not a finding about them.'
          : item.selectionReason === 'RANDOM'
            ? 'Picked at random.'
            : `Picked at random, with a higher chance because ${item.riskFactors
                .map((f) => RISK_FACTOR_LABEL[f] ?? f)
                .join(' and ')}. This is not a finding about the student.`}
      </p>
      {item.state === 'COULD_NOT_VERIFY' && (
        <p>This check is not settled. Look again, or record what you found.</p>
      )}
      {item.state === 'NOT_PRESENT' && item.disputeState === 'OPEN' && (
        <p className="muted">
          Their attendance still counts while it is reviewed (see “Records under review”).
        </p>
      )}

      {!choice && (
        <div className="actions">
          {NEXT[item.state].map((o) => (
            <Button
              key={o}
              variant="secondary"
              onClick={() => {
                setChoice(o);
                setError(null);
              }}
            >
              {correction ? `Correct to: ${OUTCOME_LABEL[o]}` : OUTCOME_LABEL[o]}
            </Button>
          ))}
        </div>
      )}

      {choice && (
        <form
          className="stack"
          onSubmit={(e) => void submit(e)}
          aria-label={`Record result for ${heading}`}
        >
          <p>
            <strong>{OUTCOME_LABEL[choice]}</strong>
          </p>
          {choice === 'VERIFIED' && (
            <div className="field">
              <label htmlFor={`method-${item.id}`}>How did you verify them?</label>
              <select
                id={`method-${item.id}`}
                value={method}
                onChange={(e) => setMethod(e.target.value as VerificationMethod)}
              >
                {Object.entries(METHOD_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor={`why-${item.id}`}>
              {needsWhy ? 'What did you find? (required)' : 'Note (optional)'}
            </label>
            <textarea
              id={`why-${item.id}`}
              rows={2}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              maxLength={2000}
            />
          </div>
          {choice === 'NOT_PRESENT' && (
            <p className="muted">
              This opens a review. The student’s attendance is not changed by this alone.
            </p>
          )}
          {error && <Notice tone="danger" title={error} urgent />}
          <div className="actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : 'Save result'}
            </button>
            <Button variant="secondary" onClick={() => setChoice(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!choice && error && <Notice tone="danger" title={error} urgent />}

      {item.history.length > 0 && (
        <details>
          <summary>History ({item.history.length})</summary>
          <ul className="list">
            {item.history.map((h) => (
              <li key={h.eventNo}>
                {new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                {h.by}: {SPOT_STATE_LABEL[h.to]}
                {h.method ? ` (${METHOD_LABEL[h.method]})` : ''}
                {h.explanation ? ` — ${h.explanation}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/**
 * Randomised identity spot checks. The lecturer chooses how many students to check in person; the
 * server picks them at random from those recorded present by QR scan. Only the lecturer sees the
 * list; students are never told they were picked.
 */
export function SpotChecksPanel({
  courseId,
  sessionId,
  sessionState,
  onChanged,
}: {
  courseId: string;
  sessionId: string;
  sessionState: string;
  onChanged: () => void;
}) {
  const [data, setData] = useState<SpotChecks | null>(null);
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());

  const load = useCallback(async () => {
    const r = await antiProxyApi.spotChecks(courseId, sessionId);
    if (r.ok) {
      setData(r.data);
      setFailed(false);
    } else setFailed(true);
  }, [courseId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (sessionState === 'NOT_STARTED') return null;
  if (failed) return <Notice tone="danger" title="Could not load the spot checks" urgent />;
  if (!data) return <p role="status">Loading spot checks…</p>;

  const wanted = size.trim() === '' ? data.limits.defaultSize : Number(size);

  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setMessage(null);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > data.limits.maxSize) {
      setMessage(`Choose a whole number from 1 to ${data.limits.maxSize}.`);
      return;
    }
    setBusy(true);
    const r = await antiProxyApi.generate(courseId, sessionId, wanted, requestId.current);
    setBusy(false);
    if (r.ok) {
      requestId.current = crypto.randomUUID();
      setData(r.data);
      setSize('');
      onChanged();
    } else {
      setMessage(PROBLEMS[r.code] ?? 'Could not choose students.');
    }
  };

  const items = data.rounds.flatMap((r) => r.items);
  const accept = (fresh: SpotChecks) => {
    setData(fresh);
    onChanged();
  };

  return (
    <section className="card" aria-labelledby="spot-heading">
      <h2 id="spot-heading">Spot checks</h2>
      <p className="muted">
        Check in person that a few students are really in the room. A random sample is chosen from
        students recorded present by QR scan. Being picked is not an accusation, and not finding
        someone starts a review rather than removing their attendance.
      </p>

      <form
        className="stack"
        onSubmit={(e) => void generate(e)}
        aria-label="Choose students to check"
      >
        <div className="field">
          <label htmlFor="spot-size">How many students? (1 to {data.limits.maxSize})</label>
          <input
            id="spot-size"
            inputMode="numeric"
            autoComplete="off"
            value={size}
            placeholder={String(data.limits.defaultSize)}
            onChange={(e) => setSize(e.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {busy
            ? 'Choosing…'
            : items.length > 0
              ? 'Choose more students'
              : 'Choose students to check'}
        </button>
      </form>
      {message && <Notice tone="danger" title={message} urgent />}

      {items.length === 0 ? (
        <p className="muted">No spot check has been run for this class yet.</p>
      ) : (
        <>
          <p role="status">
            {data.summary.pending} to check · {data.summary.verified} verified ·{' '}
            {data.summary.notPresent} not found · {data.summary.couldNotVerify} could not verify
          </p>
          <ul className="list">
            {items.map((item) => (
              <SpotItem
                key={item.id}
                item={item}
                courseId={courseId}
                sessionId={sessionId}
                onResult={accept}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
