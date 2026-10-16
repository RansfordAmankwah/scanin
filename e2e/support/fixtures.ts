import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

export interface E2EState {
  origin: string;
  courseId: string;
  /** A second course with the face-verification pilot turned on. */
  faceCourseId: string;
  logPath: string;
  lecturer: { email: string; password: string };
}

export const state = (): E2EState =>
  JSON.parse(readFileSync(process.env.SCANIN_E2E_STATE as string, 'utf8')) as E2EState;

/** The tests run against whatever port global setup chose. */
export const test = base.extend({
  baseURL: async ({ browserName: _browserName }, use) => {
    await use(process.env.SCANIN_E2E_ORIGIN as string);
  },
});

export { expect };

let counter = 0;
/** A unique student for each test that needs one. */
export function newStudent(label = 'student') {
  counter += 1;
  const stamp = `${Date.now().toString(36)}${counter}`;
  return {
    studentId: `E2E${stamp}`.toUpperCase(),
    fullName: `Test ${label} ${counter}`,
    email: `${label}${stamp}@e2e.test`,
    password: 'a-long-e2e-password-1',
  };
}

export type Student = ReturnType<typeof newStudent>;

export async function register(page: Page, s: Student): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Student ID').fill(s.studentId);
  await page.getByLabel('Full name').fill(s.fullName);
  await page.getByLabel('School e-mail').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Review details' }).click();
  await expect(page.getByRole('heading', { name: 'Is this correct?' })).toBeVisible();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Account created')).toBeVisible();
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  if (
    await page
      .getByRole('button', { name: 'Go to sign in' })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole('button', { name: 'Go to sign in' }).click();
  }
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export async function registerAndSignIn(page: Page, s: Student): Promise<void> {
  await register(page, s);
  await page.getByRole('button', { name: 'Go to sign in' }).click();
  await page.getByLabel('E-mail').fill(s.email);
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check in to class' })).toBeVisible();
}

export async function lecturerSignIn(page: Page): Promise<void> {
  const l = state().lecturer;
  await signIn(page, l.email, l.password);
  await expect(page.getByRole('heading', { name: 'Your courses' })).toBeVisible();
}

/** Browser-side API call with the same-origin headers the app uses. */
export async function api<T = unknown>(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, {
        method,
        headers: {
          'X-Requested-With': 'scanin',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}
