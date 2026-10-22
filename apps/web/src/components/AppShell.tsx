import type { ReactNode } from 'react';
import { useAuth } from '../features/auth/AuthGate';
import { HOME_PATH, Link, useRouter } from '../router';
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

function SessionsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3H3a1 1 0 00-1 1v12a1 1 0 001 1h14a1 1 0 001-1V4a1 1 0 00-1-1z" />
      <path d="M2 7h16" />
      <path d="M6 3v4" />
      <path d="M14 3v4" />
    </svg>
  );
}

function BillingIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="16" height="12" rx="1" />
      <path d="M2 8h16" />
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
  { to: '/my/courses', label: 'My courses', icon: <SessionsIcon />, current: (p) => p.startsWith('/my/courses') },
  { to: '/account', label: 'Account', icon: <AccountIcon />, current: (p) => p.startsWith('/account') },
];

const LECTURER_NAV: NavItem[] = [
  {
    to: HOME_PATH,
    label: 'Sessions',
    icon: <SessionsIcon />,
    current: (p) => p === HOME_PATH || p === '/' || p.startsWith('/courses'),
  },
  { to: '/account/billing', label: 'Billing', icon: <BillingIcon />, current: (p) => p === '/account/billing' },
  { to: '/account', label: 'Account', icon: <AccountIcon />, current: (p) => p === '/account' || p === '/account/privacy' },
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
          <div className="app-topbar__end" />
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
