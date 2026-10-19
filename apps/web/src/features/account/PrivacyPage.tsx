import { useState } from 'react';
import { faceApi, type FacePrivacy } from '../../api/face';
import { AppShell } from '../../components/AppShell';
import { formatDate } from '../../components/format';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Loading,
  Notice,
  PageHeader,
} from '../../components/ui';
import { useLoad } from '../../components/useLoad';
import { browserCapture, CaptureError, type CaptureFrames } from './faceCapture';
import { HOME_PATH } from '../../router';

const ID_METHOD_LABEL: Record<string, string> = {
  STUDENT_ID_CARD: 'student ID card',
  OTHER_OFFICIAL_ID: 'other official ID',
};

const FACE_OUTCOME_LABEL: Record<string, string> = {
  VERIFIED: 'Passed',
  FAILED: 'Did not match',
  LIVENESS_REJECTED: 'Not a live capture',
  EXEMPT: 'Checked in person instead',
  EXPIRED: 'Not completed in time',
  UNAVAILABLE: 'Service unavailable',
};
const FACE_OUTCOME_TONE: Record<string, 'success' | 'warning' | 'neutral'> = {
  VERIFIED: 'success',
  FAILED: 'warning',
  LIVENESS_REJECTED: 'warning',
  EXEMPT: 'neutral',
  EXPIRED: 'neutral',
  UNAVAILABLE: 'neutral',
};

/**
 * The student's own control over face verification: what they have consented to, whether they are
 * enrolled, how to complete an enrollment their lecturer started, how to withdraw (which deletes
 * their face data), and a download of everything held about them. It is theirs alone; it never shows
 * anyone else, nor any lecturer-only detail.
 */
export function PrivacyPage({ capture = browserCapture }: { capture?: CaptureFrames }) {
  const { state, reload } = useLoad(() => faceApi.privacy(), []);
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const act = async (fn: () => Promise<{ ok: boolean; code?: string }>, success: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) {
      setMessage({ tone: 'success', text: success });
      void reload();
    } else {
      setMessage({
        tone: 'danger',
        text: PROBLEMS[r.code ?? ''] ?? 'Something went wrong. Try again.',
      });
    }
  };

  const grant = () => act(() => faceApi.grantConsent(), 'Thanks — your consent is recorded.');
  const withdraw = () => {
    setConfirmWithdraw(false);
    void act(() => faceApi.withdraw(), 'Consent withdrawn. Your face data is being deleted.');
  };

  const completeCapture = async (sessionId: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    let frames: string[];
    try {
      frames = await capture();
    } catch (err) {
      setBusy(false);
      setMessage({
        tone: 'danger',
        text:
          err instanceof CaptureError
            ? (CAPTURE_PROBLEMS[err.code] ?? 'Could not use the camera. Try again.')
            : 'Could not use the camera. Try again.',
      });
      return;
    }
    const r = await faceApi.completeEnrollment(sessionId, frames);
    setBusy(false);
    if (r.ok) {
      setMessage({ tone: 'success', text: 'Your face enrollment is complete.' });
      void reload();
    } else {
      setMessage({ tone: 'danger', text: PROBLEMS[r.code] ?? 'Could not complete enrollment.' });
    }
  };

  return (
    <AppShell width="medium">
      <PageHeader
        title="Face verification & privacy"
        breadcrumbs={[
          { label: 'Home', to: HOME_PATH },
          { label: 'Account', to: '/account' },
          { label: 'Privacy' },
        ]}
        meta="What is held about you for face checks, and your control over it."
      />

      {message && (
        <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
      )}

      {state.status === 'loading' && <Loading label="Loading your privacy settings…" />}
      {(state.status === 'error' || state.status === 'not-found') && (
        <ErrorState title="Could not load your privacy settings" onRetry={() => void reload()}>
          Check your connection and try again.
        </ErrorState>
      )}

      {state.status === 'ready' && (
        <Ready
          data={state.data}
          busy={busy}
          onGrant={grant}
          onWithdraw={() => setConfirmWithdraw(true)}
          onCapture={completeCapture}
        />
      )}

      <ConfirmDialog
        open={confirmWithdraw}
        title="Withdraw consent and delete your face data?"
        confirmLabel="Withdraw and delete"
        danger
        busy={busy}
        onConfirm={withdraw}
        onCancel={() => setConfirmWithdraw(false)}
      >
        <p>
          Your face template is deleted and you will be checked in person where a face check would
          have applied. Your attendance records are not affected.
        </p>
      </ConfirmDialog>
    </AppShell>
  );
}

function Ready({
  data,
  busy,
  onGrant,
  onWithdraw,
  onCapture,
}: {
  data: FacePrivacy;
  busy: boolean;
  onGrant: () => void;
  onWithdraw: () => void;
  onCapture: (sessionId: string) => void;
}) {
  const consentCurrent =
    data.consent.state === 'GRANTED' &&
    data.consent.noticeVersion === data.consent.currentNoticeVersion;

  return (
    <>
      <Card title="Your consent">
        <p className="cluster">
          <span>Status:</span>
          {data.consent.state === 'GRANTED' ? (
            <Badge tone="success">Consent given</Badge>
          ) : data.consent.state === 'WITHDRAWN' ? (
            <Badge tone="neutral">Withdrawn</Badge>
          ) : (
            <Badge tone="warning">Not given</Badge>
          )}
        </p>
        {data.consent.at && (
          <p className="subtle">
            {data.consent.state === 'GRANTED' ? 'Agreed' : 'Last changed'} on{' '}
            {formatDate(data.consent.at)}, notice version {data.consent.noticeVersion}.
          </p>
        )}
        <p className="muted">
          Face verification is optional. It is used only to confirm it is you at check-in, as an
          alternative to being checked in person. It never changes your attendance by itself.
        </p>
        {!consentCurrent && (
          <div className="actions">
            <Button onClick={onGrant} disabled={busy}>
              {data.consent.state === 'GRANTED'
                ? 'Agree to the updated notice'
                : 'Agree to the privacy notice'}
            </Button>
          </div>
        )}
      </Card>

      {data.pendingEnrollment && consentCurrent && !data.enrollment && (
        <Card title="Finish your face enrollment">
          <p>
            Your lecturer started a face enrollment for{' '}
            <strong>
              {data.pendingEnrollment.courseCode} {data.pendingEnrollment.courseTitle}
            </strong>{' '}
            after checking your ID. Complete it on this device before{' '}
            {formatDate(data.pendingEnrollment.expiresAt)}.
          </p>
          <div className="actions">
            <Button onClick={() => onCapture(data.pendingEnrollment!.sessionId)} disabled={busy}>
              {busy ? 'Capturing…' : 'Start face capture'}
            </Button>
          </div>
        </Card>
      )}

      <Card title="Your face enrollment">
        {data.enrollment ? (
          <>
            <p>
              Enrolled on {formatDate(data.enrollment.enrolledAt)}, identity checked by{' '}
              {ID_METHOD_LABEL[data.enrollment.idMethod] ?? 'official ID'}.
            </p>
            {data.deletionPending && (
              <Notice tone="info" title="Deletion in progress">
                We are confirming the removal of your face template with the provider.
              </Notice>
            )}
            <div className="actions">
              <Button variant="danger" onClick={onWithdraw} disabled={busy}>
                Withdraw consent &amp; delete
              </Button>
            </div>
          </>
        ) : data.deletionPending ? (
          <Notice tone="info" title="Your face data is being deleted">
            We are confirming the removal with the provider. You can enroll again later.
          </Notice>
        ) : (
          <EmptyState title="You are not enrolled">
            Nothing is held. If your lecturer starts an enrollment, you will complete it here.
          </EmptyState>
        )}
      </Card>

      <Card title="Your face checks">
        {data.faceChecks.length === 0 ? (
          <EmptyState title="No face checks yet">
            When a face check happens at check-in, you will see it here, in plain terms.
          </EmptyState>
        ) : (
          <ul className="rowlist" aria-label="Face checks">
            {data.faceChecks.map((f, i) => (
              <li key={i}>
                <div className="row row--static">
                  <div className="row__main">
                    <span className="row__title">
                      {f.courseCode} · {f.sessionTitle}
                    </span>
                    <span className="row__meta">{formatDate(f.at)}</span>
                  </div>
                  <Badge tone={FACE_OUTCOME_TONE[f.outcome] ?? 'neutral'}>
                    {FACE_OUTCOME_LABEL[f.outcome] ?? f.outcome}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="When you were asked to verify in person">
        {data.inPersonReasons.length === 0 ? (
          <EmptyState title="Nothing to show">
            If a check could not confirm you and you were asked to verify in person, the reason
            appears here.
          </EmptyState>
        ) : (
          <ul className="rowlist" aria-label="In-person checks">
            {data.inPersonReasons.map((r, i) => (
              <li key={i}>
                <div className="row row--static">
                  <div className="row__main">
                    <span className="row__title">
                      {r.courseCode} · {r.sessionTitle}
                    </span>
                    <span className="row__meta">
                      {formatDate(r.at)} — a face check could not confirm you, so an in-person check
                      was asked for.
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Download your data"
        description="Everything ScanIn holds about you for face verification, as a file. It contains no image or template."
      >
        <div className="actions">
          {/* A real file download, so a plain link rather than an in-app navigation. */}
          <a className="btn btn--secondary" href={faceApi.exportHref} download>
            Download my face data
          </a>
        </div>
      </Card>
    </>
  );
}

const PROBLEMS: Record<string, string> = {
  CONSENT_REQUIRED: 'Agree to the current privacy notice first.',
  NOT_CONFIGURED: 'Face verification is not available right now.',
  VERIFIER_UNAVAILABLE: 'The face service is unavailable. Try again shortly.',
  NOT_FOUND: 'That enrollment is no longer open. Ask your lecturer to start it again.',
  RATE_LIMITED: 'Too many attempts just now. Wait a moment and try again.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
};
const CAPTURE_PROBLEMS: Record<string, string> = {
  NO_CAMERA: 'No camera is available on this device.',
  DENIED: 'Camera access was blocked. Allow the camera and try again.',
  FAILED: 'Could not capture from the camera. Try again.',
};
