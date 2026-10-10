import { readFileSync } from 'node:fs';
import { expectGoodScreen } from '../support/checks';
import { expect, newStudent, state, test } from '../support/fixtures';

// A typical Android phone, with touch.
test.use({
  viewport: { width: 360, height: 740 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});

test.describe('a student on a phone', () => {
  test('sign-in and sign-up screens are accessible, readable and fit the screen (light and dark)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
    await expectGoodScreen(page, 'sign in');

    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByLabel('Student ID')).toBeVisible();
    await expectGoodScreen(page, 'create account');
  });

  test('registers with a confirmation step, verifies their e-mail from the link, and signs in', async ({
    page,
  }) => {
    const s = newStudent('phone');
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByLabel('Student ID').fill(s.studentId.toLowerCase());
    await page.getByLabel('Full name').fill(`  ${s.fullName}  `);
    await page.getByLabel('School e-mail').fill(s.email);
    await page.getByLabel('Password').fill(s.password);
    await page.getByRole('button', { name: 'Review details' }).click();

    // Nothing is created until they confirm exactly what will be stored.
    await expect(page.getByRole('heading', { name: 'Is this correct?' })).toBeVisible();
    await expect(
      page
        .getByText(s.studentId.toLowerCase(), { exact: true })
        .or(page.getByText(s.studentId, { exact: true })),
    ).toBeVisible();
    await expect(
      page.getByText('You cannot change your student ID or name afterwards'),
    ).toBeVisible();
    await expectGoodScreen(page, 'confirm details');
    const early = await page.request.post('/api/auth/login', {
      data: { email: s.email, password: s.password },
      headers: { origin: page.url().replace(/\/[^/]*$/, ''), 'x-requested-with': 'scanin' },
    });
    expect(early.status()).toBe(401); // the account does not exist yet

    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Account created')).toBeVisible();

    // The console mailer printed the verification link; follow it as the student would.
    await expect
      .poll(() => readFileSync(state().logPath, 'utf8').includes(`verification for ${s.email}`), {
        timeout: 10_000,
      })
      .toBe(true);
    const log = readFileSync(state().logPath, 'utf8');
    const link = new RegExp(
      `verification for ${s.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (\\S+)`,
    ).exec(log)![1]!;
    await page.goto(link);
    await expect(page.getByText('E-mail verified')).toBeVisible();
    expect(page.url()).not.toContain('#t='); // the single-use token is removed from the address bar
    await expectGoodScreen(page, 'e-mail verified');

    await page.goto('/');
    await page.getByLabel('E-mail').fill(s.email);
    await page.getByLabel('Password').fill(s.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Check in to class' })).toBeVisible();
    await expect(page.getByText(s.fullName)).toBeVisible();
  });

  test('the check-in home screen is clear, accessible, and works with a touch screen', async ({
    page,
  }) => {
    const s = newStudent('home');
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByLabel('Student ID').fill(s.studentId);
    await page.getByLabel('Full name').fill(s.fullName);
    await page.getByLabel('School e-mail').fill(s.email);
    await page.getByLabel('Password').fill(s.password);
    await page.getByRole('button', { name: 'Review details' }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Go to sign in' }).click();
    await page.getByLabel('E-mail').fill(s.email);
    await page.getByLabel('Password').fill(s.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).tap();

    await expect(page.getByRole('heading', { name: 'Check in to class' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start camera' })).toBeVisible();
    await expect(page.getByText("phone's normal camera app")).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My attendance' })).toBeVisible();
    await expectGoodScreen(page, 'student home');
  });

  test('signing out ends the session on the server', async ({ page, request }) => {
    const s = newStudent('out');
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await page.getByLabel('Student ID').fill(s.studentId);
    await page.getByLabel('Full name').fill(s.fullName);
    await page.getByLabel('School e-mail').fill(s.email);
    await page.getByLabel('Password').fill(s.password);
    await page.getByRole('button', { name: 'Review details' }).click();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Go to sign in' }).click();
    await page.getByLabel('E-mail').fill(s.email);
    await page.getByLabel('Password').fill(s.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Check in to class' })).toBeVisible();

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === '__Host-sid')!;
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    await page.getByRole('button', { name: 'Sign out' }).tap();
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();

    // The old cookie value no longer works anywhere.
    const reuse = await request.get('/api/auth/me', {
      headers: { cookie: `__Host-sid=${session.value}` },
    });
    expect(reuse.status()).toBe(401);
  });
});
