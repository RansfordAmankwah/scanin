import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expectGoodScreen } from '../support/checks';
import { launchWithFakeCamera, qrVideoFromProjector } from '../support/camera';
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

/** One class session shared by the whole journey, driven the way a lecturer would. */
let lecturerPage: Page;
let lecturerContext: BrowserContext;
let courseId: string;
let sessionId: string;

const mint = async () =>
  (
    await api<{ token: string; qrUrl: string }>(
      lecturerPage,
      'GET',
      `/courses/${courseId}/sessions/${sessionId}/qr`,
    )
  ).json;

/** Opens a code link as a fresh page load (a hash-only change would not reload the app). */
async function openCode(page: Page, url: string) {
  await page.goto('about:blank');
  await page.goto(url);
}

async function newPhone(browser: Browser, permissions: string[] = []) {
  const context = await browser.newContext({
    ...PHONE,
    baseURL: process.env.SCANIN_E2E_ORIGIN,
    permissions,
  });
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
  courseId = state().courseId;
  const created = await api<{ session: { id: string } }>(
    lecturerPage,
    'POST',
    `/courses/${courseId}/sessions`,
    { title: 'Scan journey lecture' },
  );
  expect(created.status).toBe(201);
  sessionId = created.json.session.id;
  const started = await api(
    lecturerPage,
    'POST',
    `/courses/${courseId}/sessions/${sessionId}/start`,
    {},
  );
  expect(started.status).toBe(200);
});

test.afterAll(async () => {
  await lecturerContext?.close();
});

test('a student scans the projected code with the phone camera and is checked in', async () => {
  // The lecturer's projector page shows the code; its image is what the "camera" films.
  const projector = await lecturerContext.newPage();
  await projector.goto(`/present/${courseId}/${sessionId}`);
  const video = await qrVideoFromProjector(projector);

  const camBrowser = await launchWithFakeCamera(video);
  const context = await camBrowser.newContext({
    ...PHONE,
    baseURL: process.env.SCANIN_E2E_ORIGIN,
  });
  const page = await context.newPage();
  try {
    const s = newStudent('cam');
    await registerAndSignIn(page, s);
    await page.getByRole('button', { name: 'Start camera' }).tap();
    await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/E2E101 End to End Testing · Scan journey lecture/)).toBeVisible();
    await expectGoodScreen(page, 'checked in');

    await page.getByRole('button', { name: 'Done' }).tap();
    await page.getByRole('link', { name: 'View attendance' }).tap(); // the course's own history
    await expect(page.getByText('Scan journey lecture')).toBeVisible();
  } finally {
    await camBrowser.close();
    await projector.close();
  }
});

test('opening the code as a link while signed out asks for sign-in, then checks the student in', async ({
  browser,
}) => {
  const s = newStudent('link');
  const { page, context } = await newPhone(browser);
  try {
    // Create the account first, then return signed out with only the link.
    await registerAndSignIn(page, s);
    await page.getByRole('button', { name: 'Sign out' }).tap();
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();

    const { qrUrl } = await mint();
    await page.goto(qrUrl);
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
    await page.getByLabel('E-mail').fill(s.email);
    await page.getByLabel('Password').fill(s.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 15_000 });
    expect(page.url()).not.toContain('#t='); // the code is not left in the address bar

    // Scanning again is harmless and says so.
    await openCode(page, (await mint()).qrUrl);
    await expect(page.getByText("You're already checked in")).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a dropped connection is retried safely: one record, no duplicate', async ({ browser }) => {
  const s = newStudent('flaky');
  const { page, context } = await newPhone(browser);
  try {
    await registerAndSignIn(page, s);
    const { qrUrl } = await mint();

    let attempts = 0;
    await page.route('**/api/checkins', async (route) => {
      attempts += 1;
      if (attempts === 1) await route.abort('connectionreset');
      else await route.continue();
    });
    await openCode(page, qrUrl);
    await expect(page.getByText("Couldn't reach the server")).toBeVisible({ timeout: 15_000 });
    await expectGoodScreen(page, 'offline');
    await page.getByRole('button', { name: 'Try again' }).tap();
    await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 15_000 });
    expect(attempts).toBe(2);

    const roster = await api<{ rows: { studentId: string }[] }>(
      lecturerPage,
      'GET',
      `/courses/${courseId}/sessions/${sessionId}/attendance`,
    );
    const mine = JSON.stringify(roster.json).split(s.studentId).length - 1;
    expect(mine).toBeGreaterThanOrEqual(1);
    expect(roster.status).toBe(200);
  } finally {
    await context.close();
  }
});

test('with the camera blocked, the student is told what to do instead', async ({ browser }) => {
  const { page, context } = await newPhone(browser); // no camera permission granted
  try {
    await registerAndSignIn(page, newStudent('nocam'));
    await context.clearPermissions();
    await page.getByRole('button', { name: 'Start camera' }).tap();
    await expect(
      page.getByText(/Camera access is blocked|No camera available/).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/normal camera app/).first()).toBeVisible();
    await expectGoodScreen(page, 'camera problem');
  } finally {
    await context.close();
  }
});

test('two student accounts on the same browser: the second cannot check in for the same class', async ({
  browser,
}) => {
  const first = newStudent('swapa');
  const second = newStudent('swapb');
  const { page, context } = await newPhone(browser);
  try {
    // Account A signs in on this browser and checks in.
    await registerAndSignIn(page, first);
    await openCode(page, (await mint()).qrUrl);
    await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 15_000 });

    // Account B signs in on the very same browser (same stored device id) and scans the same code.
    await page.getByRole('button', { name: 'Sign out' }).tap();
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
    await registerAndSignIn(page, second);
    await openCode(page, (await mint()).qrUrl);
    await expect(page.getByText('Device error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/already used by another student/)).toBeVisible();
    await expectGoodScreen(page, 'device error');
    // The message does not say who the other student was.
    await expect(page.getByText(first.fullName)).toHaveCount(0);
    await expect(page.getByText(first.studentId)).toHaveCount(0);

    // The lecturer's view, from the real server: only A has attendance; B is a rejected scan.
    const roster = JSON.stringify(
      (await api(lecturerPage, 'GET', `/courses/${courseId}/sessions/${sessionId}/attendance`))
        .json,
    );
    expect(roster).toContain(first.studentId);
    expect(roster).not.toContain(second.studentId);
    const scans = JSON.stringify(
      (await api(lecturerPage, 'GET', `/courses/${courseId}/sessions/${sessionId}/scans`)).json,
    );
    expect(scans).toContain('REJECTED_DEVICE_REUSED');
  } finally {
    await context.close();
  }
});

test('the lecturer sees the counts, the scan history, can invalidate a record and download a CSV', async () => {
  const page = lecturerPage;
  await page.goto(`/courses/${courseId}/sessions/${sessionId}`);
  await expect(page.getByText('Check-in open')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Test (cam|link|flaky)/ }).first()).toBeVisible();
  await expect(page.getByText('Present (all)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scan history' })).toBeVisible();
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expectGoodScreen(page, `session page ${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // Invalidate the "link" student with a written reason; they then see that on their phone.
  const row = page.getByRole('row').filter({ hasText: /Test link/ });
  await row.getByRole('button', { name: 'Invalidate…' }).click();
  const studentId = (await row.getByRole('cell').first().innerText()).trim();
  const form = page.getByRole('form', { name: `Invalidate ${studentId}` });
  await form.getByRole('textbox').fill('Was not in the room, confirmed with the class.');
  await form.getByRole('button', { name: 'Invalidate attendance' }).click();
  await expect(page.getByRole('row').filter({ hasText: /Test link/ })).toContainText(
    /Invalidated/i,
  );

  // A CSV export downloads and has a header row.
  await page.getByRole('button', { name: 'Create export' }).click();
  const link = page.getByRole('link', { name: /^Download / });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const raw = readFileSync((await download.path())!, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // the file starts with a byte-order mark for Excel
  expect(text.split(/\r?\n/)[0]).toBe('Report,Attendance report');
  expect(text).toContain(studentId);
});

test('after the lecturer cancels shown codes, an old code is refused; after End, nobody can check in', async ({
  browser,
}) => {
  const { page, context } = await newPhone(browser);
  try {
    await registerAndSignIn(page, newStudent('late'));
    const old = await mint();

    await api(lecturerPage, 'POST', `/courses/${courseId}/sessions/${sessionId}/qr/invalidate`, {});
    await openCode(page, old.qrUrl);
    await expect(page.getByText('That code was cancelled')).toBeVisible({ timeout: 15_000 });

    await openCode(page, (await mint()).qrUrl); // a fresh code works
    await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 15_000 });

    const ended = await api(
      lecturerPage,
      'POST',
      `/courses/${courseId}/sessions/${sessionId}/end`,
      {},
    );
    expect(ended.status).toBe(200);

    const { page: p2, context: c2 } = await newPhone(browser);
    try {
      await registerAndSignIn(p2, newStudent('after'));
      await openCode(p2, old.qrUrl);
      await expect(p2.getByText(/This class has ended|That code was cancelled/)).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await c2.close();
    }
  } finally {
    await context.close();
  }
});
