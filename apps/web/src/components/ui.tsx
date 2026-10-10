import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

export function Button({
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  return (
    <button
      type="button"
      {...props}
      className={`btn${variant === 'secondary' ? ' btn--secondary' : ''}`}
    />
  );
}

export function TextField({
  label,
  hint,
  error,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | null;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint && (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

type Tone = 'success' | 'warning' | 'danger' | 'info';
const ICONS: Record<Tone, string> = { success: '✓', warning: '!', danger: '✕', info: 'i' };

/** Status message: icon + words + colour, so nothing depends on colour alone. */
export function Notice({
  tone,
  title,
  children,
  urgent = false,
}: {
  tone: Tone;
  title: string;
  children?: ReactNode;
  /** Use for errors the user must notice immediately. */
  urgent?: boolean;
}) {
  return (
    <div className={`notice notice--${tone}`} role={urgent ? 'alert' : 'status'}>
      <span className="notice__icon" aria-hidden="true">
        {ICONS[tone]}
      </span>
      <div>
        <h2>{title}</h2>
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}
