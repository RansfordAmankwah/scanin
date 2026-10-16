import { randomUUID } from 'node:crypto';
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
  type Student,
} from '../support/fixtures';

/**
 * The face-verification pilot end to end against the real server and the deterministic fake verifier.
 * The capture frames are driven through the app's own API (the browser's fetch, same session) rather
 * than a camera, so the test is about the server pipeline and the lecturer/student screens, not the
 * webcam. An honest student passes; a proxy fails and is forced onto the in-person list, which the
 * lecturer sees only as "verify in person".
 */
const PHONE = { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true } as const;

let lecturerContext: BrowserContext;
let lecturer: Page;
let courseId: string;
let sessionId: string;

const mint = async () =>
  (await api<{ token: string }>(lecturer, 'GET', `/courses/${courseId}/sessions/${sessionId}/qr`))
    .json.token;

async function newPhone(browser: Browser) {
  const context = await browser.newContext({ ...PHONE, baseURL: process.env.SCANIN_E2E_ORIGIN });
  return { context, page: await context.newPage() };
}

/** Full flow for one student, driven through the app's API: check in, enroll, run the face check. */
async function runStudent(page: Page, s: Student, enrollAs: string, captureAs: string) {
  const device = randomUUID();
  const checkIn = await api<{ attendanceId: string; faceCheck?: { required: boolean } }>(
    page,
    'POST',
    '/checkins',
    { token: await mint(), clientAttemptId: randomUUID(), deviceId: device },
  );
  expect(checkIn.json.faceCheck).toEqual({ required: true });
  const attendanceId = checkIn.json.attendanceId;

  await api(page, 'POST', '/me/biometric-consent', {});
  // The lecturer, having checked ID, opens the enrollment for this student (found on the class list).
  const roster = await api<{ unmatchedLinks: Array<{ linkId: string; studentId: string }> }>(
    lecturer,
    'GET',
    `/courses/${courseId}/roster`,
  );
  const linkId = roster.json.unmatchedLinks.find((l) => l.studentId === s.studentId)!.linkId;
  const opened = await api<{ sessionId: string }>(
    lecturer,
    'POST',
    `/courses/${courseId}/face-enrollments`,
    { linkId, idMethod: 'STUDENT_ID_CARD' },
  );
  await api(page, 'POST', `/me/face-enrollments/${opened.json.sessionId}/complete`, {
    frames: [`subject:${enrollAs}`, 'live:true'],
  });

  const challenge = await api<{ challengeId: string }>(page, 'POST', '/me/face-checks/challenge', {
    attendanceId,
  });
  const result = await api<{ outcome: string }>(
    page,
    'POST',
    `/me/face-checks/${challenge.json.challengeId}/frames`,
    { frames: [`subject:${captureAs}`, 'live:true'], deviceId: device },
  );
  return { attendanceId, outcome: result.json.outcome };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  lecturerContext = await browser.newContext({
    baseURL: process.env.SCANIN_E2E_ORIGIN,
    viewport: { width: 1280, height: 800 },
  });
  lecturer = await lecturerContext.newPage();
  await lecturerSignIn(lecturer);
  courseId = state().faceCourseId;
  const created = await api<{ session: { id: string } }>(
    lecturer,
    'POST',
    `/courses/${courseId}/sessions`,
    { title: 'Face pilot lecture' },
  );
  sessionId = created.json.session.id;
  expect(
    (await api(lecturer, 'POST', `/courses/${courseId}/sessions/${sessionId}/start`, {})).status,
  ).toBe(200);
});

test.afterAll(async () => {
  await lecturerContext?.close();
});

test('a proxy fails the face check and is forced onto the in-person list; an honest student passes', async ({
  browser,
}) => {
  const honestCtx = await newPhone(browser);
  const proxyCtx = await newPhone(browser);
  try {
    const honestStudent = newStudent('honest');
    const proxyStudent = newStudent('proxy');
    await registerAndSignIn(honestCtx.page, honestStudent);
    await registerAndSignIn(proxyCtx.page, proxyStudent);

    const honest = await runStudent(honestCtx.page, honestStudent, 'honest', 'honest');
    const proxy = await runStudent(proxyCtx.page, proxyStudent, 'proxy', 'the-attacker');
    expect(honest.outcome).toBe('VERIFIED');
    expect(proxy.outcome).toBe('FAILED');

    // The smallest random sample. The proxy is on the list regardless of the draw.
    await api(lecturer, 'POST', `/courses/${courseId}/sessions/${sessionId}/spot-checks`, {
      size: 1,
    });

    // The lecturer's spot-check screen shows the proxy as "verify in person", never the face reason.
    await lecturer.goto(`/courses/${courseId}/sessions/${sessionId}`);
    const proxyRow = lecturer
      .getByRole('listitem')
      .filter({ hasText: new RegExp(proxyStudent.studentId) });
    await expect(proxyRow).toContainText(/in-person check is required/i);
    const spotText = (
      await lecturer
        .getByRole('heading', { name: 'Spot checks' })
        .locator('xpath=ancestor::section[1]')
        .innerText()
    ).toLowerCase();
    for (const leak of ['face', 'liveness', 'failed', 'exempt'])
      expect(spotText).not.toContain(leak);

    // The pilot metrics card shows totals for the course.
    await lecturer.goto(`/courses/${courseId}`);
    const metrics = lecturer
      .getByRole('heading', { name: 'Face pilot' })
      .locator('xpath=ancestor::section[1]');
    await expect(metrics).toBeVisible();
    await expect(metrics).toContainText('Verified');
    await expectGoodScreen(lecturer, 'face pilot metrics');

    // The honest student sees their own passed check on their privacy page.
    await honestCtx.page.goto('/account/privacy');
    await expect(
      honestCtx.page.getByRole('heading', { name: /face verification & privacy/i }),
    ).toBeVisible();
    await expect(honestCtx.page.getByText('Passed')).toBeVisible();
    await expectGoodScreen(honestCtx.page, 'student privacy');
  } finally {
    await honestCtx.context.close();
    await proxyCtx.context.close();
  }
});
