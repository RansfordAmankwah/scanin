import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/client';
import { ConfirmDialog } from '../../components/ui';
import { Link } from '../../router';

interface MintResponse {
  qrUrl: string;
  issuedAt: string;
  expiresAt: string;
  refreshAfterSeconds: number;
  checkInDeadline: string;
}

interface ErrorResponse {
  error?: { code?: string; state?: string };
}

type Status =
  | { kind: 'loading' }
  | { kind: 'showing' }
  | { kind: 'reconnecting' }
  | { kind: 'closed'; state: string }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string };

const RETRY_AFTER_NETWORK_ERROR_MS = 5_000;

/**
 * Full-screen QR display for the room projector. Fetches a fresh signed code about every 30 s.
 * Codes stay valid for three minutes, so a brief network drop does not blank the screen; the
 * previous code keeps showing (with a notice) until it actually expires.
 */
export function QrDisplay({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [image, setImage] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelled = useRef(false);
  const [confirming, setConfirming] = useState(false);

  const base = `/courses/${courseId}/sessions/${sessionId}`;

  const refresh = useCallback(async () => {
    if (cancelled.current) return;
    clearTimeout(timer.current);
    let nextMs = RETRY_AFTER_NETWORK_ERROR_MS;
    try {
      const res = await apiFetch<MintResponse & ErrorResponse>(`${base}/qr`);
      if (cancelled.current) return;
      if (res.ok && res.data && 'qrUrl' in res.data) {
        const dataUrl = await QRCode.toDataURL(res.data.qrUrl, {
          errorCorrectionLevel: 'M',
          margin: 4, // the quiet zone scanners need
          width: 1024,
        });
        if (cancelled.current) return;
        setImage(dataUrl);
        expiresAt.current = Date.parse(res.data.expiresAt);
        setDeadline(Date.parse(res.data.checkInDeadline));
        setStatus({ kind: 'showing' });
        nextMs = res.data.refreshAfterSeconds * 1000;
      } else if (res.status === 409) {
        setImage(null);
        setStatus({ kind: 'closed', state: res.data?.error?.state ?? 'CHECK_IN_CLOSED' });
        return; // nothing more to fetch
      } else if (res.status === 401) {
        setImage(null);
        setStatus({ kind: 'signed-out' });
        return;
      } else if (res.status === 429) {
        nextMs = (res.retryAfterSeconds ?? 10) * 1000;
        setStatus((s) => (s.kind === 'showing' ? s : { kind: 'reconnecting' }));
      } else {
        setStatus({ kind: 'error', message: 'Could not load the code.' });
      }
    } catch {
      if (cancelled.current) return;
      setStatus((s) =>
        s.kind === 'showing' ? { kind: 'reconnecting' } : { kind: 'reconnecting' },
      );
    }
    timer.current = setTimeout(() => void refresh(), nextMs);
  }, [base]);

  useEffect(() => {
    cancelled.current = false;
    void refresh();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled.current = true;
      clearTimeout(timer.current);
      clearInterval(tick);
    };
  }, [refresh]);

  const invalidate = async () => {
    setConfirming(false);
    await apiFetch(`${base}/qr/invalidate`, { method: 'POST', body: {} });
    await refresh();
  };

  // A code that has expired must not be shown, even if we could not fetch a replacement.
  const codeExpired = expiresAt.current > 0 && now >= expiresAt.current;
  const showImage =
    image !== null && !codeExpired && (status.kind === 'showing' || status.kind === 'reconnecting');
  const secondsLeft = deadline === null ? null : Math.max(0, Math.floor((deadline - now) / 1000));

  return (
    <main className="present">
      <h1 className="visually-hidden">Class check-in code</h1>
      <div role="status" aria-live="polite" className="present__message">
        {status.kind === 'loading' && 'Loading code…'}
        {status.kind === 'reconnecting' &&
          'Reconnecting… the code on screen is still valid for a short time.'}
        {status.kind === 'closed' && 'Check-in is closed for this session.'}
        {status.kind === 'signed-out' && 'Please sign in to show the code.'}
        {status.kind === 'error' && status.message}
        {status.kind === 'showing' && 'Scan to check in'}
      </div>

      {showImage && (
        <img src={image} alt="QR code for checking in to this class" className="present__qr" />
      )}

      {secondsLeft !== null && status.kind !== 'closed' && (
        <p className="present__timer">
          Check-in closes in {Math.floor(secondsLeft / 60)}:
          {String(secondsLeft % 60).padStart(2, '0')}
        </p>
      )}

      {status.kind !== 'closed' && status.kind !== 'signed-out' && (
        <button type="button" onClick={() => setConfirming(true)} className="present__button">
          Invalidate shown codes
        </button>
      )}
      <Link to={`/courses/${courseId}/sessions/${sessionId}`} className="present__button">
        Back to the session
      </Link>
      <ConfirmDialog
        open={confirming}
        title="Invalidate the codes on screen?"
        confirmLabel="Invalidate codes"
        onConfirm={() => void invalidate()}
        onCancel={() => setConfirming(false)}
      >
        <p>Students must scan the new code that appears. Check-in stays open.</p>
      </ConfirmDialog>
    </main>
  );
}
