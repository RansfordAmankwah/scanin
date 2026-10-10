import { useEffect, useState } from 'react';
import { verifyEmail } from './api/auth';
import { Button, Notice } from './components/ui';
import { AuthGate, useAuth } from './features/auth/AuthGate';
import { CoursePage } from './features/lecturer/CoursePage';
import { CoursesPage } from './features/lecturer/CoursesPage';
import { QrDisplay } from './features/lecturer/QrDisplay';
import { SessionPage } from './features/lecturer/SessionPage';
import { capturePendingToken, CheckInScreen } from './features/student/CheckInScreen';
import { MyAttendance } from './features/student/MyAttendance';
import { Link, Router, useRouter } from './router';

const ID = '([0-9a-f-]{36})';
const PRESENT = new RegExp(`^/present/${ID}/${ID}/?$`, 'i');
const COURSE = new RegExp(`^/courses/${ID}/?$`, 'i');
const SESSION = new RegExp(`^/courses/${ID}/sessions/${ID}/?$`, 'i');

function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const { user, signOut } = useAuth();
  return (
    <main className={`page${wide ? ' page--wide' : ''}`}>
      <header className="topbar">
        <h1>
          <Link to="/">ScanIn</Link>
        </h1>
        <p>
          <span className="muted">
            {user.fullName} ({user.role === 'STUDENT' ? 'student' : 'lecturer'})
          </span>{' '}
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </p>
      </header>
      {children}
    </main>
  );
}

function StudentHome() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <Shell>
      <CheckInScreen onFinished={() => setReloadKey((k) => k + 1)} />
      <MyAttendance reloadKey={reloadKey} />
    </Shell>
  );
}

function LecturerRoutes({ path }: { path: string }) {
  const session = SESSION.exec(path);
  const course = COURSE.exec(path);
  return (
    <Shell wide>
      {session?.[1] && session[2] ? (
        <SessionPage courseId={session[1]} sessionId={session[2]} key={session[2]} />
      ) : course?.[1] ? (
        <CoursePage courseId={course[1]} key={course[1]} />
      ) : (
        <CoursesPage />
      )}
    </Shell>
  );
}

function Routes() {
  const { user } = useAuth();
  const { path } = useRouter();
  const present = PRESENT.exec(path);

  if (present?.[1] && present[2]) {
    if (user.role !== 'LECTURER') {
      return (
        <main className="page">
          <Notice tone="danger" title="Lecturers only" urgent>
            Only a lecturer can show the class QR code.
          </Notice>
        </main>
      );
    }
    return <QrDisplay courseId={present[1]} sessionId={present[2]} key={present[2]} />;
  }
  return user.role === 'STUDENT' ? <StudentHome /> : <LecturerRoutes path={path} />;
}

function VerifyEmail() {
  const [state, setState] = useState<'working' | 'ok' | 'failed'>('working');
  useEffect(() => {
    const token = /[#&]t=([\w-]+)/.exec(window.location.hash)?.[1];
    // Remove the single-use token from the address bar straight away.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) return setState('failed');
    void verifyEmail(token).then((ok) => setState(ok ? 'ok' : 'failed'));
  }, []);
  return (
    <main className="page">
      <h1>ScanIn</h1>
      {state === 'working' && <p role="status">Verifying your e-mail…</p>}
      {state === 'ok' && (
        <Notice tone="success" title="E-mail verified">
          You can now sign in.
        </Notice>
      )}
      {state === 'failed' && (
        <Notice tone="danger" title="This link is invalid or has expired" urgent>
          Sign in and ask for a new verification link.
        </Notice>
      )}
    </main>
  );
}

/**
 * Routes (path based):
 *   /                                     student: check in + my attendance; lecturer: courses
 *   /courses/<id>                         lecturer: sessions and class list
 *   /courses/<id>/sessions/<id>           lecturer: controls, counts, attendance, scan history
 *   /present/<course>/<session>           lecturer: projector QR display
 *   /c#t=<code>                           student: check in from the phone's camera app
 *   /verify-email#t=<token>               e-mail verification
 */
export function App({ pathname = window.location.pathname }: { pathname?: string }) {
  if (pathname === '/verify-email') return <VerifyEmail />;

  // A code opened via the phone's camera app is captured before sign-in so it survives it.
  if (!PRESENT.test(pathname)) capturePendingToken();

  return (
    <Router initialPath={pathname}>
      <AuthGate>
        <Routes />
      </AuthGate>
    </Router>
  );
}
