import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '../router';

/* ------------------------------------------------------------------------------------------------
 * Buttons
 * ---------------------------------------------------------------------------------------------- */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonClass = (variant: ButtonVariant, size?: 'sm', block?: boolean) =>
  [
    'btn',
    variant !== 'primary' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
  ]
    .filter(Boolean)
    .join(' ');

/** One primary action per area; secondary for the rest; ghost for quiet ones; danger only for what cannot be undone. */
export function Button({
  variant = 'primary',
  size,
  block,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm';
  block?: boolean;
}) {
  return <button type="button" {...props} className={buttonClass(variant, size, block)} />;
}

/** A link that looks like a button (navigation, not an action). */
export function LinkButton({
  to,
  variant = 'primary',
  size,
  block,
  children,
}: {
  to: string;
  variant?: ButtonVariant;
  size?: 'sm';
  block?: boolean;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={buttonClass(variant, size, block)}>
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Form fields: every control has a visible label, optional hint, and an announced error.
 * ---------------------------------------------------------------------------------------------- */
function describedBy(id: string, hint?: string, error?: string | null) {
  return (
    [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
  );
}

function FieldText({
  id,
  hint,
  error,
}: {
  id: string;
  hint?: string | undefined;
  error?: string | null | undefined;
}) {
  return (
    <>
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
    </>
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
  const [revealed, setRevealed] = useState(false);
  const isPassword = input.type === 'password';
  // A password field can be revealed; toggling swaps the input type without losing the value.
  const effectiveType = isPassword && revealed ? 'text' : input.type;
  const field = (
    <input
      id={id}
      {...input}
      type={effectiveType}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, hint, error)}
    />
  );
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isPassword ? (
        <div className="field__reveal">
          {field}
          <button
            type="button"
            className="field__reveal-btn"
            onClick={() => setRevealed((v) => !v)}
            aria-pressed={revealed}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            title={revealed ? 'Hide password' : 'Show password'}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      ) : (
        field
      )}
      <FieldText id={id} hint={hint} error={error} />
    </div>
  );
}

function EyeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a18 18 0 0 1-2.16 3.19m-2.5 2.3A9.3 9.3 0 0 1 12 19C5.5 19 2 12 2 12a18 18 0 0 1 5.06-5.94" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

export function SelectField({
  label,
  hint,
  error,
  children,
  ...select
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        {...select}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      >
        {children}
      </select>
      <FieldText id={id} hint={hint} error={error} />
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  ...area
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
  error?: string | null;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        {...area}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      />
      <FieldText id={id} hint={hint} error={error} />
    </div>
  );
}

/** A search box that filters what is already on screen. */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="search"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------------------------------- */
export type BadgeTone = 'success' | 'warning' | 'attention' | 'danger' | 'info' | 'neutral';

/** A pill-shaped status tag. The text always carries the meaning; colour only reinforces it. */
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
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

/* ------------------------------------------------------------------------------------------------
 * Structure
 * ---------------------------------------------------------------------------------------------- */
export function Card({
  title,
  description,
  actions,
  id,
  flush,
  children,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
  /** No inner padding: for a table that should run edge to edge. */
  flush?: boolean;
  children?: ReactNode;
}) {
  const auto = useId();
  const headingId = `${id ?? auto}-heading`;
  return (
    <section
      id={id}
      className={`card${flush ? ' card--flush' : ''}`}
      aria-labelledby={title ? headingId : undefined}
    >
      {title && (
        <div className="card__header">
          <div>
            <h2 id={headingId}>{title}</h2>
            {description && <p className="card__description">{description}</p>}
          </div>
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export interface Crumb {
  label: string;
  to?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => (
          <li key={`${c.label}-${i}`} aria-current={i === items.length - 1 ? 'page' : undefined}>
            {c.to && i < items.length - 1 ? (
              <Link to={c.to}>{c.label}</Link>
            ) : (
              <span>{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The one h1 of a signed-in page, with where-am-I above it and what-can-I-do beside it. */
export function PageHeader({
  title,
  breadcrumbs,
  meta,
  actions,
}: {
  title: ReactNode;
  breadcrumbs?: Crumb[];
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} />}
      <div className="page-header__row">
        <div>
          <h1>{title}</h1>
          {meta && <div className="page-header__meta">{meta}</div>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
    </header>
  );
}

export interface TabItem {
  to: string;
  label: string;
  count?: number;
}

/** Navigation between the parts of one thing. Each tab is an address, so it can be bookmarked and reloaded. */
export function Tabs({
  label,
  items,
  current,
}: {
  label: string;
  items: TabItem[];
  current: string;
}) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((t) => (
        <Link key={t.to} to={t.to} aria-current={t.to === current ? 'page' : undefined}>
          {t.label}
          {t.count ? (
            <span className="tab__count" aria-label={`${t.count} need attention`}>
              {t.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="stat">
      <dt className="stat__label">{label}</dt>
      <dd className="stat__value">{value}</dd>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

export function StatGrid({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl className="stats" aria-label={label}>
      {children}
    </dl>
  );
}

/** A percentage with its own text, so it never relies on the bar alone. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="progress">
      <div
        className="progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="progress__bar" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress__label">{pct}%</span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Loading, empty and error states: always say what is happening, and what to do next.
 * ---------------------------------------------------------------------------------------------- */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="stack stack--tight" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <span className="skeleton" aria-hidden="true" style={{ width: '40%' }} />
      <span className="skeleton" aria-hidden="true" />
      <span className="skeleton" aria-hidden="true" style={{ width: '70%' }} />
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  children,
  onRetry,
}: {
  title: string;
  children?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <Notice tone="danger" title={title} urgent>
      {children}
      {onRetry && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </Notice>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Confirmation dialog. Used for actions that cannot be undone. Focus starts on the safe choice,
 * Tab stays inside, Escape cancels, and focus returns to where it was.
 * ---------------------------------------------------------------------------------------------- */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input, select, textarea',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div ref={panel} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        <div className="stack stack--tight">{children}</div>
        <div className="actions">
          <button
            ref={cancel}
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn${danger ? ' btn--danger' : ''}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
