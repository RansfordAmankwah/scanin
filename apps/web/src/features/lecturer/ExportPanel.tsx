import { useState } from 'react';
import { exportApi, type ExportSummary } from '../../api/lecturer';
import { Notice } from '../../components/ui';

const KINDS = [
  { value: 'ATTENDANCE', label: 'Attendance report (no scan times)' },
  { value: 'SCAN_HISTORY', label: 'Scan history (includes every scan time)' },
] as const;
const FORMATS = [
  { value: 'CSV', label: 'CSV (spreadsheet-friendly text)' },
  { value: 'XLSX', label: 'Excel (.xlsx)' },
  { value: 'PDF', label: 'PDF' },
  { value: 'DOCX', label: 'Word (.docx)' },
] as const;

const PROBLEMS: Record<string, string> = {
  RATE_LIMITED: 'Too many exports in a short time. Wait a moment and try again.',
  NOT_FOUND: 'That session could not be found.',
  NETWORK: 'Could not reach the server. Try again.',
};

/** Create a report file. It is generated from one consistent snapshot and expires shortly after. */
export function ExportPanel({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('ATTENDANCE');
  const [format, setFormat] = useState<(typeof FORMATS)[number]['value']>('CSV');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const r = await exportApi.create(courseId, sessionId, kind, format);
    setBusy(false);
    if (r.ok) setResult(r.data.export);
    else setError(PROBLEMS[r.code] ?? 'Could not create the export.');
  };

  const minutes = result
    ? Math.max(1, Math.round((Date.parse(result.expiresAt) - Date.now()) / 60_000))
    : 0;

  return (
    <section className="card" aria-labelledby="export-heading">
      <h2 id="export-heading">Export</h2>
      <form className="stack" onSubmit={(e) => void create(e)} aria-label="Create export">
        <div className="field">
          <label htmlFor="export-kind">Report</label>
          <select
            id="export-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="export-format">Format</label>
          <select
            id="export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as typeof format)}
          >
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Creating…' : 'Create export'}
        </button>
      </form>
      {error && <Notice tone="danger" title={error} urgent />}
      {result && (
        <Notice tone="success" title="Your export is ready">
          <p>
            <a href={`/api${result.downloadPath}`} download={result.filename}>
              Download {result.filename}
            </a>
          </p>
          <p>
            {result.rowCount} row(s). The file is removed in about {minutes} minute(s); create it
            again if you need it later.
          </p>
        </Notice>
      )}
      <p className="muted">
        Names and IDs are self-reported. Reports show counts for confirmed, provisional and
        needs-review attendance separately, and never include your written explanations.
      </p>
    </section>
  );
}
