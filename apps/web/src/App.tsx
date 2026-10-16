import { useEffect, useState } from 'react';
import { verifyEmail } from './api/auth';
import { Notice } from './components/ui';
import { AccountPage } from './features/account/AccountPage';
import { PrivacyPage } from './features/account/PrivacyPage';
import { AuthGate, useAuth } from './features/auth/AuthGate';
import { CourseWorkspace, type CourseTab } from './features/lecturer/CourseWorkspace';
import { CoursesPage } from './features/lecturer/CoursesPage';
import { QrDisplay } from './features/lecturer/QrDisplay';
import { SessionPage } from './features/lecturer/SessionPage';
import { StudentHistoryPage } from './features/lecturer/StudentHistoryPage';
import { capturePendingToken } from './features/student/CheckInScreen';
import { CourseHistoryPage } from './features/student/CourseHistoryPage';
import { MyCoursesPage } from './features/student/MyCoursesPage';
import { StudentHome } from './features/student/StudentHome';
import { Router, useRouter } from './router';

const ID = '([0-9a-f-]{36})';
const PRESENT = new RegExp(`^/present/${ID}/${ID}/?$`, 'i');
const COURSE = new RegExp(`^/courses/${ID}(?:/(attendance|class-list|review))?/?$`, 'i');
const SESSION = new RegExp(`^/courses/${ID}/sessions/${ID}/?$`, 'i');
const STUDENT = new RegExp(`^/courses/${ID}/students/${ID}/?$`, 'i');
const MY_COURSE = new RegExp(`^/my/courses/${ID}/?$`, 'i');
const MY_COURSES = /^\/my\/courses\/?$/;
const ACCOUNT = /^\/account\/?$/;
const PRIVACY = /^\/account\/privacy\/?$/;

function StudentRoutes({ path }: { path: string }) {
  const course = MY_COURSE.exec(path);
  if (course?.[1]) return <CourseHistoryPage courseId={course[1]} key={course[1]} />;
  if (MY_COURSES.test(path)) return <MyCoursesPage />;
  return <StudentHome />;
}

function LecturerRoutes({ path }: { path: string }) {
  const session = SESSION.exec(path);
  if (session?.[1] && session[2]) {
    return <SessionPage courseId={session[1]} sessionId={session[2]} key={session[2]} />;
  }
  const student = STUDENT.exec(path);
  if (student?.[1] && student[2]) {
    return <StudentHistoryPage courseId={student[1]} linkId={student[2]} key={student[2]} />;
  }
  const course = COURSE.exec(path);
  if (course?.[1]) {
    const tab = (course[2] ?? 'sessions') as CourseTab;
    return <CourseWorkspace courseId={course[1]} tab={tab} key={course[1]} />;
  }
  return <CoursesPage />;
}

function Routes() {
  const { user } = useAuth();
  const { path } = useRouter();
  const present = PRESENT.exec(path);

  if (present?.[1] && present[2]) {
    if (user.role !== 'LECTURER') {
      return (
        <main className="auth">
          <Notice tone="danger" title="Lecturers only" urgent>
            Only a lecturer can show the class QR code.
          </Notice>
        </main>
      );
    }
    return <QrDisplay courseId={present[1]} sessionId={present[2]} key={present[2]} />;
  }
  if (PRIVACY.test(path) && user.role === 'STUDENT') return <PrivacyPage />;
  if (ACCOUNT.test(path)) return <AccountPage />;
  return user.role === 'STUDENT' ? <StudentRoutes path={path} /> : <LecturerRoutes path={path} />;
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
    <main className="auth">
      <div className="auth__brand">
        <img src="/favicon.svg" alt="" className="brand__mark" width="28" height="28" />
        <h1>ScanIn</h1>
      </div>
      <div className="auth__card">
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
        <a className="btn btn--secondary" href="/">
          Go to ScanIn
        </a>
      </div>
    </main>
  );
}

/**
 * Routes (path based):
 *   /                                     student: check in + course summaries; lecturer: courses
 *   /account                              both: profile and password
 *   /my/courses                           student: every course, searchable
 *   /my/courses/<id>                      student: one course's attendance, session by session
 *   /courses/<id>[/attendance|/class-list|/review]    lecturer: course workspace
 *   /courses/<id>/students/<link>         lecturer: one student's attendance in the course
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
