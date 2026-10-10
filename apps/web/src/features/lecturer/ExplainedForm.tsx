import { useState, type ReactNode } from 'react';
import { Button, Notice } from '../../components/ui';

export const MIN_EXPLANATION = 10;

/** Narrows an API result to what ExplainedForm needs. */
export const outcome = (
  r: { ok: true } | { ok: false; code: string },
): { ok: true } | { ok: false; code: string } =>
  r.ok ? { ok: true } : { ok: false, code: r.code };

export const ERROR_TEXT: Record<string, string> = {
  INVALID_TRANSITION: 'That is not possible in the current state. The page has been refreshed.',
  ENTRY_HELD: 'Another student is linked to that class-list entry. Resolve that match first.',
  INVALID_ENTRY: 'That class-list entry cannot be used.',
  BASIS_REQUIRED: 'Say whether you are confirming identity or enrollment.',
  DUPLICATE_ACTIVE_FLAG: 'There is already an open flag of this kind.',
  ALREADY_RECORDED: 'This student already has a record for this session.',
  STUDENT_NOT_REGISTERED:
    'That student has not created an account yet, so they cannot be marked present.',
  SESSION_NOT_STARTED: 'Start the session before recording attendance.',
  NOTE_REQUIRED: 'A written note of at least 10 characters is required.',
  INVALID_REQUEST: 'Check the form and try again.',
  NETWORK: 'Could not reach the server. Try again.',
};

/**
 * A small inline form: a written explanation is always required (the server enforces it too), and
 * the primary button stays disabled until it is long enough to mean something.
 */
export function ExplainedForm({
  label,
  submitLabel,
  children,
  onSubmit,
  onDone,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  children?: ReactNode;
  onSubmit: (explanation: string) => Promise<{ ok: true } | { ok: false; code: string }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const long = text.trim().length >= MIN_EXPLANATION;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await onSubmit(text.trim());
    setBusy(false);
    if (r.ok) onDone();
    else {
      setError(ERROR_TEXT[r.code] ?? 'Something went wrong. Try again.');
      if (r.code === 'INVALID_TRANSITION') onDone(); // state moved on: refresh the view
    }
  };

  return (
    <form className="stack subform" aria-label={label} onSubmit={(e) => void submit(e)}>
      {children}
      <div className="field">
        <label htmlFor={`${label}-why`}>Written explanation (required)</label>
        <textarea
          id={`${label}-why`}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="hint">
          At least {MIN_EXPLANATION} characters. This is kept in the record.
        </span>
      </div>
      {error && <Notice tone="danger" title={error} urgent />}
      <div className="actions">
        <button type="submit" className="btn" disabled={busy || !long}>
          {submitLabel}
        </button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
