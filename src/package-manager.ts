/**
 * The project's package manager (npm, pnpm, Yarn or Bun), and the commands to
 * print for it: installing a driver, running a package.json script, running
 * an installed tool. Commands Propmaster prints for you to run use these, so
 * a Bun project is told `bun add -d pg`, not `npm install --save-dev pg`.
 *
 * Bun is also a runtime for the tests: `bunx --bun playwright test` runs them
 * on Bun (Playwright 1.65 and Bun 1.4.3 or later), and `bunx playwright test`
 * on Node.js. Older versions are warned about (bunRuntimeProblem).
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

/** The project's package manager, from its lock file; npm when it has none. */
export function packageManager(root: string): PackageManager {
    for (const [file, pm] of LOCK_FILES) if (fs.existsSync(path.join(root, file))) return pm;
    return 'npm';
}

/**
 * For a project that's being created: its lock file when it has one, else
 * the command that started this process (`bunx propmaster init` → bun).
 * Only `init` asks this: anywhere else, a folder without a lock file is npm,
 * however Propmaster was started.
 */
export function packageManagerForNewProject(root: string, env: NodeJS.ProcessEnv = process.env): PackageManager {
    for (const [file, pm] of LOCK_FILES) if (fs.existsSync(path.join(root, file))) return pm;
    return packageManagerFromAgent(env) ?? 'npm';
}

/**
 * The folder of `name` in the project's node_modules (or a parent's), the
 * way Node.js looks for it; undefined when the project doesn't have it.
 * Don't ask the module resolver instead: in a folder with no node_modules,
 * Bun resolves packages from its global cache (auto-install), so a package
 * the project never installed would count as installed.
 */
export function installedPackageDir(root: string, name: string): string | undefined {
    let dir = path.resolve(root);
    for (;;) {
        const candidate = path.join(dir, 'node_modules', ...name.split('/'));
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
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

/** The oldest Bun that runs Playwright Test: the one Playwright's own CI uses. */
export const MIN_BUN = '1.4.3';
/** The first Playwright with a test runner that runs on Bun. */
export const MIN_PLAYWRIGHT_FOR_BUN = '1.65.0';

/** The Bun version this process runs on, or undefined on Node.js. */
export function bunVersion(): string | undefined {
    return (process.versions as Record<string, string | undefined>).bun;
}

/** Compares dotted versions: negative, zero or positive. Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
}

/**
 * What's wrong with running Playwright Test on this Bun and Playwright, or
 * undefined when both are recent enough.
 */
export function bunRuntimeProblem(bun: string, playwright: string | undefined): string | undefined {
    const problems: string[] = [];
    if (compareVersions(bun, MIN_BUN) < 0) problems.push(`Bun ${bun} is older than ${MIN_BUN}, the first version Playwright Test runs on (\`bun upgrade\`)`);
    if (playwright && compareVersions(playwright, MIN_PLAYWRIGHT_FOR_BUN) < 0) {
        problems.push(`@playwright/test ${playwright} doesn't run on Bun: it needs ${MIN_PLAYWRIGHT_FOR_BUN} or later`);
    }
    if (!problems.length) return undefined;
    return `${problems.join('; ')}. Upgrade, or run \`bunx playwright test\` without --bun to run the tests on Node.js.`;
}
