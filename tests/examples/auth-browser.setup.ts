/**
 * Setup for tests/examples/auth-browser.spec.ts: logs each role in once and
 * saves its browser state, so the tests start logged in. In a real project
 * this is tests/e2e/auth.setup.ts (`npx propmaster auth-setup` creates it).
 */

import { expect, setupAuth } from '../../src';
import { APP, serveFakeApp } from './support/fake-app';
import { EXAMPLE_AUTH, USERS } from './support/auth-users';

setupAuth({
    // The roles live in this project's `use: { auth }` block, so name them here.
    roles: Object.keys(EXAMPLE_AUTH.roles),
    login: async ({ page, context }, { username, password }) => {
        await serveFakeApp(context, USERS);
        await page.goto(`${APP}/login`);
        await page.getByLabel('Email').fill(username!);
        await page.getByLabel('Password').fill(password!);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    },
});
