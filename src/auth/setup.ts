/**
 * Per-role browser login: log each role in once in a setup project, save its
 * browser state, and let tests start already logged in with
 * `test.use({ authRole: 'admin' })`.
 *
 *   // tests/e2e/auth.setup.ts
 *   import { setupAuth } from '@inluxc/propmaster';
 *
 *   setupAuth({
 *       login: async ({ page }, { username, password }) => {
 *           await page.goto('/login');
 *           await page.getByLabel('Email').fill(username!);
 *           await page.getByLabel('Password').fill(password!);
 *           await page.getByRole('button', { name: 'Sign in' }).click();
 *           await page.waitForURL('**\/dashboard');
 *       },
 *   });
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import type { AuthConfig } from '../config/schema.js';
import { ConfigLoader } from '../config/loader.js';
import { test } from '../fixtures/index.js';
import { authStateFile } from './state-file.js';
import { resolveRole, roleName, type ResolvedRole } from './token-manager.js';

export interface SetupAuthOptions {
    /**
     * Your app's login steps for one role. Use the credentials from config
     * (`auth.roles.<role>`), never hard-coded ones.
     */
    login: (fixtures: { page: Page; context: BrowserContext }, role: ResolvedRole) => Promise<void>;
    /**
     * Roles to log in. Default: every role in `auth.roles` from environments.json
     * / PW_AUTH_*, or the default role. Pass them when the roles are only set in
     * a project's `use` block, which isn't known until the tests run.
     */
    roles?: string[];
    /** Reuse a saved state younger than this many minutes instead of logging in again (default: always log in). */
    maxAgeMinutes?: number;
    /** Auth config (default: loaded from environments.json / PW_AUTH_* like the fixtures). */
    config?: AuthConfig;
}

function loadAuthConfig(): AuthConfig {
    try {
        return new ConfigLoader().load().auth ?? {};
    } catch {
        return {};
    }
}

/** The roles setupAuth logs in when `roles` isn't given. */
export function rolesToSetUp(config: AuthConfig): string[] {
    const roles = Object.keys(config.roles ?? {});
    return roles.length ? roles : [roleName(config)];
}

/** True when the role's saved state exists and is younger than `maxAgeMinutes`. */
export function hasFreshAuthState(role: string, maxAgeMinutes: number, stateDir?: string): boolean {
    const file = authStateFile(role, stateDir);
    return existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAgeMinutes * 60_000;
}

/** Saves the context's cookies and storage as the role's login state. */
export async function saveAuthState(context: BrowserContext, role: string, stateDir?: string): Promise<string> {
    const file = authStateFile(role, stateDir);
    mkdirSync(dirname(file), { recursive: true });
    await context.storageState({ path: file });
    return file;
}

/** The role's credentials (its settings merged over the top-level auth config), for custom setup tests. */
export function authCredentials(role?: string, config: AuthConfig = loadAuthConfig()): ResolvedRole {
    return resolveRole(config, role);
}

/**
 * Registers one setup test per role that runs `login` in a fresh browser
 * context and saves the result to `.auth/<role>.json`. Call it at the top
 * level of a `*.setup.ts` file run by a setup project the e2e projects depend on.
 */
export function setupAuth(options: SetupAuthOptions): void {
    // The roles must be known now, to register one setup test each.
    const roles = options.roles ?? rolesToSetUp(options.config ?? loadAuthConfig());

    for (const role of roles) {
        // Setup steps, not test cases: no TestCaseID (setup files aren't checked by `propmaster check`).
        test(`log in as ${role}`, async ({ page, context, authConfig }) => {
            // Credentials and paths at run time, so a project's `use: { auth }` applies.
            const config = options.config ?? authConfig ?? loadAuthConfig();
            if (options.maxAgeMinutes !== undefined && hasFreshAuthState(role, options.maxAgeMinutes, config.stateDir)) {
                test.skip(true, `saved login state for "${role}" is younger than ${options.maxAgeMinutes} minutes`);
            }
            await test.step(`Log in as ${role}`, async () => {
                await options.login({ page, context }, resolveRole(config, role));
            });
            await test.step(`Save the login state for ${role}`, async () => {
                await saveAuthState(context, role, config.stateDir);
            });
        });
    }
}
