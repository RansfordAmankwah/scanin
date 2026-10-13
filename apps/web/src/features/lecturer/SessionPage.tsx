import { useCallback, useEffect, useState } from 'react';
import { lecturerApi, type SessionRoster, type SessionView } from '../../api/lecturer';
import { Notice } from '../../components/ui';
import { Link } from '../../router';
import { AttendanceTable, CountsPanel } from './AttendanceTable';
import { DisputesPanel } from './DisputesPanel';
import { ExportPanel } from './ExportPanel';
import { ManualAttendance } from './ManualAttendance';
import { ReconciliationPanel } from './ReconciliationPanel';
import { ScanHistory } from './ScanHistory';
import { SessionControls } from './SessionControls';
import { SpotChecksPanel } from './SpotChecksPanel';

const REFRESH_MS = 10_000;

export function SessionPage({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [roster, setRoster] = useState<SessionRoster | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Bumped when a spot check or review changes, so the other panels reload.
  const [reviewKey, setReviewKey] = useState(0);

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([
      lecturerApi.session(courseId, sessionId),
      lecturerApi.attendance(courseId, sessionId),
    ]);
    if (!s.ok) {
      if (s.status === 404) setNotFound(true);
      return;
    }
    setSession(s.data.session);
    if (a.ok) setRoster(a.data);
  }, [courseId, sessionId]);

  useEffect(() => {
    void load();
    // Keep the live view fresh while students check in.
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (notFound) {
    return (
      <Notice tone="danger" title="Session not found" urgent>
        It may not exist, or you may not be assigned to this course.
      </Notice>
    );
  }
  if (!session || !roster) return <p role="status">Loading…</p>;

  return (
    <div className="stack">
      <p>
        <Link to={`/courses/${courseId}`} className="back-link">
          ← Back to course
        </Link>
      </p>
      <h2>
        {session.title} <span className="muted">{session.sessionDate}</span>
      </h2>
      <SessionControls
        session={session}
        onChange={(next) => {
          if (next) setSession(next);
          void load();
        }}
      />
      <CountsPanel counts={roster.counts} />
      <ReconciliationPanel
        courseId={courseId}
        sessionId={sessionId}
        presentTotal={roster.counts.presentTotal}
      />
      <AttendanceTable
        roster={roster}
        courseId={courseId}
        sessionId={sessionId}
        onChanged={() => void load()}
      />
      <DisputesPanel
        courseId={courseId}
        sessionId={sessionId}
        reloadKey={reviewKey}
        onResolved={() => {
          setReviewKey((k) => k + 1);
          void load();
        }}
      />
      <SpotChecksPanel
        courseId={courseId}
        sessionId={sessionId}
        sessionState={session.state}
        onChanged={() => {
          setReviewKey((k) => k + 1);
          void load();
        }}
      />
      {session.state !== 'NOT_STARTED' && (
        <ManualAttendance courseId={courseId} sessionId={sessionId} onChanged={() => void load()} />
      )}
      <ScanHistory courseId={courseId} sessionId={sessionId} />
      {session.state !== 'NOT_STARTED' && <ExportPanel courseId={courseId} sessionId={sessionId} />}
    </div>
  );
}
