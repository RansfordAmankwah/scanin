import { useCallback, useEffect, useState } from 'react';
import {
  reviewApi,
  type LinkDecisionBody,
  type QueueFlag,
  type QueueLink,
  type Suggestion,
} from '../../api/lecturer';
import { Button, Notice } from '../../components/ui';
import { ExplainedForm, outcome } from './ExplainedForm';
import { associationLabel, FLAG_LABEL } from './labels';

type Choice =
  | 'CONFIRM_IDENTITY'
  | 'CONFIRM_ENROLLMENT'
  | 'KEEP_PROVISIONAL'
  | 'REJECT'
  | 'MARK_REVIEW_REQUIRED';

const CHOICE_LABEL: Record<Choice, string> = {
  CONFIRM_IDENTITY: 'Confirm identity (I recognise this student)',
  CONFIRM_ENROLLMENT: 'Confirm enrollment (they belong in this course)',
  KEEP_PROVISIONAL: 'Keep provisional',
  REJECT: 'Reject this match',
  MARK_REVIEW_REQUIRED: 'Mark as needing review',
};

function toBody(choice: Choice, entryId: string, explanation: string): LinkDecisionBody {
  switch (choice) {
    case 'CONFIRM_IDENTITY':
    case 'CONFIRM_ENROLLMENT':
      return {
        decision: 'CONFIRM',
        basis:
          choice === 'CONFIRM_IDENTITY'
            ? 'LECTURER_IDENTITY_CONFIRMED'
            : 'LECTURER_ENROLLMENT_CONFIRMED',
        ...(entryId ? { entryId } : {}),
        explanation,
      };
    default:
      return { decision: choice, explanation };
  }
}

function LinkCard({
  courseId,
  link,
  onChanged,
}: {
  courseId: string;
  link: QueueLink;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>('CONFIRM_ENROLLMENT');
  const [entryId, setEntryId] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [history, setHistory] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onList = link.rosterEntry !== null;

  const doAdd = async () => {
    setBusy(true);
    setError(null);
    const r = await reviewApi.addToClass(courseId, link.linkId);
    setBusy(false);
    if (r.ok) onChanged();
    else setError('Could not add this student. Refresh and try again.');
  };
  const doRemove = async () => {
    setBusy(true);
    setError(null);
    const r = await reviewApi.removeFromClass(courseId, link.linkId);
    setBusy(false);
    if (r.ok) onChanged();
    else setError('Could not remove this student. Refresh and try again.');
  };

  const loadSuggestions = async () => {
    const r = await reviewApi.suggestions(courseId, link.linkId);
    setSuggestions(r.ok ? r.data.candidates : []);
  };
  const loadHistory = async () => {
    const r = await reviewApi.linkHistory(courseId, link.linkId);
    setHistory(
      r.ok
        ? r.data.reviews.map(
            (h) =>
              `${h.actor}: ${h.decision.replaceAll('_', ' ').toLowerCase()} → ${h.toState.toLowerCase().replace('_', ' ')}${h.explanation ? ` (“${h.explanation}”)` : ''}`,
          )
        : ['Could not load history.'],
    );
  };

  return (
    <article className="card" aria-label={`${link.studentId} ${link.fullName}`}>
      <h3>
        {link.studentId} · {link.fullName}
      </h3>
      <p>
        <strong>{onList ? associationLabel(link.state, null) : 'Not on the class list'}</strong>
        {link.rosterEntry && (
          <>
            {' '}
            · class list entry {link.rosterEntry.studentId} {link.rosterEntry.fullName}
          </>
        )}
      </p>
      <p className="muted">
        {link.email} {link.emailVerified ? '(verified)' : '(not verified)'} · {link.attendanceCount}{' '}
        attendance record(s) in this course
      </p>
      <p className="muted">Self-reported details. Your decision applies to this course only.</p>

      <div className="actions">
        <Button onClick={() => void doAdd()} disabled={busy}>
          Part of class
        </Button>
        {!confirmRemove ? (
          <Button variant="danger" onClick={() => setConfirmRemove(true)} disabled={busy}>
            Not part of class
          </Button>
        ) : (
          <>
            <Button variant="danger" onClick={() => void doRemove()} disabled={busy}>
              Confirm remove
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>
              Cancel
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(true);
            void loadSuggestions();
          }}
        >
          More options…
        </Button>
        <Button variant="ghost" onClick={() => void loadHistory()}>
          History
        </Button>
      </div>
      {confirmRemove && (
        <p className="muted">
          Removing them also marks their attendance in this course invalid. You can restore it
          later.
        </p>
      )}
      {error && <Notice tone="danger" title={error} urgent />}

      {history && (
        <ol aria-label="Match history">
          {history.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ol>
      )}

      {open && (
        <ExplainedForm
          label={`Decide ${link.studentId}`}
          submitLabel="Record decision"
          onCancel={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onChanged();
          }}
          onSubmit={(why) => submit(why)}
        >
          <div className="field">
            <label htmlFor={`choice-${link.linkId}`}>Decision</label>
            <select
              id={`choice-${link.linkId}`}
              value={choice}
              onChange={(e) => setChoice(e.target.value as Choice)}
            >
              {Object.entries(CHOICE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {choice.startsWith('CONFIRM') && (
            <div className="field">
              <label htmlFor={`entry-${link.linkId}`}>Class-list entry (optional)</label>
              <select
                id={`entry-${link.linkId}`}
                value={entryId}
                onChange={(e) => setEntryId(e.target.value)}
              >
                <option value="">No entry</option>
                {(suggestions ?? []).map((c) => (
                  <option key={c.entryId} value={c.entryId}>
                    {c.studentId} {c.fullName} (similarity {c.similarity})
                  </option>
                ))}
              </select>
              <span className="hint">
                Suggestions only: names that look similar. Nothing is linked until you decide.
              </span>
            </div>
          )}
        </ExplainedForm>
      )}
    </article>
  );

  async function submit(why: string) {
    return outcome(await reviewApi.decide(courseId, link.linkId, toBody(choice, entryId, why)));
  }
}

function FlagCard({
  courseId,
  flag,
  onChanged,
}: {
  courseId: string;
  flag: QueueFlag;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<null | 'DISMISSED' | 'SUBSTANTIATED'>(null);
  const [busy, setBusy] = useState(false);
  const startReview = async () => {
    setBusy(true);
    await reviewApi.transitionFlag(courseId, flag.flagId, 'UNDER_REVIEW', '');
    setBusy(false);
    onChanged();
  };

  return (
    <article className="card" aria-label={`Flag: ${FLAG_LABEL[flag.kind] ?? flag.kind}`}>
      <h3>{FLAG_LABEL[flag.kind] ?? flag.kind}</h3>
      <p>
        {flag.studentId ? `${flag.studentId} ${flag.fullName ?? ''}` : 'Whole session'} ·{' '}
        <strong>{flag.state === 'OPEN' ? 'Open' : 'Under review'}</strong>
      </p>
      <div className="actions">
        {flag.state === 'OPEN' && (
          <Button variant="secondary" onClick={() => void startReview()} disabled={busy}>
            Start review
          </Button>
        )}
        {flag.state === 'UNDER_REVIEW' && (
          <>
            <Button variant="secondary" onClick={() => setMode('DISMISSED')}>
              Dismiss…
            </Button>
            <Button variant="secondary" onClick={() => setMode('SUBSTANTIATED')}>
              Substantiate…
            </Button>
          </>
        )}
      </div>
      {mode && (
        <ExplainedForm
          label={`${mode === 'DISMISSED' ? 'Dismiss' : 'Substantiate'} flag`}
          submitLabel={mode === 'DISMISSED' ? 'Dismiss flag' : 'Substantiate flag'}
          onCancel={() => setMode(null)}
          onDone={() => {
            setMode(null);
            onChanged();
          }}
          onSubmit={async (why) =>
            outcome(await reviewApi.transitionFlag(courseId, flag.flagId, mode, why))
          }
        >
          <p className="muted">
            Resolving a flag does not change attendance. If attendance should change, invalidate it
            separately.
          </p>
        </ExplainedForm>
      )}
    </article>
  );
}

/** Everything awaiting a lecturer decision for this course. */
export function ReviewQueue({ courseId }: { courseId: string }) {
  const [data, setData] = useState<{ links: QueueLink[]; flags: QueueFlag[] } | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const r = await reviewApi.queue(courseId);
    if (r.ok) setData(r.data);
    else setFailed(true);
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <Notice tone="danger" title="Could not load the review queue" urgent />;
  if (!data) return <p role="status">Loading review queue…</p>;

  return (
    <section className="stack" aria-labelledby="review-heading">
      <h2 id="review-heading">Needs your review</h2>
      <p className="muted">
        Student IDs and names are self-reported. “Confirmed” records your decision for this course;
        it does not verify anyone elsewhere.
      </p>
      {data.links.length === 0 && data.flags.length === 0 && (
        <Notice tone="success" title="Nothing needs review right now" />
      )}
      {data.links.map((l) => (
        <LinkCard key={l.linkId} courseId={courseId} link={l} onChanged={() => void load()} />
      ))}
      {data.flags.map((f) => (
        <FlagCard key={f.flagId} courseId={courseId} flag={f} onChanged={() => void load()} />
      ))}
    </section>
  );
}
