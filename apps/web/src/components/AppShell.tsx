import type { ReactNode } from 'react';
import { useAuth } from '../features/auth/AuthGate';
import { Link, useRouter } from '../router';
import { Badge, Button } from './ui';

interface NavItem {
  to: string;
  label: string;
  /** The item is current for these paths. */
  current: (path: string) => boolean;
}

const STUDENT_NAV: NavItem[] = [
  { to: '/', label: 'Home', current: (p) => p === '/' },
  { to: '/my/courses', label: 'My courses', current: (p) => p.startsWith('/my/courses') },
];

const LECTURER_NAV: NavItem[] = [
  { to: '/', label: 'Courses', current: (p) => p === '/' || p.startsWith('/courses') },
];

/**
 * The frame around every signed-in screen: who you are, where you can go, and how to leave. The page
 * itself (title, actions) is drawn by PageHeader inside the main area.
 */
export function AppShell({
  children,
  width = 'wide',
}: {
  children: ReactNode;
  width?: 'wide' | 'medium';
}) {
  const { user, signOut } = useAuth();
  const { path } = useRouter();
  const nav = user.role === 'STUDENT' ? STUDENT_NAV : LECTURER_NAV;
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/" className="brand">
            <span className="brand__mark" aria-hidden="true">
              S
            </span>
            ScanIn
          </Link>
          <nav className="main-nav" aria-label="Main">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                aria-current={item.current(path) ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="user-menu">
            <Link to="/account" className="user-menu__name">
              {user.fullName}
            </Link>
            <Badge tone="neutral">{user.role === 'STUDENT' ? 'Student' : 'Lecturer'}</Badge>
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className={`app-main${width === 'medium' ? ' app-main--medium' : ''}`}>{children}</main>
    </>
  );
}
