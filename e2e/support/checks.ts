import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** The page must never scroll sideways: tables become stacked cards on narrow screens. */
export async function expectNoHorizontalScroll(page: Page, label = ''): Promise<void> {
  // Compare with the width the device really has. On a phone the browser widens its own
  // "window" to fit overflowing content, so window.innerWidth cannot be trusted for this.
  const width = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate(
    (viewport) => ({
      scroll: document.documentElement.scrollWidth,
      wide: [...document.querySelectorAll('body *')]
        .filter(
          (el) =>
            (el as HTMLElement).offsetParent !== null &&
            el.getBoundingClientRect().right > viewport + 1,
        )
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`.slice(0, 60)),
    }),
    width,
  );
  expect(
    overflow.scroll,
    `${label} page is ${overflow.scroll}px wide on a ${width}px screen; overflowing: ${overflow.wide.join(', ')}`,
  ).toBeLessThanOrEqual(width + 1);
}

/**
 * Controls follow the design system's --control-height: 40px with a mouse, 44px on touch screens.
 * Inline text links need at least 24px (WCAG 2.5.8).
 */
export async function expectTouchTargets(page: Page, label = ''): Promise<void> {
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const touch = matchMedia('(pointer: coarse)').matches;
    const control = touch ? 44 : 40;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      );
    };
    for (const el of document.querySelectorAll(
      'button, input:not([type=hidden]), select, textarea, a[href]',
    )) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const isLink = el.tagName === 'A' && !el.classList.contains('btn');
      const isCheck = el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type);
      // A checkbox is operated through its (large) label; the box itself only needs to be 24px.
      const need = isLink || isCheck ? 24 : control;
      if (r.height + 0.5 < need || (!isLink && r.width + 0.5 < Math.min(need, control))) {
        out.push(
          `${el.tagName.toLowerCase()} "${(el.textContent || (el as HTMLInputElement).name || el.id || '').trim().slice(0, 30)}" is ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }
    return out;
  });
  expect(small, `${label} controls below the minimum touch size`).toEqual([]);
}

/** axe-core in a real browser, so colour contrast and target size are measured, not skipped. */
export async function expectAccessible(page: Page, label = ''): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}) ${v.help}: ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
  expect(summary, `${label} accessibility violations`).toEqual([]);
}

/** Runs the whole battery in light and dark colour schemes. */
export async function expectGoodScreen(page: Page, label: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page, `${label} [${scheme}]`);
    // Opt-in: SCANIN_E2E_SHOTS=<dir> saves a picture of every audited screen, for eyeballing.
    if (process.env.SCANIN_E2E_SHOTS) {
      const name = `${label}-${scheme}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      await page.screenshot({
        path: `${process.env.SCANIN_E2E_SHOTS}/${name}.png`,
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await expectNoHorizontalScroll(page, label);
  await expectTouchTargets(page, label);
}
