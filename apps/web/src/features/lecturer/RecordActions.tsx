import { useState } from 'react';
import { reviewApi, type RosterRecord } from '../../api/lecturer';
import { Button } from '../../components/ui';
import { ExplainedForm, outcome } from './ExplainedForm';
import { INVALIDATION_LABEL } from './labels';

type Mode = null | 'invalidate' | 'restore' | 'flag' | 'history';

const KIND: Record<string, string> = {
  CREATED_QR: 'Checked in by QR scan',
  CREATED_MANUAL: 'Marked present by lecturer',
  INVALIDATED: 'Invalidated',
  RESTORED: 'Restored',
};

/** Correct one attendance record. Every action is explained, recorded, and reversible by a further recorded action. */
export function RecordActions({
  courseId,
  sessionId,
  record,
  onChanged,
}: {
  courseId: string;
  sessionId: string;
  record: RosterRecord;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [category, setCategory] = useState('INCORRECT_ENTRY');
  const [history, setHistory] = useState<Awaited<
    ReturnType<typeof reviewApi.attendanceHistory>
  > | null>(null);
  const id = record.attendanceId;
  const close = () => setMode(null);
  const done = () => {
    close();
    onChanged();
  };

  const showHistory = async () => {
    setMode('history');
    setHistory(await reviewApi.attendanceHistory(courseId, sessionId, id));
  };

  return (
    <div className="stack">
      <div className="actions">
        {record.status === 'PRESENT' ? (
          <Button variant="secondary" onClick={() => setMode('invalidate')}>
            Invalidate…
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setMode('restore')}>
            Restore…
          </Button>
        )}
        <Button variant="secondary" onClick={() => setMode('flag')}>
          Flag…
        </Button>
        <Button variant="secondary" onClick={() => void showHistory()}>
          History
        </Button>
      </div>

      {mode === 'invalidate' && (
        <ExplainedForm
          label={`Invalidate ${record.studentId}`}
          submitLabel="Invalidate attendance"
          onCancel={close}
          onDone={done}
          onSubmit={async (why) =>
            outcome(await reviewApi.invalidate(courseId, sessionId, id, category, why))
          }
        >
          <div className="field">
            <label htmlFor={`cat-${id}`}>Reason</label>
            <select id={`cat-${id}`} value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(INVALIDATION_LABEL).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </div>
        </ExplainedForm>
      )}

      {mode === 'restore' && (
        <ExplainedForm
          label={`Restore ${record.studentId}`}
          submitLabel="Restore attendance"
          onCancel={close}
          onDone={done}
          onSubmit={async (why) => outcome(await reviewApi.restore(courseId, sessionId, id, why))}
        />
      )}

      {mode === 'flag' && (
        <ExplainedForm
          label={`Flag ${record.studentId}`}
          submitLabel="Raise flag"
          onCancel={close}
          onDone={done}
          onSubmit={async (why) =>
            outcome(
              await reviewApi.raiseFlag(courseId, {
                kind: 'PROXY_SUSPECTED',
                attendanceId: id,
                note: why,
              }),
            )
          }
        >
          <p className="muted">
            A flag records a concern. It does not change this attendance record; you decide that
            separately.
          </p>
        </ExplainedForm>
      )}

      {mode === 'history' && (
        <div className="subform">
          <h4>History for {record.studentId}</h4>
          {!history && <p role="status">Loading…</p>}
          {history && history.ok && (
            <ol>
              {history.data.revisions.map((v) => (
                <li key={v.revNo}>
                  {KIND[v.kind] ?? v.kind} by {v.actor}
                  {v.category ? ` (${INVALIDATION_LABEL[v.category] ?? v.category})` : ''}
                  {v.explanation ? `: “${v.explanation}”` : ''}
                </li>
              ))}
            </ol>
          )}
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}
