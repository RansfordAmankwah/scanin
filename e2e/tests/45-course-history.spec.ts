import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expectGoodScreen } from '../support/checks';
import {
  api,
  expect,
  lecturerSignIn,
  newStudent,
  registerAndSignIn,
  state,
  test,
} from '../support/fixtures';

const PHONE = {
  viewport: { width: 360, height: 740 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
} as const;

/**
 * Two courses taught by one lecturer. A student who checks in to one sees only that one; after
 * checking in to both, each course keeps its own sessions and its own numbers.
 */
let lecturerContext: BrowserContext;
let lecturerPage: Page;
const course = { a: '', b: '' };
const session = { a: '', b: '' };
const stamp = Date.now().toString(36).toUpperCase();
const codeB = `HIS${stamp}`.slice(0, 10);

const mintLink = async (which: 'a' | 'b') =>
  (
    await api<{ qrUrl: string }>(
      lecturerPage,
      'GET',
      `/courses/${course[which]}/sessions/${session[which]}/qr`,
    )
  ).json.qrUrl;

async function checkIn(page: Page, which: 'a' | 'b') {
  await page.goto('about:blank');
  await page.goto(await mintLink(which));
  await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 20_000 });
}

async function newPhone(browser: Browser) {
  const context = await browser.newContext({ ...PHONE, baseURL: process.env.SCANIN_E2E_ORIGIN });
  return { context, page: await context.newPage() };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  lecturerContext = await browser.newContext({
    baseURL: process.env.SCANIN_E2E_ORIGIN,
    viewport: { width: 1280, height: 800 },
  });
  lecturerPage = await lecturerContext.newPage();
  await lecturerSignIn(lecturerPage);
  course.a = state().courseId;

  const year = new Date().getFullYear();
  const made = await api<{ course: { id: string } }>(lecturerPage, 'POST', '/courses', {
    code: codeB,
    title: 'Second course',
    newTerm: {
      name: `History ${stamp}`,
      startsOn: `${year}-01-01`,
      endsOn: `${year}-12-31`,
    },
  });
  expect(made.status).toBe(201);
  course.b = made.json.course.id;

  for (const which of ['a', 'b'] as const) {
    const created = await api<{ session: { id: string } }>(
      lecturerPage,
      'POST',
      `/courses/${course[which]}/sessions`,
      { title: `History session ${which.toUpperCase()}` },
    );
    expect(created.status).toBe(201);
    session[which] = created.json.session.id;
    const started = await api(
      lecturerPage,
      'POST',
      `/courses/${course[which]}/sessions/${session[which]}/start`,
      {},
    );
    expect(started.status).toBe(200);
  }
});

test.afterAll(async () => {
  await lecturerContext?.close();
});

test('a student sees only the courses they have attended, and cannot open another by address', async ({
  browser,
}) => {
  const { context, page } = await newPhone(browser);
  try {
    const s = newStudent('hist');
    await registerAndSignIn(page, s);
    await checkIn(page, 'a');

    await page.goto('/my/courses');
    await expect(page.getByRole('heading', { name: 'My courses', level: 1 })).toBeVisible();
    await expect(page.getByRole('article', { name: /E2E101/ })).toBeVisible();
    await expect(page.getByRole('article', { name: new RegExp(codeB) })).toHaveCount(0);
    await expectGoodScreen(page, 'my courses');

    // A course the student has no record in is indistinguishable from one that does not exist.
    await page.goto(`/my/courses/${course.b}`);
    await expect(page.getByRole('heading', { name: 'Course not found', level: 1 })).toBeVisible();
    await expect(page.getByText('History session B')).toHaveCount(0);

    // Their own course: breadcrumbs lead back up, the session is listed, and details open.
    await page.goto('/my/courses');
    await page.getByRole('link', { name: 'End to End Testing' }).click();
    await expect(page.getByRole('heading', { name: /E2E101/, level: 1 })).toBeVisible();
    await expect(page.getByText('History session A')).toBeVisible();
    await expect(page.getByText('History session B')).toHaveCount(0);
    await page.getByRole('button', { name: /Show details for History session A/ }).click();
    await expect(page.getByText(/Recorded by:/)).toBeVisible();
    await expectGoodScreen(page, 'course history');

    // After checking in to the second course, each keeps its own session.
    await checkIn(page, 'b');
    await page.goto('/my/courses');
    await expect(page.getByRole('article')).toHaveCount(2);
    await page.getByRole('link', { name: 'Second course' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(codeB), level: 1 })).toBeVisible();
    await expect(page.getByText('History session B')).toBeVisible();
    await expect(page.getByText('History session A')).toHaveCount(0);

    // The lecturer sees the same student in each course, one course at a time.
    for (const which of ['a', 'b'] as const) {
      await lecturerPage.goto(`/courses/${course[which]}/attendance`);
      await lecturerPage.getByRole('button', { name: 'By student' }).click();
      const row = lecturerPage.getByRole('row').filter({ hasText: s.studentId });
      await expect(row).toBeVisible();
      await row.getByRole('link', { name: s.fullName }).click();
      await expect(lecturerPage.getByRole('heading', { name: s.fullName, level: 1 })).toBeVisible();
      await expect(
        lecturerPage.getByText(`History session ${which.toUpperCase()}`, { exact: true }),
      ).toBeVisible();
      await expect(
        lecturerPage.getByText(`History session ${which === 'a' ? 'B' : 'A'}`, { exact: true }),
      ).toHaveCount(0);
      if (which === 'a') await expectGoodScreen(lecturerPage, 'one student in one course');
    }
  } finally {
    await context.close();
  }
});

test('a lecturer sees the course workspace, and another lecturer cannot reach it', async ({
  browser,
}) => {
  await lecturerPage.goto('/');
  await expect(lecturerPage.getByRole('article', { name: new RegExp(codeB) })).toBeVisible();
  await lecturerPage.getByRole('link', { name: new RegExp(`^${codeB} `) }).click();
  await expect(
    lecturerPage.getByRole('heading', { name: new RegExp(codeB), level: 1 }),
  ).toBeVisible();
  await expect(lecturerPage.getByText('History session B')).toBeVisible();
  await lecturerPage.getByRole('link', { name: 'Attendance' }).click();
  for (const width of [360, 768, 1280]) {
    await lecturerPage.setViewportSize({ width, height: 900 });
    await expectGoodScreen(lecturerPage, `course attendance ${width}px`);
  }
  await lecturerPage.setViewportSize({ width: 1280, height: 800 });

  // A student cannot open the lecturer's pages or data by address.
  const { context, page } = await newPhone(browser);
  try {
    await registerAndSignIn(page, newStudent('nosy'));
    const summary = await api(page, 'GET', `/courses/${course.a}/attendance-summary`);
    expect(summary.status).toBeGreaterThanOrEqual(403);
    expect(summary.status).toBeLessThanOrEqual(404);
    const mine = await api(page, 'GET', `/me/courses/${course.a}`);
    expect(mine.status).toBe(404);
  } finally {
    await context.close();
  }
});
