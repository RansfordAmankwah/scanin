import { useState } from 'react';
import { faceApi } from '../../api/face';
import { Button, Notice } from '../../components/ui';
import { browserCapture, CaptureError, type CaptureFrames } from '../account/faceCapture';
import { getDeviceId } from './deviceId';

type State =
  | { kind: 'prompt' }
  | { kind: 'working' }
  | { kind: 'outcome'; outcome: string; attemptsLeft: number }
  | { kind: 'exempt' }
  | { kind: 'error'; text: string };

const CAPTURE_PROBLEMS: Record<string, string> = {
  NO_CAMERA: 'No camera is available on this device.',
  DENIED: 'Camera access was blocked. Allow the camera and try again.',
  FAILED: 'Could not capture from the camera. Try again.',
};

/**
 * The optional face check after a check-in in a pilot course. It never changes the attendance that
 * was just recorded: whatever happens here, the student is checked in. A failed or skipped check
 * just means a lecturer may verify them in person.
 */
export function FaceCheck({
  attendanceId,
  capture = browserCapture,
}: {
  attendanceId: string;
  capture?: CaptureFrames;
}) {
  const [state, setState] = useState<State>({ kind: 'prompt' });

  const run = async () => {
    setState({ kind: 'working' });
    const ch = await faceApi.challengeCheck(attendanceId);
    if (!ch.ok) {
      setState({
        kind: 'error',
        text: 'Could not start the check. You may be verified in person.',
      });
      return;
    }
    if (ch.data.outcome === 'EXEMPT' || !ch.data.challengeId) {
      setState({ kind: 'exempt' });
      return;
    }
    let frames: string[];
    try {
      frames = await capture();
    } catch (err) {
      setState({
        kind: 'error',
        text:
          err instanceof CaptureError
            ? (CAPTURE_PROBLEMS[err.code] ?? 'Could not use the camera.')
            : 'Could not use the camera.',
      });
      return;
    }
    const sub = await faceApi.submitCheck(ch.data.challengeId, frames, getDeviceId());
    if (!sub.ok) {
      setState({ kind: 'error', text: 'Could not send the check. You may be verified in person.' });
      return;
    }
    setState({ kind: 'outcome', outcome: sub.data.outcome, attemptsLeft: sub.data.attemptsLeft });
  };

  if (state.kind === 'prompt') {
    return (
      <div className="stack">
        <p className="muted">
          This class uses a quick face check to confirm it is you. It is optional and never changes
          your attendance — you are already checked in.
        </p>
        <div className="actions">
          <Button onClick={() => void run()}>Do the face check</Button>
        </div>
      </div>
    );
  }
  if (state.kind === 'working') return <p role="status">Checking…</p>;
  if (state.kind === 'exempt') {
    return (
      <Notice tone="info" title="You'll be checked in person">
        We can't run a face check for you, so your lecturer may confirm you in person. Your
        attendance stands.
      </Notice>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="stack">
        <Notice tone="warning" title={state.text} />
        <div className="actions">
          <Button variant="secondary" onClick={() => void run()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // outcome
  if (state.outcome === 'VERIFIED') {
    return (
      <Notice tone="success" title="Face check passed">
        That's you — thank you.
      </Notice>
    );
  }
  const canRetry =
    (state.outcome === 'FAILED' ||
      state.outcome === 'LIVENESS_REJECTED' ||
      state.outcome === 'EXPIRED') &&
    state.attemptsLeft > 0;
  return (
    <div className="stack">
      <Notice tone="warning" title="Face check didn't pass">
        Your attendance still stands.{' '}
        {canRetry
          ? 'You can try again, or your lecturer may verify you in person.'
          : 'Your lecturer may verify you in person.'}
      </Notice>
      {canRetry && (
        <div className="actions">
          <Button variant="secondary" onClick={() => void run()}>
            Try the face check again
          </Button>
        </div>
      )}
    </div>
  );
}
