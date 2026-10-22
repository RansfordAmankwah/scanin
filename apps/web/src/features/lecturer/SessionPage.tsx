import { useCallback, useEffect, useState } from 'react';
import { exportApi, lecturerApi, type SessionRoster, type SessionView } from '../../api/lecturer';
import { AppShell } from '../../components/AppShell';
import { formatDate, plural } from '../../components/format';
import { Button, Loading, Notice, PageHeader } from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { Link, HOME_PATH } from '../../router';
import { AttendanceTable, CountsPanel } from './AttendanceTable';
import { DisputesPanel } from './DisputesPanel';
import { ExportPanel } from './ExportPanel';
import { ManualAttendance } from './ManualAttendance';
import { ReconciliationPanel } from './ReconciliationPanel';
import { ScanHistory } from './ScanHistory';
import { SessionControls } from './SessionControls';
import { SpotChecksPanel } from './SpotChecksPanel';

const REFRESH_MS = 10_000;

const STATE_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  CHECK_IN_OPEN: 'Open',
  CHECK_IN_CLOSED: 'Closed',
  ENDED: 'Ended',
};

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2v8M4 7l4 4 4-4" />
      <path d="M2 12v2h12v-2" />
    </svg>
  );
}

function QuickExportButton({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const exportCsv = async () => {
    setBusy(true);
    const r = await exportApi.create(courseId, sessionId, 'ATTENDANCE', 'CSV');
    setBusy(false);
    if (r.ok) {
      const a = document.createElement('a');
      a.href = `/api${r.data.export.downloadPath}`;
      a.download = r.data.export.filename;
      a.click();
    }
  };
  return (
    <Button variant="secondary" size="sm" onClick={() => void exportCsv()} disabled={busy}>
      <DownloadIcon /> {busy ? 'Exporting…' : 'Export as CSV'}
    </Button>
  );
}

export function SessionPage({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [roster, setRoster] = useState<SessionRoster | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [reviewKey, setReviewKey] = useState(0);
  const [headcountEntered, setHeadcountEntered] = useState(false);
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
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const crumbs = [{ label: 'Sessions', to: HOME_PATH }];

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
  const isLive = session.state === 'CHECK_IN_OPEN';
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

  const title = `${code} · ${session.title}`;

  return (
    <AppShell>
      <PageHeader
        title={title}
        breadcrumbs={crumbs}
        meta={
          <>
            <span>{formatDate(session.sessionDate)}</span>
            <span>{STATE_LABEL[session.state] ?? session.state}</span>
            {headcountEntered && (
              <span>{plural(counts.presentTotal, 'student')} recorded present</span>
            )}
          </>
        }
        actions={
          session.state !== 'NOT_STARTED' && (
            <QuickExportButton courseId={courseId} sessionId={sessionId} />
          )
        }
      />

      <div id="controls">
        <SessionControls
          session={session}
          onChange={(next) => {
            if (next) setSession(next);
            void load();
          }}
        />
      </div>

      {isLive ? (
        <div className="session-grid">
          <div className="session-grid__left stack">
            <div id="headcount">
              <ReconciliationPanel
                courseId={courseId}
                sessionId={sessionId}
                presentTotal={counts.presentTotal}
                onHeadcountKnown={setHeadcountEntered}
              />
            </div>
          </div>

          <div className="session-grid__right stack">
            <CountsPanel counts={counts} revealTotals={headcountEntered} />
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
          </div>
        </div>
      ) : (
        <>
          <CountsPanel counts={counts} revealTotals={headcountEntered} />

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
              onHeadcountKnown={setHeadcountEntered}
            />
          </div>
        </>
      )}

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
      {session.state !== 'NOT_STARTED' && (
        <div id="export">
          <ExportPanel courseId={courseId} sessionId={sessionId} />
        </div>
      )}
    </AppShell>
  );
}
