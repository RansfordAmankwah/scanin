import { useState } from 'react';
import { commitRegistration, previewRegistration, type RegistrationInput } from '../../api/auth';
import { Button, Notice, TextField } from '../../components/ui';

const MESSAGES: Record<string, string> = {
  INVALID_STUDENT_ID: 'Enter a valid student ID (letters and numbers, 3 to 32 characters).',
  INVALID_NAME: 'Enter your full name.',
  PASSWORD_TOO_SHORT: 'Choose a password of at least 10 characters.',
  PASSWORD_TOO_LONG: 'That password is too long (128 characters at most).',
  INVALID_REQUEST: 'Check the form and try again.',
  STUDENT_ID_TAKEN:
    'This student ID is already registered. If you think this is an error, contact your lecturer.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
};

type Step =
  | { kind: 'form' }
  | { kind: 'confirm'; studentId: string; fullName: string; email: string }
  | { kind: 'done' };

/**
 * Two steps on purpose: the student ID and name are self-reported and cannot be changed later, so
 * the account is only created after they confirm exactly what will be stored.
 */
export function RegisterFlow({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<RegistrationInput>({
    studentId: '',
    fullName: '',
    email: '',
    password: '',
  });
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof RegistrationInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const review = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await previewRegistration(form);
    setBusy(false);
    if (result.ok)
      setStep({
        kind: 'confirm',
        studentId: result.studentId,
        fullName: result.fullName,
        email: result.email,
      });
    else setError(MESSAGES[result.code] ?? 'Check the form and try again.');
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await commitRegistration(form);
    setBusy(false);
    if (result.ok) {
      setForm((f) => ({ ...f, password: '' }));
      setStep({ kind: 'done' });
    } else {
      setStep({ kind: 'form' });
      setError(MESSAGES[result.code] ?? 'Could not create the account. Please try again.');
    }
  };

  if (step.kind === 'done') {
    return (
      <div className="auth__card">
        <Notice tone="success" title="Account created">
          Check your e-mail for a link to verify your address, then sign in.
        </Notice>
        <Button onClick={onDone}>Go to sign in</Button>
      </div>
    );
  }

  if (step.kind === 'confirm') {
    return (
      <section className="auth__card" aria-labelledby="confirm-heading">
        <h2 id="confirm-heading">Is this correct?</h2>
        <dl className="details">
          <dt>Student ID</dt>
          <dd>{step.studentId}</dd>
          <dt>Full name</dt>
          <dd>{step.fullName}</dd>
          <dt>E-mail</dt>
          <dd>{step.email}</dd>
        </dl>
        <Notice tone="warning" title="You cannot change your student ID or name afterwards">
          Your lecturer sees these to match you to the class list.
        </Notice>
        {error && <Notice tone="danger" title={error} urgent />}
        <div className="actions">
          <Button onClick={() => void create()} disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
          <Button variant="secondary" onClick={() => setStep({ kind: 'form' })} disabled={busy}>
            Go back and edit
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form className="auth__card" onSubmit={(e) => void review(e)} aria-label="Create account">
      <h2>Create your account</h2>
      <TextField
        label="Student ID"
        value={form.studentId}
        onChange={set('studentId')}
        autoComplete="off"
        autoCapitalize="characters"
        required
      />
      <TextField
        label="Full name"
        value={form.fullName}
        onChange={set('fullName')}
        autoComplete="name"
        required
      />
      <TextField
        label="School e-mail"
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
          {busy ? 'Checking…' : 'Review details'}
        </button>
        <Button variant="secondary" onClick={onCancel}>
          Back to sign in
        </Button>
      </div>
    </form>
  );
}
