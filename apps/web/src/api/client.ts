/**
 * Thin fetch wrapper for the same-origin API (proxied under /api in development).
 * Adds the header the server's CSRF guard requires on every state-changing request; the browser
 * supplies the Origin header itself. Cookies travel automatically for same-origin requests.
 */
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Seconds to wait before retrying, from a Retry-After header. */
  retryAfterSeconds: number | null;
}

export async function apiFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ApiResult<T>> {
  const method = init.method ?? 'GET';
  const response = await fetchImpl(`/api${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'X-Requested-With': 'scanin',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const data = await response.json().then(
    (parsed: unknown) => parsed as T,
    () => null, // an empty or non-JSON body is not an error here
  );
  const retry = Number(response.headers.get('Retry-After'));
  return {
    ok: response.ok,
    status: response.status,
    data,
    retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null,
  };
}
