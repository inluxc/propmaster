/**
 * The project's package manager (npm, pnpm, Yarn or Bun), and the commands to
 * print for it: installing a driver, running a package.json script, running
 * an installed tool. Commands Propmaster prints for you to run use these, so
 * a Bun project is told `bun add -d pg`, not `npm install --save-dev pg`.
 *
 * Bun is a package manager here, not a runtime: `bunx playwright test` runs
 * Playwright on Node.js (its bin says so), which is what Playwright supports.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Lock files, in the order they're checked. */
const LOCK_FILES: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
];

/** The package manager that started this process (`npm_config_user_agent`, e.g. `bun/1.3.12 ...`), if any. */
export function packageManagerFromAgent(env: NodeJS.ProcessEnv = process.env): PackageManager | undefined {
    const name = /^(npm|pnpm|yarn|bun)\//.exec(env.npm_config_user_agent ?? '')?.[1];
    return name as PackageManager | undefined;
}

/**
 * The project's package manager: from its lock file, else from the command
 * that started this process (`bunx propmaster init` in a new project), else npm.
 */
export function packageManager(root: string, env: NodeJS.ProcessEnv = process.env): PackageManager {
    for (const [file, pm] of LOCK_FILES) if (fs.existsSync(path.join(root, file))) return pm;
    return packageManagerFromAgent(env) ?? 'npm';
}

/** The command that installs (as dev dependencies) or removes `packages`. */
export function packageCommand(pm: PackageManager, action: 'install' | 'uninstall', packages: string[]): string[] {
    const verbs: Record<PackageManager, [string[], string[]]> = {
        npm: [['install', '--save-dev'], ['uninstall']],
        pnpm: [['add', '-D'], ['remove']],
        yarn: [['add', '-D'], ['remove']],
        bun: [['add', '-d'], ['remove']],
    };
    return [pm, ...verbs[pm][action === 'install' ? 0 : 1], ...packages];
}

/** The command that runs a package.json script with arguments: `npm run x -- a`, `bun run x a`, `pnpm x a`, `yarn x a`. */
export function scriptCommand(pm: PackageManager, script: string, args: string[] = []): string[] {
    if (pm === 'npm') return ['npm', 'run', script, ...(args.length ? ['--', ...args] : [])];
    if (pm === 'bun') return ['bun', 'run', script, ...args];
    return [pm, script, ...args];
}

/** The command that runs an installed tool: `npx`, `bunx`, `pnpm exec`, `yarn`. */
export function execCommand(pm: PackageManager, bin: string, args: string[] = []): string[] {
    const prefix: Record<PackageManager, string[]> = { npm: ['npx'], bun: ['bunx'], pnpm: ['pnpm', 'exec'], yarn: ['yarn'] };
    return [...prefix[pm], bin, ...args];
}

/** Rebuilds a package whose install script didn't run. Bun skips the scripts of packages it doesn't trust: `bun pm trust` runs them and trusts the package from then on. */
export function rebuildCommand(pm: PackageManager, packages: string[]): string[] {
    return pm === 'bun' ? ['bun', 'pm', 'trust', ...packages] : [pm, 'rebuild', ...packages];
}

/**
 * `text` with its npm commands written for `pm`: `npm run x -- a` → `bun run x a`,
 * `npx tool` → `bunx tool`, `npm install --save-dev p` → `bun add -d p`,
 * `npm install` → `bun install`. Unchanged for npm.
 */
export function adaptCommands(text: string, pm: PackageManager): string {
    if (pm === 'npm') return text;
    return text
        .replace(/\bnpm run ([\w:.-]+)(?: --(?= ))?/g, (_m, script: string) => scriptCommand(pm, script).join(' '))
        .replace(/\bnpm install --save-dev\b/g, packageCommand(pm, 'install', []).join(' '))
        .replace(/\bnpm install\b/g, `${pm} install`)
        .replace(/\bnpx (?=[\w@])/g, `${execCommand(pm, '').join(' ').trimEnd()} `);
}

/** Whether this process is running on Bun (not just installed with it). */
export function runningOnBun(): boolean {
    return typeof (process.versions as Record<string, string | undefined>).bun === 'string';
}

/** The warning for Playwright Test running on Bun's runtime. */
export const BUN_RUNTIME_WARNING =
    'Playwright Test is running on Bun\'s runtime, which Playwright doesn\'t support: tests are slower, and some drivers and error messages behave differently. ' +
    'Run `bunx playwright test` without --bun (it runs on Node.js), and keep Bun as the package manager.';
