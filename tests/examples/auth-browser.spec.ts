/**
 * Example: browser tests that start logged in as a role, with no login steps.
 * auth-browser.setup.ts logged each role in once; `authRole` picks the saved state.
 */

import { test, expect } from '../../src';
import { APP, serveFakeApp } from './support/fake-app';
import { USERS } from './support/auth-users';

test.beforeEach(async ({ context }) => {
    await serveFakeApp(context, USERS);
});

test.describe('Auth — browser roles — admin', () => {
    test.use({ authRole: 'admin' });

    test('[TC-AUTH-001] starts signed in as admin', { tag: ['@TC-AUTH-001'] }, async ({ page }) => {
        await test.step('Step 1: Open a page that needs a session', async () => {
            await page.goto(`${APP}/whoami`);
        });
        await test.step('Step 2: Verify the admin session from setup is used', async () => {
            await expect(page.getByRole('heading')).toHaveText('Signed in as admin@example.test');
        });
    });
});

test.describe('Auth — browser roles — viewer', () => {
    test.use({ authRole: 'viewer' });

    test('[TC-AUTH-002] starts signed in as viewer', { tag: ['@TC-AUTH-002'] }, async ({ page }) => {
        await test.step('Step 1: Open a page that needs a session', async () => {
            await page.goto(`${APP}/whoami`);
        });
        await test.step('Step 2: Verify the viewer session from setup is used', async () => {
            await expect(page.getByRole('heading')).toHaveText('Signed in as viewer@example.test');
        });
    });
});

test.describe('Auth — browser roles — none', () => {
    test('[TC-AUTH-003] without a role the browser starts signed out', { tag: ['@TC-AUTH-003'] }, async ({ page }) => {
        await test.step('Step 1: Open a page that needs a session', async () => {
            await page.goto(`${APP}/whoami`);
        });
        await test.step('Step 2: Verify there is no session', async () => {
            await expect(page.getByRole('heading')).toHaveText('Not signed in');
        });
    });
});
