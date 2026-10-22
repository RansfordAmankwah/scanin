import { useState } from 'react';
import { changeEmail, changePassword, deleteAccount, resendVerification } from '../../api/auth';
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
import { HOME_PATH } from '../../router';

const PROBLEMS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Your current password is incorrect.',
  PASSWORD_TOO_SHORT: 'Choose a password of at least 10 characters.',
  PASSWORD_TOO_LONG: 'That password is too long (128 characters at most).',
  INVALID_REQUEST: 'Check both fields and try again.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
};

function ResendVerification({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await resendVerification();
    setBusy(false);
    if (r.ok) {
      setMessage({
        tone: 'success',
        text:
          r.status === 'already_verified'
            ? 'Your e-mail is already verified — refresh the page.'
            : `Sent. Open the link we just e-mailed to ${email}.`,
      });
    } else {
      setMessage({
        tone: 'danger',
        text: PROBLEMS[r.code] ?? 'Could not send the e-mail. Try again.',
      });
    }
  };

  return (
    <>
      <Notice tone="info" title="Your e-mail is not verified yet">
        Open the link in the message we sent to {email}. You can still check in meanwhile.
      </Notice>
      <div className="actions">
        <Button variant="secondary" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Sending…' : 'Resend verification e-mail'}
        </Button>
      </div>
      {message && (
        <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
      )}
    </>
  );
}

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

const EMAIL_PROBLEMS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Your password is incorrect.',
  EMAIL_TAKEN: 'That e-mail address is already in use.',
  EMAIL_UNCHANGED: 'That is already your e-mail address.',
  INVALID_REQUEST: 'Enter a valid e-mail address.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
};

function ChangeEmail() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const r = await changeEmail(email, password);
    setBusy(false);
    if (r.ok) {
      setEmail('');
      setPassword('');
      setMessage({
        tone: 'success',
        text: `We sent a link to ${r.email}. Open it to confirm the new address; until then your e-mail shows as not verified.`,
      });
    } else {
      setMessage({
        tone: 'danger',
        text: EMAIL_PROBLEMS[r.code] ?? 'Could not change the e-mail.',
      });
    }
  };

  return (
    <Card title="Change e-mail" description="You will need to confirm the new address from a link.">
      <form className="stack" onSubmit={(e) => void submit(e)} aria-label="Change e-mail">
        <TextField
          label="New e-mail"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <TextField
          label="Your password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {message && (
          <Notice tone={message.tone} title={message.text} urgent={message.tone === 'danger'} />
        )}
        <div className="actions">
          <button type="submit" className="btn" disabled={busy || !email || !password}>
            {busy ? 'Saving…' : 'Change e-mail'}
          </button>
        </div>
      </form>
    </Card>
  );
}

function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await deleteAccount(password);
    setBusy(false);
    if (r.ok) {
      onDeleted();
    } else {
      setError(EMAIL_PROBLEMS[r.code] ?? 'Could not delete the account.');
    }
  };

  return (
    <Card
      title="Delete account"
      description="Removes your account and attendance. This cannot be undone."
    >
      {!open ? (
        <div className="actions">
          <Button variant="danger" onClick={() => setOpen(true)}>
            Delete my account
          </Button>
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => void submit(e)} aria-label="Delete account">
          <Notice tone="warning" title="This is permanent">
            Your account is closed immediately and erased for good after a short grace period. Enter
            your password to confirm.
          </Notice>
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <Notice tone="danger" title={error} urgent />}
          <div className="actions">
            <Button variant="danger" type="submit" disabled={busy || !password}>
              {busy ? 'Deleting…' : 'Delete account permanently'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
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
        breadcrumbs={[{ label: 'Home', to: HOME_PATH }, { label: 'Account' }]}
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
        {!user.emailVerified && <ResendVerification email={user.email} />}
      </Card>

      <ChangePassword />

      <ChangeEmail />

      {user.role === 'LECTURER' && (
        <Card title="Subscription" description="Your plan, free trial, and payments.">
          <div className="actions">
            <LinkButton to="/account/billing" variant="secondary">
              Manage subscription
            </LinkButton>
          </div>
        </Card>
      )}

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

      {user.role === 'STUDENT' && <DeleteAccount onDeleted={() => void signOut()} />}
    </AppShell>
  );
}
