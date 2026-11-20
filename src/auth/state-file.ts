/**
 * Where a role's saved browser login state (Playwright `storageState`) lives.
 * Kept free of fixture imports so the fixture registry can use it.
 */

import { resolve } from 'node:path';

export const DEFAULT_STATE_DIR = '.auth';

/** Absolute path of a role's saved login state, e.g. `<cwd>/.auth/admin.json`. */
export function authStateFile(role: string, stateDir: string = DEFAULT_STATE_DIR): string {
    if (!/^[\w.-]+$/.test(role)) throw new Error(`invalid role name "${role}": use letters, digits, '.', '_' or '-'`);
    return resolve(stateDir, `${role}.json`);
}
