import { useState } from 'react';
import { lecturerApi, type RosterPreview } from '../../api/lecturer';
import { Button, Notice } from '../../components/ui';

const PROBLEMS: Record<string, string> = {
  INVALID_ROSTER:
    'The file could not be used. Check the columns (student_id, full_name, optional email) and every row.',
  STALE_PREVIEW: 'The class list changed since this preview. Preview the file again.',
  ROSTER_CONFLICT: 'A row clashes with an existing entry (same student ID or e-mail).',
  NETWORK: 'Could not reach the server. Try again.',
};

/** Paste or upload a class list, see exactly what would change, then apply. Nothing is overwritten. */
export function RosterImport({
  courseId,
  onApplied,
}: {
  courseId: string;
  onApplied?: () => void;
}) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<RosterPreview | null>(null);
  const [retire, setRetire] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const runPreview = async () => {
    setBusy(true);
    setMessage(null);
    const r = await lecturerApi.rosterPreview(courseId, csv);
    setBusy(false);
    if (r.ok) {
      setPreview(r.data);
      setRetire(new Set());
    } else {
      setPreview(null);
      setMessage({ tone: 'danger', text: PROBLEMS[r.code] ?? 'Could not read that file.' });
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    const r = await lecturerApi.rosterApply(courseId, csv, preview.previewToken, [...retire]);
    setBusy(false);
    if (r.ok) {
      setMessage({
        tone: 'success',
        text: r.data.noChanges
          ? 'Nothing to change.'
          : `Class list updated: ${r.data.added} added, ${r.data.changed} changed, ${r.data.retired} removed.`,
      });
      setPreview(null);
      setCsv('');
      onApplied?.();
    } else {
      setMessage({ tone: 'danger', text: PROBLEMS[r.code] ?? 'Could not apply the class list.' });
    }
  };

  const toggle = (id: string) =>
    setRetire((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="card" aria-labelledby="roster-heading">
      <h2 id="roster-heading">Class list (roster)</h2>
      <p className="muted">
        Upload a CSV with student_id and full_name columns (e-mail optional). You see the changes
        before anything is applied, and existing entries are never overwritten.
      </p>
      <div className="field">
        <label htmlFor="roster-file">CSV file</label>
        <input
          id="roster-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void file.text().then(setCsv);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="roster-text">Or paste the CSV</label>
        <textarea id="roster-text" rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} />
      </div>
      <Button onClick={() => void runPreview()} disabled={busy || !csv.trim()}>
        Preview changes
      </Button>

      {message && (
        <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
      )}

      {preview && (
        <div className="stack">
          <h3>Changes to apply</h3>
          <p>
            {preview.counts.added} to add · {preview.counts.changed} to change ·{' '}
            {preview.counts.unchanged} unchanged · {preview.counts.missing} not in this file
          </p>
          {preview.changed.length > 0 && (
            <ul>
              {preview.changed.map((c) => (
                <li key={c.entryId}>
                  {c.studentId}: {c.before.fullName} → {c.after.fullName}
                </li>
              ))}
            </ul>
          )}
          {preview.missing.length > 0 && (
            <fieldset>
              <legend>Not in this file: tick any to remove from the class list</legend>
              {preview.missing.map((m) => (
                <label key={m.entryId} className="check">
                  <input
                    type="checkbox"
                    checked={retire.has(m.entryId)}
                    onChange={() => toggle(m.entryId)}
                  />
                  {m.studentId} {m.fullName}
                  {m.heldBy ? ' (has a linked account; they will need review)' : ''}
                </label>
              ))}
            </fieldset>
          )}
          <Button onClick={() => void apply()} disabled={busy}>
            Apply changes
          </Button>
        </div>
      )}
    </section>
  );
}
