import { expect, test } from '../support/fixtures';

test('the production build serves the app, with protective headers and a clean console', async ({
  page,
  request,
}) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    // Browser notes about the expected 401 for a signed-out visitor are not problems; CSP violations are.
    if (m.type() === 'error' && !/status of 401/.test(m.text()))
      problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e}`));
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (r.status() >= 400 && !(r.status() === 401 && url.pathname === '/api/auth/me'))
      problems.push(`${r.status()} ${url.pathname}`);
  });

  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  const headers = res!.headers();
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['permissions-policy']).toContain('camera=(self)');
  await expect(page.getByRole('heading', { name: 'ScanIn', level: 1 })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Same-origin API under /api, and the health probe.
  expect((await request.get('/healthz')).status()).toBe(200);
  expect((await request.get('/api/auth/me')).status()).toBe(401);
  expect(problems, problems.join('\n')).toEqual([]); // the CSP blocks nothing the app needs
});

test('page navigations to app routes get the app, and a missing script is an error, not HTML', async ({
  page,
  request,
}) => {
  await page.goto('/courses/11111111-1111-4111-8111-111111111111');
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible(); // signed out: the app asks for sign-in
  const missing = await request.get('/assets/nope.js');
  expect(missing.status()).not.toBe(200);
  expect(missing.headers()['content-type']).not.toMatch(/html/);
});
