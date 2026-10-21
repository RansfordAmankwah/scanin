import type { ReactNode } from 'react';
import { useAuth } from '../features/auth/AuthGate';
import { HOME_PATH, Link, useRouter } from '../router';
import { ThemeToggle } from './ThemeToggle';
import { Badge, Button } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  current: (path: string) => boolean;
}

function HomeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10l7-7 7 7" />
      <path d="M5 8v8a1 1 0 001 1h3v-4h2v4h3a1 1 0 001-1V8" />
    </svg>
  );
}

function CoursesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 4h5a3 3 0 013 3v10a2 2 0 00-2-2H2V4z" />
      <path d="M18 4h-5a3 3 0 00-3 3v10a2 2 0 012-2h6V4z" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="7" r="3" />
      <path d="M4 17a6 6 0 0112 0" />
    </svg>
  );
}

const STUDENT_NAV: NavItem[] = [
  { to: HOME_PATH, label: 'Home', icon: <HomeIcon />, current: (p) => p === HOME_PATH || p === '/' },
  { to: '/my/courses', label: 'My courses', icon: <CoursesIcon />, current: (p) => p.startsWith('/my/courses') },
  { to: '/account', label: 'Account', icon: <AccountIcon />, current: (p) => p.startsWith('/account') },
];

const LECTURER_NAV: NavItem[] = [
  {
    to: HOME_PATH,
    label: 'Courses',
    icon: <CoursesIcon />,
    current: (p) => p === HOME_PATH || p === '/' || p.startsWith('/courses'),
  },
  { to: '/account', label: 'Account', icon: <AccountIcon />, current: (p) => p.startsWith('/account') },
];

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
    <div className="app-layout">
      <aside className="app-sidebar">
        <Link to={HOME_PATH} className="sidebar__brand">
          <img src="/favicon.svg" alt="" className="brand__mark" width="28" height="28" />
          ScanIn
        </Link>
        <nav className="sidebar-nav" aria-label="Main">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="sidebar-nav__item"
              aria-current={item.current(path) ? 'page' : undefined}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar__footer">
          <ThemeToggle />
          <div className="sidebar__user">
            <span className="sidebar__user-name">{user.fullName}</span>
            <Badge tone="neutral">{user.role === 'STUDENT' ? 'Student' : 'Lecturer'}</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </aside>

      <div className="app-body">
        <header className="app-topbar">
          <Link to={HOME_PATH} className="brand">
            <img src="/favicon.svg" alt="" className="brand__mark" width="28" height="28" />
            ScanIn
          </Link>
          <div className="app-topbar__end">
            <ThemeToggle />
          </div>
        </header>

        <main className={`app-main${width === 'medium' ? ' app-main--medium' : ''}`}>
          {children}
        </main>
      </div>

      <nav className="bottom-tabs" aria-label="Tabs">
        {nav.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="bottom-tabs__item"
            aria-current={item.current(path) ? 'page' : undefined}
          >
            {item.icon}
            <span className="bottom-tabs__label">{item.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
