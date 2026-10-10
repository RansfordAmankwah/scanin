import { expectAccessible, expectNoHorizontalScroll, expectTouchTargets } from '../support/checks';
import { expect, test } from '../support/fixtures';

test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

/** A passing audit only means something if the audit can fail. These plant real defects. */
test.describe('the quality checks can actually fail', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  });

  test('low-contrast text is reported', async ({ page }) => {
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.textContent = 'Faint text that is hard to read';
      p.style.cssText = 'color:#bbbbbb;background:#ffffff';
      document.querySelector('main')!.append(p);
    });
    await expect(expectAccessible(page, 'planted')).rejects.toThrow(/color-contrast/);
  });

  test('an unlabelled form field is reported', async ({ page }) => {
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'text';
      document.querySelector('main')!.append(input);
    });
    await expect(expectAccessible(page, 'planted')).rejects.toThrow(/label/);
  });

  test('sideways overflow is reported', async ({ page }) => {
    await page.evaluate(() => {
      const wide = document.createElement('div');
      wide.style.cssText = 'width:900px;height:10px;background:#000';
      document.querySelector('main')!.append(wide);
    });
    await expect(expectNoHorizontalScroll(page, 'planted')).rejects.toThrow(/wide/);
  });

  test('a tiny button is reported', async ({ page }) => {
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.textContent = 'x';
      b.style.cssText = 'width:16px;height:16px;padding:0';
      document.querySelector('main')!.append(b);
    });
    await expect(expectTouchTargets(page, 'planted')).rejects.toThrow(
      /below the minimum touch size/,
    );
  });

  test('and the real screen passes all of them', async ({ page }) => {
    await expectAccessible(page, 'real');
    await expectNoHorizontalScroll(page, 'real');
    await expectTouchTargets(page, 'real');
  });
});
