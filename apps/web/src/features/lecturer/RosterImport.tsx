import { useState } from 'react';
import { lecturerApi, type RosterPreview } from '../../api/lecturer';
import { Button, Notice } from '../../components/ui';
import { fileToCsv, normalizeDelimited, type FileProblem } from './rosterFile';

const PROBLEMS: Record<string, string> = {
  INVALID_ROSTER:
    'The file could not be used. Check the columns (student_id, full_name, optional email) and every row.',
  STALE_PREVIEW: 'The class list changed since this preview. Preview the file again.',
  ROSTER_CONFLICT: 'A row clashes with an existing entry (same student ID or e-mail).',
  NETWORK: 'Could not reach the server. Try again.',
};

const FILE_PROBLEMS: Record<FileProblem, string> = {
  TOO_BIG: 'That file is too large (5 MB at most). Remove unused rows or sheets and try again.',
  UNSUPPORTED_EXCEL_OLD:
    'That is an old Excel file (.xls). Open it and choose File, Save As, Excel Workbook (.xlsx) or CSV, then upload that.',
  UNSUPPORTED:
    'That file type cannot be read. Open it in your spreadsheet app and save or download it as Excel (.xlsx) or CSV.',
  UNREADABLE:
    'That file could not be read. Save it again as Excel (.xlsx) or CSV, or copy the cells and paste them below.',
  EMPTY: 'That file is empty.',
  TOO_MANY_ROWS: 'That sheet has too many rows (20,000 at most). Split it and import in parts.',
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
  const [fileNote, setFileNote] = useState<string | null>(null);

  const chooseFile = async (file: File) => {
    setMessage(null);
    setFileNote(null);
    setPreview(null);
    const converted = await fileToCsv(file);
    if (converted.ok) {
      setCsv(converted.csv);
      setFileNote(`${file.name}: ${converted.note} Check the rows below, then preview.`);
    } else {
      setMessage({ tone: 'danger', text: FILE_PROBLEMS[converted.code] });
    }
  };

  const runPreview = async () => {
    setBusy(true);
    setMessage(null);
    // Cells pasted from Excel or Google Sheets are tab-separated; make them comma-separated first.
    // The same text is then sent for the preview and the apply, so the two always agree.
    const text = normalizeDelimited(csv);
    if (text !== csv) setCsv(text);
    const r = await lecturerApi.rosterPreview(courseId, text);
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
        Upload an Excel (.xlsx) or CSV file, or paste rows copied from Excel or Google Sheets. It
        needs student_id and full_name columns in the first row (e-mail optional). You see the
        changes before anything is applied, and existing entries are never overwritten.
      </p>
      <div className="field">
        <label htmlFor="roster-file">Spreadsheet or CSV file</label>
        <input
          id="roster-file"
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void chooseFile(file);
          }}
        />
        <span className="hint">Excel (.xlsx), CSV, or tab- or semicolon-separated text.</span>
      </div>
      {fileNote && <p role="status">{fileNote}</p>}
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
