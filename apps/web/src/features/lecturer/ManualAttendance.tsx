import { useState } from 'react';
import { reviewApi } from '../../api/lecturer';
import { Notice, TextField } from '../../components/ui';
import { ERROR_TEXT, MIN_EXPLANATION } from './ExplainedForm';

/** Mark a registered student present without a scan. Clearly recorded as a manual entry. */
export function ManualAttendance({
  courseId,
  sessionId,
  onChanged,
}: {
  courseId: string;
  sessionId: string;
  onChanged: () => void;
}) {
  const [studentId, setStudentId] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const r = await reviewApi.markPresent(courseId, sessionId, studentId, why.trim());
    setBusy(false);
    if (r.ok) {
      setMessage({
        tone: 'success',
        text: `${r.data.student.fullName} (${r.data.student.studentId}) is marked present by you.`,
      });
      setStudentId('');
      setWhy('');
      onChanged();
    } else {
      setMessage({ tone: 'danger', text: ERROR_TEXT[r.code] ?? 'Could not record attendance.' });
    }
  };

  return (
    <section className="card" aria-labelledby="manual-heading">
      <h2 id="manual-heading">Mark a student present</h2>
      <p className="muted">
        For a student who could not scan. They need an account. This is recorded as marked by you,
        with your reason.
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)} aria-label="Mark present">
        <TextField
          label="Student ID"
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          required
          autoComplete="off"
        />
        <div className="field">
          <label htmlFor="manual-why">Reason (required)</label>
          <textarea id="manual-why" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
        </div>
        {message && (
          <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
        )}
        <button
          type="submit"
          className="btn"
          disabled={busy || !studentId.trim() || why.trim().length < MIN_EXPLANATION}
        >
          Mark present
        </button>
      </form>
    </section>
  );
}
