import { expectGoodScreen } from '../support/checks';
import { expect, newStudent, state, test } from '../support/fixtures';

test.describe('a lecturer signing themselves up', () => {
  test('the sign-up screen is accessible, readable and fits the screen (light and dark)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create a lecturer account' }).click();
    await expect(page.getByRole('heading', { name: 'Create a lecturer account' })).toBeVisible();
    await expectGoodScreen(page, 'lecturer sign-up');
  });

  test('can create an account and sign in, and sees nothing until a course is assigned', async ({
    page,
  }) => {
    const l = newStudent('lec');
    await page.goto('/');
    await page.getByRole('button', { name: 'Create a lecturer account' }).click();
    await page.getByLabel('Full name').fill('Dr Self Signup');
    await page.getByLabel('E-mail').fill(l.email);
    await page.getByLabel('Password').fill(l.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Lecturer account created')).toBeVisible();
    await expectGoodScreen(page, 'lecturer account created');

    await page.getByRole('button', { name: 'Go to sign in' }).click();
    await page.getByLabel('E-mail').fill(l.email);
    await page.getByLabel('Password').fill(l.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByText('No courses yet')).toBeVisible();
    await expect(page.getByText('You are not assigned to any course')).toBeVisible();
    // The seeded course belongs to someone else: this lecturer cannot reach it by address either.
    await page.goto(`/courses/${state().courseId}`);
    await expect(page.getByRole('heading', { name: /E2E101/ })).toHaveCount(0);
  });
});
