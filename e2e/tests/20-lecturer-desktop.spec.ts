import { expectGoodScreen } from '../support/checks';
import { expect, lecturerSignIn, state, test } from '../support/fixtures';

test.use({ viewport: { width: 1280, height: 800 } });

test.describe.configure({ mode: 'serial' });

test.describe('a lecturer at a desktop', () => {
  test('signs in with the keyboard alone, and sees where the focus is', async ({ page }) => {
    const l = state().lecturer;
    await page.goto('/');
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();

    const focused = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const style = el ? getComputedStyle(el) : null;
        return {
          label:
            el?.getAttribute('aria-label') ??
            (el as HTMLInputElement | null)?.labels?.[0]?.textContent ??
            el?.textContent?.trim() ??
            '',
          type: (el as HTMLInputElement | null)?.type ?? '',
          outlineStyle: style?.outlineStyle,
          outlineWidth: parseFloat(style?.outlineWidth ?? '0'),
        };
      });

    await page.keyboard.press('Tab');
    expect(await focused()).toMatchObject({ label: 'E-mail', type: 'email' });
    expect((await focused()).outlineStyle).not.toBe('none'); // a visible focus ring
    expect((await focused()).outlineWidth).toBeGreaterThanOrEqual(2);
    await page.keyboard.type(l.email);
    await page.keyboard.press('Tab');
    expect(await focused()).toMatchObject({ label: 'Password', type: 'password' });
    await page.keyboard.type(l.password);
    await page.keyboard.press('Tab');
    expect(await focused()).toMatchObject({ label: 'Sign in', type: 'submit' });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
  });

  test('the courses page, and the course page with its review queue and class list, are accessible', async ({
    page,
  }) => {
    await lecturerSignIn(page);
    await expectGoodScreen(page, 'courses');
    await page.getByRole('link', { name: /^E2E101 / }).click();
    await expect(page.getByRole('heading', { name: /E2E101/ })).toBeVisible();
    await expectGoodScreen(page, 'course page');
    await page.getByRole('link', { name: 'Attendance' }).click();
    await expect(page.getByText('No sessions yet')).toBeVisible();
    await expectGoodScreen(page, 'course attendance');
    await page.getByRole('link', { name: 'Review' }).click();
    await expect(page.getByText('Nothing needs review right now')).toBeVisible();
    await expectGoodScreen(page, 'course review');
    await page.getByRole('link', { name: 'Class list' }).click();
    await expect(page.getByLabel('Spreadsheet or CSV file')).toBeVisible();
    await expectGoodScreen(page, 'course class list');
  });

  test('imports a class list: previews the changes first, then applies them', async ({ page }) => {
    await lecturerSignIn(page);
    await page.getByRole('link', { name: /^E2E101 / }).click();
    await page.getByRole('link', { name: 'Class list' }).click();
    await page
      .getByLabel('Or paste the CSV')
      .fill(
        'student_id,full_name,email\nPREREG001,Pre Registered,pre@e2e.test\nPREREG002,Second Student,\n',
      );
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await expect(
      page.getByText('2 to add · 0 to change · 0 unchanged · 0 not in this file'),
    ).toBeVisible();
    await expectGoodScreen(page, 'class list preview');
    await page.getByRole('button', { name: 'Apply changes' }).click();
    await expect(
      page.getByText('Class list updated: 2 added, 0 changed, 0 removed.'),
    ).toBeVisible();

    // A bad file is refused with an explanation, and nothing is applied.
    await page.getByLabel('Or paste the CSV').fill('name\nnobody');
    await page.getByRole('button', { name: 'Preview changes' }).click();
    await expect(page.getByText(/could not be used/i)).toBeVisible();
  });

  test('creates and starts a session, then shows a large, scannable QR code for the room', async ({
    page,
  }) => {
    await lecturerSignIn(page);
    await page.getByRole('link', { name: /^E2E101 / }).click();
    await page.getByLabel('New session title').fill('Desktop test lecture');
    await page.getByRole('button', { name: 'Create session' }).click();
    await page.getByRole('link', { name: /Desktop test lecture/ }).click();

    await expect(page.getByText('Not started')).toBeVisible();
    await page.getByRole('button', { name: /Start check-in/ }).click();
    await expect(page.getByText('Check-in open')).toBeVisible();
    await expectGoodScreen(page, 'live session');

    // The projector page.
    await page.getByRole('link', { name: 'Show QR code for the room' }).click();
    const qr = page.getByRole('img', { name: /QR code/i });
    await expect(qr).toBeVisible();
    await expect(page.getByText(/Check-in closes in 2\d:\d\d/)).toBeVisible();

    const box = (await qr.boundingBox())!;
    const view = page.viewportSize()!;
    // UX-05: the code fills most of the shorter screen dimension, so it reads from the back of a room.
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(
      Math.min(view.width, view.height) * 0.6,
    );
    expect(Math.abs(box.width - box.height)).toBeLessThan(2); // square, never stretched
    await expectGoodScreen(page, 'projector');
  });

  test('refreshes the code about every 30 seconds without reloading, and can cancel the codes on screen', async ({
    page,
  }) => {
    await lecturerSignIn(page);
    await page.getByRole('link', { name: /^E2E101 / }).click();
    await page.getByRole('link', { name: /Desktop test lecture/ }).click();
    await page.getByRole('link', { name: 'Show QR code for the room' }).click();
    const qr = page.getByRole('img', { name: /QR code/i });
    await expect(qr).toBeVisible();
    const first = await qr.getAttribute('src');

    const mints: number[] = [];
    page.on('request', (r) => /\/qr$/.test(new URL(r.url()).pathname) && mints.push(Date.now()));
    await expect
      .poll(async () => (await qr.getAttribute('src')) !== first, {
        timeout: 45_000,
        intervals: [1_000],
      })
      .toBe(true);
    expect(mints.length).toBeGreaterThanOrEqual(1);

    const before = await qr.getAttribute('src');
    await page.getByRole('button', { name: 'Invalidate shown codes' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Invalidate codes' }).click();
    await expect
      .poll(async () => (await qr.getAttribute('src')) !== before, { timeout: 10_000 })
      .toBe(true); // a fresh code straight away
  });
});
