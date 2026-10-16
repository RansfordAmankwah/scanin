import { useState } from 'react';
import { changePassword } from '../../api/auth';
import { AppShell } from '../../components/AppShell';
import {
  Badge,
  Button,
  Card,
  LinkButton,
  Notice,
  PageHeader,
  TextField,
} from '../../components/ui';
import { useAuth } from '../auth/AuthGate';

const PROBLEMS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Your current password is incorrect.',
  PASSWORD_TOO_SHORT: 'Choose a password of at least 10 characters.',
  PASSWORD_TOO_LONG: 'That password is too long (128 characters at most).',
  INVALID_REQUEST: 'Check both fields and try again.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
};

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await changePassword(current, next);
    setBusy(false);
    if (r.ok) {
      setCurrent('');
      setNext('');
      setMessage({
        tone: 'success',
        text: 'Password changed. You were signed out everywhere else.',
      });
    } else {
      setMessage({ tone: 'danger', text: PROBLEMS[r.code] ?? 'Could not change the password.' });
    }
  };

  return (
    <Card title="Change password" description="Changing it signs you out on every other device.">
      <form className="stack" onSubmit={(e) => void submit(e)} aria-label="Change password">
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        {message && (
          <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
        )}
        <div className="actions">
          <button type="submit" className="btn" disabled={busy || !current || !next}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </Card>
  );
}

/** Your details, as ScanIn holds them, and the few things you can change yourself. */
export function AccountPage() {
  const { user, signOut } = useAuth();
  return (
    <AppShell width="medium">
      <PageHeader
        title="Account"
        breadcrumbs={[{ label: 'Home', to: '/' }, { label: 'Account' }]}
      />

      <Card title="Your details">
        <dl className="stack stack--tight">
          <div>
            <dt className="subtle">Name</dt>
            <dd>{user.fullName}</dd>
          </div>
          <div>
            <dt className="subtle">E-mail</dt>
            <dd className="cluster">
              <span>{user.email}</span>
              {user.emailVerified ? (
                <Badge tone="success">Verified</Badge>
              ) : (
                <Badge tone="warning">Not verified</Badge>
              )}
            </dd>
          </div>
          {user.studentId && (
            <div>
              <dt className="subtle">Student ID</dt>
              <dd>{user.studentId}</dd>
            </div>
          )}
          <div>
            <dt className="subtle">Account type</dt>
            <dd>{user.role === 'STUDENT' ? 'Student' : 'Lecturer'}</dd>
          </div>
        </dl>
        {user.role === 'STUDENT' && (
          <p className="subtle">
            Your name and student ID were confirmed when you signed up and cannot be changed here.
            If either is wrong, tell your lecturer.
          </p>
        )}
        {!user.emailVerified && (
          <Notice tone="info" title="Your e-mail is not verified yet">
            Open the link in the message we sent to {user.email}. You can still check in meanwhile.
          </Notice>
        )}
      </Card>

      <ChangePassword />

      {user.role === 'STUDENT' && (
        <Card
          title="Face verification & privacy"
          description="See what is held for face checks, complete or withdraw an enrollment, and download your data."
        >
          <div className="actions">
            <LinkButton to="/account/privacy" variant="secondary">
              Open privacy settings
            </LinkButton>
          </div>
        </Card>
      )}

      <Card title="Sign out">
        <div className="actions">
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </Card>
    </AppShell>
  );
}
