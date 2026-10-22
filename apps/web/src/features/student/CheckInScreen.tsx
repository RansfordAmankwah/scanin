import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Notice } from '../../components/ui';
import { extractToken, submitCheckIn, type CheckInOutcome } from './checkin';
import { FaceCheck } from './FaceCheck';
import { Scanner, type CameraProblem } from './Scanner';

const PENDING_KEY = 'scanin.pendingToken';

type View =
  | { kind: 'ready' }
  | { kind: 'scanning' }
  | { kind: 'submitting' }
  | { kind: 'camera'; problem: CameraProblem }
  | { kind: 'result'; outcome: CheckInOutcome };

function readPending(): string | null {
  try {
    return sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}
function storePending(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(PENDING_KEY, token);
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {}
}

export function capturePendingToken(): void {
  const token = extractToken(window.location.hash);
  if (token) {
    storePending(token);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

function CheckIconLg() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L19 7" />
    </svg>
  );
}

function ClockIconLg() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function AlertIconLg() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

function WifiOffIconLg() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 1l22 22" />
      <path d="M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0122.56 9M1.42 9a15.91 15.91 0 014.7-2.88" />
      <path d="M8.53 16.11a6 6 0 016.95 0" />
      <circle cx="12" cy="20" r="1" />
    </svg>
  );
}

function BackArrow() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 10H5M5 10l5-5M5 10l5 5" />
    </svg>
  );
}

interface ResultPageProps {
  icon: ReactNode;
  iconTone: 'success' | 'warning' | 'danger' | 'info';
  title: string;
  body?: ReactNode;
  details?: Array<{ label: string; value: ReactNode }>;
  hint?: string;
  children: ReactNode;
  onClose: () => void;
}

function ResultPage({ icon, iconTone, title, body, details, hint, children, onClose }: ResultPageProps) {
  return (
    <div className="checkin-result">
      <button type="button" className="checkin-result__close" onClick={onClose} aria-label="Close">
        <CloseIcon />
      </button>
      <div className={`checkin-result__icon checkin-result__icon--${iconTone}`}>{icon}</div>
      <h1>{title}</h1>
      {body && <div className="checkin-result__body">{body}</div>}
      {details && details.length > 0 && (
        <div className="checkin-result__details">
          {details.map((d) => (
            <div key={d.label} className="checkin-result__detail-row">
              <span className="checkin-result__detail-label">{d.label}</span>
              <span className="checkin-result__detail-value">{d.value}</span>
            </div>
          ))}
        </div>
      )}
      {hint && <div className="checkin-result__hint">{hint}</div>}
      <div className="checkin-result__actions">{children}</div>
    </div>
  );
}

export function CheckInScreen({ onFinished }: { onFinished?: () => void } = {}) {
  const [view, setView] = useState<View>({ kind: 'ready' });
  const attempt = useRef<{ id: string; token: string } | null>(null);
  const inFlight = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const submit = useCallback(async (token: string, reuse: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!reuse || !attempt.current || attempt.current.token !== token) {
      attempt.current = { id: crypto.randomUUID(), token };
    }
    setView({ kind: 'submitting' });
    const outcome = await submitCheckIn(token, attempt.current.id);
    inFlight.current = false;
    if (outcome.kind === 'signed-out')
      storePending(token);
    else if (outcome.kind !== 'retryable') {
      storePending(null);
      attempt.current = null;
    }
    setView({ kind: 'result', outcome });
    if (outcome.kind === 'recorded' || outcome.kind === 'already') onFinishedRef.current?.();
  }, []);

  useEffect(() => {
    const token = readPending();
    if (token) void submit(token, false);
  }, [submit]);

  const onDecode = useCallback(
    (text: string) => {
      const token = extractToken(text);
      if (!token) {
        setView({ kind: 'result', outcome: { kind: 'invalid' } });
        return;
      }
      void submit(token, false);
    },
    [submit],
  );

  const start = () => setView({ kind: 'scanning' });
  const retry = () => {
    if (attempt.current) void submit(attempt.current.token, true);
    else start();
  };
  const done = () => setView({ kind: 'ready' });

  switch (view.kind) {
    case 'ready':
      return (
        <section className="card" aria-labelledby="scan-heading">
          <h2 id="scan-heading">Check in to class</h2>
          <p>Point your camera at the QR code on the lecturer's screen.</p>
          <Button onClick={start}>Start camera</Button>
          <p className="muted">
            You can also scan the code with your phone's normal camera app and open the link.
          </p>
        </section>
      );

    case 'scanning':
      return (
        <section className="card" aria-labelledby="scan-heading">
          <h2 id="scan-heading">Scan the class QR code</h2>
          <div className="scan-screen__viewfinder">
            <span className="scan-screen__corner scan-screen__corner--tl" />
            <span className="scan-screen__corner scan-screen__corner--tr" />
            <span className="scan-screen__corner scan-screen__corner--bl" />
            <span className="scan-screen__corner scan-screen__corner--br" />
            <Scanner
              onDecode={onDecode}
              onProblem={(problem) => setView({ kind: 'camera', problem })}
            />
          </div>
          <p role="status" className="muted">
            Hold your phone steady so the whole code is in view.
          </p>
          <Button variant="secondary" onClick={done}>
            Cancel
          </Button>
        </section>
      );

    case 'submitting':
      return (
        <section className="card" aria-busy="true">
          <p role="status">Checking you in&hellip;</p>
        </section>
      );

    case 'camera':
      return (
        <section className="card">
          {view.problem === 'denied' ? (
            <Notice tone="warning" title="Camera access is blocked" urgent>
              Allow camera access for this site in your browser settings, then try again. Or scan
              the code with your phone's normal camera app and open the link it shows.
            </Notice>
          ) : (
            <Notice tone="warning" title="No camera available" urgent>
              We could not start a camera. Scan the code with your phone's normal camera app and
              open the link it shows, or ask your lecturer to record your attendance.
            </Notice>
          )}
          <div className="actions">
            <Button onClick={start}>Try again</Button>
            <Button variant="secondary" onClick={done}>
              Back
            </Button>
          </div>
        </section>
      );

    case 'result':
      return (
        <Result outcome={view.outcome} onScanAgain={start} onRetry={retry} onDone={done} />
      );
  }
}

function Result({
  outcome,
  onScanAgain,
  onRetry,
  onDone,
}: {
  outcome: CheckInOutcome;
  onScanAgain: () => void;
  onRetry: () => void;
  onDone: () => void;
}) {
  const again = <Button onClick={onScanAgain}>Scan again</Button>;

  switch (outcome.kind) {
    case 'recorded':
      return (
        <section className="card">
          <Notice tone="success" title="You're checked in">
            {outcome.course} &middot; {outcome.session}
          </Notice>
          {outcome.association !== 'CONFIRMED' && (
            <p className="muted">
              Your attendance is recorded. Your lecturer may need to confirm your details against
              the class list.
            </p>
          )}
          {outcome.faceCheck && <FaceCheck attendanceId={outcome.faceCheck.attendanceId} />}
          <Button onClick={onDone}>Done</Button>
        </section>
      );
    case 'already':
      return (
        <section className="card">
          {outcome.invalidated ? (
            <Notice tone="warning" title="Your lecturer changed this record">
              {outcome.course} &middot; {outcome.session}. Please speak to your lecturer.
            </Notice>
          ) : (
            <Notice tone="info" title="You're already checked in">
              {outcome.course} &middot; {outcome.session}. Nothing more to do.
            </Notice>
          )}
          <Button onClick={onDone}>Done</Button>
        </section>
      );
    case 'expired':
      return (
        <section className="card">
          <Notice tone="warning" title="That code has expired" urgent>
            Scan the code that is on the screen right now.
          </Notice>
          {again}
        </section>
      );
    case 'revoked':
      return (
        <section className="card">
          <Notice tone="warning" title="That code was cancelled" urgent>
            Your lecturer replaced it. Scan the code that is on the screen right now.
          </Notice>
          {again}
        </section>
      );
    case 'not-started':
      return (
        <section className="card">
          <Notice tone="info" title="Check-in hasn't started yet">
            Wait for your lecturer to start check-in, then scan again.
          </Notice>
          {again}
        </section>
      );
    case 'closed':
      return (
        <section className="card">
          <Notice tone="danger" title="Check-in is closed" urgent>
            The check-in window for this class has ended. Speak to your lecturer if you were
            present.
          </Notice>
          <Button variant="secondary" onClick={onDone}>
            Back
          </Button>
        </section>
      );
    case 'ended':
      return (
        <section className="card">
          <Notice tone="danger" title="This class has ended" urgent>
            Speak to your lecturer if you were present.
          </Notice>
          <Button variant="secondary" onClick={onDone}>
            Back
          </Button>
        </section>
      );
    case 'invalid':
      return (
        <section className="card">
          <Notice tone="danger" title="That isn't a ScanIn check-in code" urgent>
            Make sure you're scanning the QR code shown by your lecturer.
          </Notice>
          {again}
        </section>
      );
    case 'rate-limited':
      return (
        <section className="card">
          <Notice tone="warning" title="Too many attempts" urgent>
            Wait about {outcome.retryAfterSeconds} seconds, then try again.
          </Notice>
          {again}
        </section>
      );
    case 'signed-out':
      return (
        <section className="card">
          <Notice tone="warning" title="Please sign in again" urgent>
            Your session ended. Sign in, and your check-in will continue.
          </Notice>
          <Button onClick={() => window.location.reload()}>Sign in</Button>
        </section>
      );
    case 'retryable':
      return (
        <section className="card">
          <Notice tone="warning" title="Couldn't reach the server" urgent>
            Your check-in may not be recorded yet. Check your connection and try again; trying again
            is safe.
          </Notice>
          <Button onClick={onRetry}>Try again</Button>
        </section>
      );
    case 'device-used':
      return (
        <section className="card">
          <Notice tone="danger" title="Device error" urgent>
            This device was already used by another student for this session. Use your own phone, or
            tell your lecturer.
          </Notice>
          <Button onClick={onDone}>Done</Button>
        </section>
      );
    case 'reload-needed':
      return (
        <section className="card">
          <Notice tone="warning" title="Reload ScanIn to finish checking in" urgent>
            This copy of ScanIn is out of date. Reload it, then scan the code again.
          </Notice>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </section>
      );
    case 'error':
      return (
        <section className="card">
          <Notice tone="danger" title="Something went wrong" urgent>
            Please try again, or tell your lecturer.
          </Notice>
          {again}
        </section>
      );
  }
}
