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
    <form className="auth__card" onSubmit={(e) => void submit(e)} aria-label="Sign in">
      <h2>Sign in</h2>
      <TextField
        label="E-mail"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && <Notice tone="danger" title={error} urgent />}
      <button type="submit" className="btn btn--block" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

/**
 * Shows sign-in / registration until a session exists, then renders `children` with the user
 * available through useAuth(). The server decides who is signed in; this only reflects it.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [mode, setMode] = useState<'login' | 'register' | 'register-lecturer'>('login');

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
      <main className="auth">
        <div className="auth__brand">
          <img src="/favicon.svg" alt="" className="brand__mark" width="28" height="28" />
          <h1>ScanIn</h1>
          <p>Attendance for your classes.</p>
        </div>
        {mode === 'login' ? (
          <>
            <LoginForm onSignedIn={setUser} />
            <div className="auth__alt">
              <span>New student?</span>
              <Button variant="ghost" onClick={() => setMode('register')}>
                Create an account
              </Button>
              <span>Teach a course?</span>
              <Button variant="ghost" onClick={() => setMode('register-lecturer')}>
                Create a lecturer account
              </Button>
            </div>
          </>
        ) : mode === 'register-lecturer' ? (
          <LecturerRegister onDone={() => setMode('login')} onCancel={() => setMode('login')} />
        ) : (
          <RegisterFlow onDone={() => setMode('login')} onCancel={() => setMode('login')} />
        )}
      </main>
    );
  }

  return <AuthContext.Provider value={{ user, signOut }}>{children}</AuthContext.Provider>;
}
