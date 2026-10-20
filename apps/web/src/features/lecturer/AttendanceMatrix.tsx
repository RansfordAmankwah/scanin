import { useEffect, useState } from 'react';
import { courseApi, type AttendanceMatrix as Matrix } from '../../api/lecturer';
import { Button, EmptyState, ErrorState, Loading } from '../../components/ui';

function toCsv(m: Matrix): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const header = ['Name', 'ID', ...m.sessions.map((s) => s.title)].map(esc).join(',');
  const lines = m.rows.map((r) =>
    [r.fullName, r.studentId, ...r.present.map((p) => (p ? 'Present' : 'Absent'))]
      .map(esc)
      .join(','),
  );
  return [header, ...lines].join('\r\n');
}

function downloadCsv(filename: string, text: string) {
  try {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // Download not available (e.g. a restricted environment); nothing else to do.
  }
}

/** The whole course as one grid: students down the side, sessions across the top, Present/Absent. */
export function AttendanceMatrix({ courseId }: { courseId: string }) {
  const [data, setData] = useState<Matrix | null>(null);
  const [failed, setFailed] = useState(false);

  const load = () => {
    setFailed(false);
    setData(null);
    void courseApi.matrix(courseId).then((r) => (r.ok ? setData(r.data) : setFailed(true)));
  };
  useEffect(load, [courseId]);

  if (failed) {
    return (
      <ErrorState title="Could not load the grid" onRetry={load}>
        Check your connection and try again.
      </ErrorState>
    );
  }
  if (!data) return <Loading label="Loading grid…" />;
  if (data.sessions.length === 0 || data.rows.length === 0) {
    return (
      <EmptyState title="Nothing to show yet">
        The grid fills in once a session has started and students have checked in.
      </EmptyState>
    );
  }

  const filename = `attendance-${data.course.code}.csv`.replace(/[^A-Za-z0-9._-]/g, '_');

  return (
    <div className="stack">
      <div className="actions">
        <Button variant="secondary" onClick={() => downloadCsv(filename, toCsv(data))}>
          Download CSV
        </Button>
      </div>
      <p className="muted">
        Present only when a check-in was recorded for that session; invalidated records count as
        absent. Students are those who attended at least one session.
      </p>
      <div className="matrix-scroll">
        <table className="matrix" aria-label="Attendance grid">
          <thead>
            <tr>
              <th scope="col" className="matrix__name">
                Name
              </th>
              <th scope="col" className="matrix__id">
                ID
              </th>
              {data.sessions.map((s) => (
                <th key={s.id} scope="col" title={s.date}>
                  {s.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.studentId}>
                <th scope="row" className="matrix__name">
                  {r.fullName}
                </th>
                <td className="matrix__id">{r.studentId}</td>
                {r.present.map((p, i) => (
                  <td
                    key={data.sessions[i]?.id ?? i}
                    className={p ? 'matrix__present' : 'matrix__absent'}
                  >
                    <span aria-hidden="true">{p ? '✓' : '·'}</span>
                    <span className="visually-hidden">{p ? 'Present' : 'Absent'}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
