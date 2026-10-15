import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result } from '../api/lecturer';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'not-found' }
  | { status: 'error'; code: string };

/**
 * Loads one thing from the API and tells the screen which of four states it is in, so every screen
 * handles loading, success, "that does not exist (or is not yours)" and failure explicitly.
 * `reload` refetches without flashing the loading state again.
 */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: unknown[]) {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const alive = useRef(true);
  const latest = useRef(load);
  latest.current = load;

  const run = useCallback(async (initial: boolean) => {
    if (initial) setState({ status: 'loading' });
    const r = await latest.current();
    if (!alive.current) return;
    if (r.ok) setState({ status: 'ready', data: r.data });
    else if (r.status === 404) setState({ status: 'not-found' });
    else setState({ status: 'error', code: r.code });
  }, []);

  useEffect(() => {
    alive.current = true;
    void run(true);
    return () => {
      alive.current = false;
    };
  }, deps);

  const reload = useCallback(() => run(false), [run]);
  return { state, reload };
}
