import { vi } from 'vitest';

export function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name] ?? null },
  } as unknown as Response;
}

type Handler = (init: RequestInit & { body?: string }) => Response | Promise<Response>;

/** Routes fetch calls by "METHOD /path"; anything unrouted fails the test loudly. */
export function mockApi(routes: Record<string, Handler | Response>) {
  const fn = vi.fn(async (url: string, init: RequestInit & { body?: string } = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(/^\/api/, '')}`;
    const route = routes[key];
    if (!route) throw new Error(`Unrouted request: ${key}`);
    return typeof route === 'function' ? route(init) : route;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const bodyOf = (call: unknown[]): Record<string, unknown> =>
  JSON.parse((call[1] as { body?: string }).body ?? '{}') as Record<string, unknown>;
