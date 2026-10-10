import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Notice } from '../../components/ui';
import { extractToken, submitCheckIn, type CheckInOutcome } from './checkin';
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
  } catch {
    // Storage can be unavailable (private mode); the link still works when already signed in.
  }
}

/**
 * A code opened from the phone's own camera app arrives in the URL fragment. Keep it for the
 * check-in screen (it survives a sign-in or reload in this tab) and erase it from the address bar.
 */
export function capturePendingToken(): void {
  const token = extractToken(window.location.hash);
  if (token) {
    storePending(token);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

export function CheckInScreen({ onFinished }: { onFinished?: () => void } = {}) {
  const [view, setView] = useState<View>({ kind: 'ready' });
  // One id per student action; reused for automatic/manual retries of the same scan.
  const attempt = useRef<{ id: string; token: string } | null>(null);
  const inFlight = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const submit = useCallback(async (token: string, reuse: boolean) => {
    if (inFlight.current) return; // a camera can decode the same code many times a second
    inFlight.current = true;
    if (!reuse || !attempt.current || attempt.current.token !== token) {
      attempt.current = { id: crypto.randomUUID(), token };
    }
    setView({ kind: 'submitting' });
    const outcome = await submitCheckIn(token, attempt.current.id);
    inFlight.current = false;
    if (outcome.kind === 'signed-out')
      storePending(token); // resumes after sign-in
    else if (outcome.kind !== 'retryable') {
      storePending(null);
      attempt.current = null;
    }
    setView({ kind: 'result', outcome });
    if (outcome.kind === 'recorded' || outcome.kind === 'already') onFinishedRef.current?.();
  }, []);

  // A code that arrived via the phone's camera app (or survived a sign-in).
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
          <Scanner
            onDecode={onDecode}
            onProblem={(problem) => setView({ kind: 'camera', problem })}
          />
          <p role="status" className="muted">
            Hold your phone steady so the whole code is in view.
          </p>
          <Button variant="secondary" onClick={() => setView({ kind: 'ready' })}>
            Cancel
          </Button>
        </section>
      );

    case 'submitting':
      return (
        <section className="card" aria-busy="true">
          <p role="status">Checking you in…</p>
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
            <Button variant="secondary" onClick={() => setView({ kind: 'ready' })}>
              Back
            </Button>
          </div>
        </section>
      );

    case 'result':
      return (
        <Result
          outcome={view.outcome}
          onScanAgain={start}
          onRetry={retry}
          onDone={() => setView({ kind: 'ready' })}
        />
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
            {outcome.course} · {outcome.session}
          </Notice>
          {outcome.association !== 'CONFIRMED' && (
            <p className="muted">
              Your attendance is recorded. Your lecturer may need to confirm your details against
              the class list.
            </p>
          )}
          <Button onClick={onDone}>Done</Button>
        </section>
      );
    case 'already':
      return (
        <section className="card">
          {outcome.invalidated ? (
            <Notice tone="warning" title="Your lecturer changed this record">
              {outcome.course} · {outcome.session}. Please speak to your lecturer.
            </Notice>
          ) : (
            <Notice tone="info" title="You're already checked in">
              {outcome.course} · {outcome.session}. Nothing more to do.
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
