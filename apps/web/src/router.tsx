import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * The signed-in app's home. The public landing lives at `/` (served statically by the API); the app
 * — sign-in when signed out, the dashboard when signed in — is entered at `/sign-in`.
 */
export const HOME_PATH = '/sign-in';

/** A deliberately tiny router: paths only, History API, no dependencies. */
interface RouterValue {
  path: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterValue>({ path: '/', navigate: () => undefined });

export function Router({ initialPath, children }: { initialPath?: string; children: ReactNode }) {
  const [path, setPath] = useState(initialPath ?? window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState(null, '', to);
    setPath(to);
    window.scrollTo?.(0, 0);
  }, []);

  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export const useRouter = (): RouterValue => useContext(RouterContext);

export function Link({
  to,
  children,
  className,
  'aria-current': ariaCurrent,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  'aria-current'?: 'page' | undefined;
}) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      aria-current={ariaCurrent}
      onClick={(e) => {
        // Let the browser handle new-tab / modified clicks.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
