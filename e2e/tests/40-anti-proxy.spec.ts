import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expectGoodScreen } from '../support/checks';
import {
  api,
  expect,
  lecturerSignIn,
  newStudent,
  state,
  test,
  type Student,
} from '../support/fixtures';

/**
 * The anti-proxy workflow end to end, in a real browser against the real server:
 * headcount -> spot check -> "not found" -> student reply -> lecturer decision.
 */
test.describe.configure({ mode: 'serial' });

let lecturerContext: BrowserContext;
let lecturer: Page;
let courseId: string;
let sessionId: string;
let target: Student;
let targetContext: BrowserContext;
const crowd: Student[] = [];
const contexts: BrowserContext[] = [];

const sessionUrl = () => `/courses/${courseId}/sessions/${sessionId}`;

async function registerAndCheckIn(browser: Browser, s: Student): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: process.env.SCANIN_E2E_ORIGIN,
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto('/');
  const made = await api(page, 'POST', '/auth/register/commit', {
    studentId: s.studentId,
    fullName: s.fullName,
    email: s.email,
    password: s.password,
    confirmed: true,
  });
  expect(made.status).toBe(201);
  const login = await api(page, 'POST', '/auth/login', { email: s.email, password: s.password });
  expect(login.status).toBe(200);
  const code = await api<{ token: string }>(
    lecturer,
    'GET',
    `/courses/${courseId}/sessions/${sessionId}/qr`,
  );
  const checkin = await api(page, 'POST', '/checkins', {
    token: code.json.token,
    clientAttemptId: randomUUID(),
    deviceId: randomUUID(),
  });
  expect(checkin.status).toBe(201);
  await page.close();
  return context;
}

test.beforeAll(async ({ browser }) => {
  lecturerContext = await browser.newContext({
    baseURL: process.env.SCANIN_E2E_ORIGIN,
    viewport: { width: 1280, height: 900 },
  });
  lecturer = await lecturerContext.newPage();
  await lecturerSignIn(lecturer);
  courseId = state().courseId;
  const created = await api<{ session: { id: string } }>(
    lecturer,
    'POST',
    `/courses/${courseId}/sessions`,
    {
      title: 'Week 5 lecture',
    },
  );
  sessionId = created.json.session.id;
  expect(
    (await api(lecturer, 'POST', `/courses/${courseId}/sessions/${sessionId}/start`, {})).status,
  ).toBe(200);

  // Six students are recorded present (each on their own phone); the lecturer counts only two in the room.
  for (let i = 0; i < 6; i++) {
    const s = newStudent(`ap${i}`);
    crowd.push(s);
    const context = await registerAndCheckIn(browser, s);
    if (i === 0) {
      target = s;
      targetContext = context;
    }
  }
});

test.afterAll(async () => {
  await lecturerContext?.close();
  for (const c of contexts) await c.close().catch(() => undefined);
});

test('the lecturer counts the room and is told, plainly, that the totals do not match', async () => {
  await lecturer.goto(sessionUrl());
  await expect(lecturer.getByRole('heading', { name: 'Room headcount' })).toBeVisible();
  await expect(lecturer.getByText('No headcount yet')).toBeVisible();

  // A bad number is refused on the screen, before anything is sent.
  await lecturer.getByLabel('People in the room').fill('-4');
  await lecturer.getByRole('button', { name: 'Save headcount' }).click();
  await expect(lecturer.getByRole('alert')).toContainText('whole number from 0 to 2000');

  await lecturer.getByLabel('People in the room').fill('2');
  await lecturer.getByRole('button', { name: 'Save headcount' }).click();
  await expect(lecturer.getByText('Headcount saved.')).toBeVisible();
  await expect(lecturer.getByText('Review recommended')).toBeVisible();
  await expect(lecturer.getByText('+4')).toBeVisible();
  await expect(lecturer.getByText(/can be innocent/i)).toBeVisible();
  // A signal, not a verdict: every student is still present.
  await expect(lecturer.getByText('✓ Present')).toHaveCount(6);
  await expectGoodScreen(lecturer, 'headcount');

  // Correcting it keeps the history.
  await lecturer.getByLabel('Correct the headcount').fill('3');
  await lecturer.getByLabel(/why are you changing it/i).fill('Recounted');
  await lecturer.getByRole('button', { name: 'Save correction' }).click();
  await expect(lecturer.getByText(/correction 1; it was 2/i)).toBeVisible();
});

test('a spot check picks students at random and records what the checker found', async () => {
  await lecturer.goto(sessionUrl());
  await lecturer.getByLabel(/how many students/i).fill('6'); // everyone, so the target is certainly included
  await lecturer.getByRole('button', { name: 'Choose students to check' }).click();
  await expect(lecturer.getByText(/6 to check/)).toBeVisible();

  const label = `${target.studentId} ${target.fullName}`;
  const card = lecturer.getByLabel(label, { exact: true });
  await expect(card).toContainText('Picked at random');

  await card.getByRole('button', { name: 'Not found in the room' }).click();
  await card.getByRole('button', { name: 'Save result' }).click();
  await expect(card.getByText(/at least 10 characters/i)).toBeVisible(); // an explanation is required
  await card
    .getByLabel(/what did you find/i)
    .fill('Called the name twice and asked the row; no answer.');
  await card.getByRole('button', { name: 'Save result' }).click();
  await expect(card.getByText('Not found in the room').first()).toBeVisible();

  // Someone else is verified.
  const other = crowd[1]!;
  const otherCard = lecturer.getByLabel(`${other.studentId} ${other.fullName}`, { exact: true });
  await otherCard.getByRole('button', { name: 'Verified in person' }).click();
  await otherCard.getByLabel(/how did you verify/i).selectOption('STUDENT_ID_CARD');
  await otherCard.getByRole('button', { name: 'Save result' }).click();
  await expect(otherCard.getByText('Verified in person').first()).toBeVisible();

  // A review is open, and the student's attendance still counts.
  await expect(lecturer.getByRole('heading', { name: 'Records under review' })).toBeVisible();
  await expect(lecturer.getByText('✓ Present')).toHaveCount(6);
  await expectGoodScreen(lecturer, 'spot checks and review');
});

test('the student is told only that the record is being reviewed, and can reply', async () => {
  const page = await targetContext.newPage();
  await page.goto('/'); // this browser is already signed in as the student
  await expect(page.getByText('Your lecturer is reviewing this record')).toBeVisible();
  await expect(page.getByText(/still counts as present/i)).toBeVisible();
  const text = (await page.locator('body').innerText()).toLowerCase();
  for (const hidden of ['spot check', 'sampled', 'proxy', 'headcount', 'not found'])
    expect(text).not.toContain(hidden);
  await expectGoodScreen(page, 'student review notice');

  await page.getByLabel('Your reply').fill('I was in the lab next door; my lecturer can confirm.');
  await page.getByRole('button', { name: 'Send reply' }).tap();
  await expect(page.getByText('Your reply was sent to your lecturer.')).toBeVisible();
  await page.close();
});

test('the lecturer reads the reply, decides with a written reason, and the numbers follow', async () => {
  await lecturer.goto(sessionUrl());
  const review = lecturer.getByLabel(`Review of ${target.studentId} ${target.fullName}`, {
    exact: true,
  });
  await expect(
    review.getByText('I was in the lab next door; my lecturer can confirm.'),
  ).toBeVisible();

  await review.getByRole('button', { name: 'Invalidate this attendance' }).click();
  await review.getByLabel('Reason', { exact: true }).selectOption('IDENTITY_ENROLLMENT_MISMATCH');
  await review.getByLabel(/your reason/i).fill('Could not be matched to anyone in the room.');
  await review.getByRole('button', { name: 'Close the review' }).click();

  await expect(lecturer.getByText('Review closed: record invalidated')).toBeVisible();
  await expect(lecturer.getByText('✕ Invalidated')).toHaveCount(1);
  await expect(lecturer.getByText('✓ Present')).toHaveCount(5);

  // The headcount panel followed without anyone recalculating anything.
  const panel = lecturer
    .getByRole('heading', { name: 'Room headcount' })
    .locator('xpath=ancestor::section[1]');
  await expect(panel).toContainText('Students recorded present');
  await expect(panel.getByText('5', { exact: true }).first()).toBeVisible();
});

test('the student sees the outcome in the same plain way', async () => {
  const page = await targetContext.newPage();
  await page.goto('/'); // this browser is already signed in as the student
  await expect(
    page.getByText('Your lecturer reviewed this record. Ask them if you have questions.'),
  ).toBeVisible();
  await expect(page.getByLabel('Your reply')).toHaveCount(0);
  await page.close();
});

test('the whole session page works on a phone screen', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: process.env.SCANIN_E2E_ORIGIN,
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  contexts.push(context);
  const page = await context.newPage();
  await lecturerSignIn(page);
  await page.goto(sessionUrl());
  await expect(page.getByRole('heading', { name: 'Room headcount' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Spot checks' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Records under review' })).toBeVisible();
  await expectGoodScreen(page, 'anti-proxy at 360px');
  await page.setViewportSize({ width: 768, height: 1000 });
  await expectGoodScreen(page, 'anti-proxy at 768px');
});
