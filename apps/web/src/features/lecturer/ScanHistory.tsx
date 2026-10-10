import { useCallback, useState } from 'react';
import { lecturerApi, type ScanRow } from '../../api/lecturer';
import { Button, Notice } from '../../components/ui';
import { OUTCOME_LABEL } from './labels';

/**
 * Individual scan times, outcomes and network clusters. Kept apart from the attendance table on
 * purpose, and loaded only when asked for. Scan metadata is kept for 90 days.
 */
export function ScanHistory({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [student, setStudent] = useState('');
  const [outcome, setOutcome] = useState('');
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      setBusy(true);
      setError(false);
      const r = await lecturerApi.scans(courseId, sessionId, {
        student: student.trim(),
        outcome,
        ...(before ? { before } : {}),
      });
      setBusy(false);
      if (!r.ok) return setError(true);
      setRows((prev) => (before ? [...prev, ...r.data.scans] : r.data.scans));
      setCursor(r.data.nextCursor);
      setLoaded(true);
    },
    [courseId, sessionId, student, outcome],
  );

  if (!open) {
    return (
      <section className="card">
        <h2>Scan history</h2>
        <p className="muted">Every scan attempt with its time and result. Kept for 90 days.</p>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true);
            void load();
          }}
        >
          Show scan history
        </Button>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="scans-heading">
      <h2 id="scans-heading">Scan history</h2>
      <form
        className="stack"
        aria-label="Filter scans"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <div className="field">
          <label htmlFor="scan-student">Student ID or name</label>
          <input id="scan-student" value={student} onChange={(e) => setStudent(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="scan-outcome">Result</label>
          <select id="scan-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All results</option>
            {Object.entries(OUTCOME_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn--secondary">
          Search
        </button>
      </form>

      {error && <Notice tone="danger" title="Could not load scan history" urgent />}
      {loaded && rows.length === 0 && <p className="muted">No scans match.</p>}
      {rows.length > 0 && (
        <table className="responsive">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Student</th>
              <th scope="col">Result</th>
              <th scope="col">Browser</th>
              <th scope="col">Network</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td data-label="Time">{new Date(s.receivedAt).toLocaleTimeString()}</td>
                <td data-label="Student">
                  {s.studentId} {s.fullName}
                </td>
                <td data-label="Result">{OUTCOME_LABEL[s.outcome] ?? s.outcome}</td>
                <td data-label="Browser">{s.browser ?? '—'}</td>
                <td data-label="Network">{s.network ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && (
        <Button variant="secondary" onClick={() => void load(cursor)} disabled={busy}>
          Load more
        </Button>
      )}
      <p className="muted">
        “Network” is a short label for a hashed address: equal labels mean the same network. Many
        students share campus Wi-Fi, so this is context, not proof.
      </p>
    </section>
  );
}
