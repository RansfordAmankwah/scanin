import { useCallback, useEffect, useState } from 'react';
import { lecturerApi, type SessionRoster, type SessionView } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import { formatDate, plural } from '../../components/format';
import { Loading, Notice, PageHeader } from '../../components/ui';
import { useLoad } from '../../components/useLoad';
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
  const course = useLoad(() => lecturerApi.course(courseId), [courseId]);
  const code = course.state.status === 'ready' ? course.state.data.course.code : 'Course';

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

  const crumbs = [
    { label: 'Courses', to: '/' },
    { label: code, to: `/courses/${courseId}` },
  ];

  if (notFound) {
    return (
      <AppShell>
        <PageHeader title="Session not found" breadcrumbs={crumbs} />
        <Notice tone="danger" title="Session not found" urgent>
          It may not exist, or you may not be assigned to this course.
        </Notice>
      </AppShell>
    );
  }
  if (!session || !roster) {
    return (
      <AppShell>
        <PageHeader title="Session" breadcrumbs={crumbs} />
        <Loading label="Loading the session…" />
      </AppShell>
    );
  }

  const counts = roster.counts;
  const attention: Array<{ key: string; text: string; to: string }> = [];
  if (counts.reviewRequired > 0) {
    attention.push({
      key: 'match',
      text: `${plural(counts.reviewRequired, 'student')} recorded present but not matched to the class list`,
      to: `/courses/${courseId}/review`,
    });
  }
  if (counts.flaggedPresent > 0) {
    attention.push({
      key: 'flags',
      text: `${plural(counts.flaggedPresent, 'present record')} with an open flag`,
      to: '#attendance',
    });
  }

  return (
    <AppShell>
      <PageHeader
        title={session.title}
        breadcrumbs={[...crumbs, { label: session.title }]}
        meta={
          <>
            <span>{formatDate(session.sessionDate)}</span>
            <span>{plural(counts.presentTotal, 'student')} recorded present</span>
          </>
        }
      />

      <nav className="jump" aria-label="On this page">
        <a href="#controls">Controls</a>
        <a href="#headcount">Headcount</a>
        <a href="#attendance">Attendance</a>
        <a href="#spot-checks">Spot checks</a>
        <a href="#scans">Scan history</a>
        <a href="#export">Export</a>
      </nav>

      <div id="controls">
        <SessionControls
          session={session}
          onChange={(next) => {
            if (next) setSession(next);
            void load();
          }}
        />
      </div>

      <CountsPanel counts={counts} />

      {attention.length > 0 && (
        <Notice tone="warning" title="Needs your attention">
          <ul className="list">
            {attention.map((a) => (
              <li key={a.key}>
                {a.to.startsWith('#') ? (
                  <a href={a.to}>{a.text}</a>
                ) : (
                  <Link to={a.to}>{a.text}</Link>
                )}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <div id="headcount">
        <ReconciliationPanel
          courseId={courseId}
          sessionId={sessionId}
          presentTotal={counts.presentTotal}
        />
      </div>
      <div id="attendance">
        <AttendanceTable
          roster={roster}
          courseId={courseId}
          sessionId={sessionId}
          onChanged={() => void load()}
        />
      </div>
      <DisputesPanel
        courseId={courseId}
        sessionId={sessionId}
        reloadKey={reviewKey}
        onResolved={() => {
          setReviewKey((k) => k + 1);
          void load();
        }}
      />
      <div id="spot-checks">
        <SpotChecksPanel
          courseId={courseId}
          sessionId={sessionId}
          sessionState={session.state}
          onChanged={() => {
            setReviewKey((k) => k + 1);
            void load();
          }}
        />
      </div>
      {session.state !== 'NOT_STARTED' && (
        <ManualAttendance courseId={courseId} sessionId={sessionId} onChanged={() => void load()} />
      )}
      <div id="scans">
        <ScanHistory courseId={courseId} sessionId={sessionId} />
      </div>
      <div id="export">
        {session.state !== 'NOT_STARTED' && (
          <ExportPanel courseId={courseId} sessionId={sessionId} />
        )}
      </div>
    </AppShell>
  );
}
