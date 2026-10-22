import { useEffect, useState } from 'react';
import { requestPasswordReset, resetPassword } from '../../api/auth';
import { Button, Notice, TextField } from '../../components/ui';

const RESET_ERRORS: Record<string, string> = {
  INVALID_OR_EXPIRED_LINK: 'This link is invalid or has expired. Request a new one.',
  PASSWORD_TOO_SHORT: 'Choose a password of 10 to 128 characters.',
  PASSWORD_TOO_LONG: 'Choose a password of 10 to 128 characters.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
  ERROR: 'Something went wrong. Please try again.',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-hero">
        <a href="/" className="auth-hero__brand">
          <img src="/favicon.svg" alt="" className="brand__mark" width="28" height="28" />
          ScanIn
        </a>
        <div className="auth-hero__body">
          <h1>Attendance that checks itself.</h1>
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-panel__inner">
          <div className="auth-panel__mobile-brand">
            <img src="/favicon.svg" alt="" className="brand__mark" width="28" height="28" />
            ScanIn
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}

/** Asks for an e-mail and requests a reset link. The result is always the same, by design. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await requestPasswordReset(email);
    setBusy(false);
    setSent(true);
  };

  if (sent) {
    return (
      <Shell>
        <div className="auth__card">
          <Notice tone="success" title="Check your e-mail">
            If an account exists for that address, we have sent a link to reset the password. The
            link expires soon.
          </Notice>
          <a className="btn btn--secondary" href="/sign-in">
            Back to sign in
          </a>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <form className="auth__card" onSubmit={(e) => void submit(e)} aria-label="Reset password">
        <h2>Reset your password</h2>
        <p>Enter your account e-mail and we will send you a link to choose a new password.</p>
        <TextField
          label="E-mail"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
        <a className="btn btn--ghost" href="/sign-in">
          Back to sign in
        </a>
      </form>
    </Shell>
  );
}

/** Reads the token from the URL fragment and sets a new password. */
export function ResetPassword() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const t = /[#&]t=([\w-]+)/.exec(window.location.hash)?.[1] ?? null;
    // Strip the single-use token from the address bar immediately.
    window.history.replaceState(null, '', window.location.pathname);
    setToken(t);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    if (!token) {
      setError(RESET_ERRORS.INVALID_OR_EXPIRED_LINK!);
      return;
    }
    setBusy(true);
    const result = await resetPassword(token, password);
    setBusy(false);
    if (result.ok) {
      setDone(true);
    } else {
      setError(RESET_ERRORS[result.code] ?? RESET_ERRORS.ERROR!);
    }
  };

  if (done) {
    return (
      <Shell>
        <div className="auth__card">
          <Notice tone="success" title="Password changed">
            You can now sign in with your new password. Any other sessions have been signed out.
          </Notice>
          <a className="btn btn--secondary" href="/sign-in">
            Go to sign in
          </a>
        </div>
      </Shell>
    );
  }

  if (token === null) {
    return (
      <Shell>
        <div className="auth__card">
          <Notice tone="danger" title="This link is invalid or has expired" urgent>
            Request a new reset link and try again.
          </Notice>
          <a className="btn btn--secondary" href="/forgot-password">
            Request a new link
          </a>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <form
        className="auth__card"
        onSubmit={(e) => void submit(e)}
        aria-label="Choose a new password"
      >
        <h2>Choose a new password</h2>
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="10 to 128 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {error && (
          <Notice tone="danger" title="Could not reset password" urgent>
            {error}
          </Notice>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
    </Shell>
  );
}
