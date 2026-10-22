import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchMe, login, logout, type CurrentUser } from '../../api/auth';
import { Button, Loading, Notice, TextField } from '../../components/ui';
import { LecturerRegister } from './LecturerRegister';
import { RegisterFlow } from './RegisterFlow';

interface AuthContextValue {
  user: CurrentUser;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthGate>');
  return ctx;
}

const LOGIN_ERRORS = {
  INVALID_CREDENTIALS: 'E-mail or password is incorrect.',
  RATE_LIMITED: 'Too many failed attempts. Try again in a few minutes.',
  NETWORK: 'Could not reach the server. Check your connection and try again.',
  ERROR: 'Something went wrong. Please try again.',
} as const;

const HERO = {
  student: {
    heading: 'Check in to class with a scan.',
    tagline: 'Scan the code your lecturer shows. Your attendance is recorded for that session only.',
  },
  lecturer: {
    heading: 'Attendance that checks itself.',
    tagline: 'Show a code. Students scan it from their seats. You get a clean record without calling names.',
  },
} as const;

function RefreshIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 10a7 7 0 1 1-2-5" />
      <path d="M17 3v5h-5" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 18s-6-5.34-6-9a6 6 0 1 1 12 0c0 3.66-6 9-6 9z" />
      <circle cx="10" cy="9" r="2" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3v10m0 0l-3-3m3 3l3-3" />
      <path d="M3 14v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

type Role = 'student' | 'lecturer';

function RoleToggle({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Account type">
      <button
        type="button"
        className="segmented__btn"
        role="radio"
        aria-checked={value === 'student'}
        onClick={() => onChange('student')}
      >
        Student
      </button>
      <button
        type="button"
        className="segmented__btn"
        role="radio"
        aria-checked={value === 'lecturer'}
        onClick={() => onChange('lecturer')}
      >
        Lecturer
      </button>
    </div>
  );
}

function LoginForm({ onSignedIn }: { onSignedIn: (u: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await login(email, password);
    setBusy(false);
    if (result.ok) {
      setPassword('');
      onSignedIn(result.user);
    } else {
      setError(LOGIN_ERRORS[result.reason]);
    }
  };

  return (
    <form className="auth-fields" onSubmit={(e) => void submit(e)} aria-label="Sign in">
      <TextField
        label="E-mail"
        type="email"
        autoComplete="username"
        placeholder="name@your-institution.edu"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        placeholder="Your password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <a className="auth-forgot" href="/forgot-password">
        Forgot password?
      </a>
      {error && <Notice tone="danger" title={error} urgent />}
      <button type="submit" className="btn btn--block" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [mode, setMode] = useState<'login' | 'register' | 'register-lecturer'>('login');
  const [role, setRole] = useState<Role>('student');

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((u) => !cancelled && setUser(u))
      .catch(() => !cancelled && setUser(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
  }, []);

  if (user === undefined) {
    return (
      <main className="auth">
        <Loading label="Loading…" />
      </main>
    );
  }

  if (user === null) {
    return (
      <main className="auth-page">
        <div className="auth-hero">
          <h1 className="auth-hero__brand">
            <a href="/" style={{ color: 'inherit', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 'inherit' }}>
              <img src="/favicon.svg" alt="" className="brand__mark" width="28" height="28" />
              ScanIn
            </a>
          </h1>
          <div className="auth-hero__body">
            <p className="auth-hero__heading">{HERO[role].heading}</p>
            <p className="auth-hero__tagline">{HERO[role].tagline}</p>
          </div>
          {role === 'lecturer' && (
            <ul className="auth-hero__features">
              <li><RefreshIcon /> The code on screen refreshes on its own</li>
              <li><PinIcon /> Students have to be in the room to check in</li>
              <li><DownloadIcon /> Every session exports when you need it</li>
            </ul>
          )}
          {role === 'student' && (
            <p className="auth-hero__privacy">
              Your camera and location are used only while a check-in is open.
            </p>
          )}
        </div>

        <div className="auth-panel">
          <div className="auth-panel__inner">
            <div className="auth-panel__mobile-brand">
              <img src="/favicon.svg" alt="" className="brand__mark" width="28" height="28" />
              ScanIn
            </div>
            <p className="auth-panel__mobile-hero">{HERO[role].heading}</p>
            <p className="auth-panel__mobile-tagline">{HERO[role].tagline}</p>

            {mode === 'login' ? (
              <>
                <div className="auth-panel__header">
                  <h2>Sign in</h2>
                  <p className="muted">Welcome back.</p>
                </div>

                <RoleToggle value={role} onChange={setRole} />

                <LoginForm onSignedIn={setUser} />

                <div className="auth-alt">
                  {role === 'student' && (
                    <p>
                      First time?{' '}
                      <button type="button" className="textlink" onClick={() => setMode('register')}>
                        Create an account
                      </button>
                    </p>
                  )}
                  <p>
                    {role === 'lecturer' ? 'New lecturer? ' : ''}
                    <button type="button" className="textlink" onClick={() => setMode('register-lecturer')}>
                      Create a lecturer account
                    </button>
                  </p>
                </div>

                <p className="auth-panel__mobile-privacy muted">
                  {role === 'student'
                    ? 'Your camera and location are used only while a check-in is open.'
                    : ''}
                </p>
              </>
            ) : mode === 'register-lecturer' ? (
              <LecturerRegister onDone={() => setMode('login')} onCancel={() => setMode('login')} />
            ) : (
              <RegisterFlow onDone={() => setMode('login')} onCancel={() => setMode('login')} />
            )}
          </div>
        </div>
      </main>
    );
  }

  return <AuthContext.Provider value={{ user, signOut }}>{children}</AuthContext.Provider>;
}
