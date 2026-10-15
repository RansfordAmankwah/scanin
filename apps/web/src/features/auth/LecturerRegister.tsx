import { useState } from 'react';
import { registerLecturer, type LecturerRegistrationInput } from '../../api/auth';
import { Button, Notice, TextField } from '../../components/ui';

const MESSAGES: Record<string, string> = {
  INVALID_NAME: 'Enter your full name.',
  PASSWORD_TOO_SHORT: 'Choose a password of at least 10 characters.',
  PASSWORD_TOO_LONG: 'That password is too long (128 characters at most).',
  INVALID_REQUEST: 'Check the form and try again.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
};

/**
 * A lecturer account on its own gives access to nothing: courses are assigned by whoever runs
 * ScanIn, and the lecturer sees only those.
 */
export function LecturerRegister({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<LecturerRegistrationInput>({
    fullName: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);

  const set = (key: keyof LecturerRegistrationInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await registerLecturer(form);
    setBusy(false);
    if (result.ok) {
      setForm((f) => ({ ...f, password: '' }));
      setCreated(true);
    } else {
      setError(MESSAGES[result.code] ?? 'Could not create the account. Please try again.');
    }
  };

  if (created) {
    return (
      <div className="auth__card">
        <Notice tone="success" title="Lecturer account created">
          Sign in to continue. You will see your courses once the person who runs ScanIn has
          assigned them to you.
        </Notice>
        <Button onClick={onDone}>Go to sign in</Button>
      </div>
    );
  }

  return (
    <form
      className="auth__card"
      onSubmit={(e) => void submit(e)}
      aria-label="Create lecturer account"
    >
      <h2>Create a lecturer account</h2>
      <TextField
        label="Full name"
        value={form.fullName}
        onChange={set('fullName')}
        autoComplete="name"
        required
      />
      <TextField
        label="E-mail"
        type="email"
        value={form.email}
        onChange={set('email')}
        autoComplete="email"
        required
      />
      <TextField
        label="Password"
        type="password"
        value={form.password}
        onChange={set('password')}
        autoComplete="new-password"
        hint="At least 10 characters."
        required
      />
      {error && <Notice tone="danger" title={error} urgent />}
      <div className="actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <Button variant="secondary" onClick={onCancel}>
          Back to sign in
        </Button>
      </div>
    </form>
  );
}
