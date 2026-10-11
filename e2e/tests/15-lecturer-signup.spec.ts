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
    await expect(page.getByText('Create your first course below')).toBeVisible();
    await expectGoodScreen(page, 'create course form');

    // They create their own term and course, and are assigned to it automatically.
    await page.getByLabel('Course code').fill('SELF101');
    await page.getByLabel('Course title').fill('Self Service Course');
    await page.getByLabel('Term', { exact: true }).selectOption({ label: 'New term…' });
    await page.getByLabel('Term name').fill('Self term');
    await page.getByLabel('Term starts on').fill('2026-09-01');
    await page.getByLabel('Term ends on').fill('2027-06-30');
    await page.getByRole('button', { name: 'Create course' }).click();
    await expect(page.getByRole('link', { name: /SELF101/ })).toBeVisible();
    await page.getByRole('link', { name: /SELF101/ }).click();
    await expect(page.getByRole('heading', { name: /SELF101/ })).toBeVisible();

    // The seeded course belongs to someone else: this lecturer cannot reach it by address either.
    await page.goto(`/courses/${state().courseId}`);
    await expect(page.getByRole('heading', { name: /E2E101/ })).toHaveCount(0);
  });
});
