/**
 * Unit tests for the package manager helpers (src/package-manager.ts) and
 * what uses them: the commands init, doctor, mcp setup and the errors print
 * in a Bun project, and the warnings about Bun's runtime.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    bunRuntimeProblem,
    compareVersions,
    packageManagerForNewProject,
    adaptCommands,
    execCommand,
    installedPackageDir,
    packageCommand,
    packageManager,
    packageManagerFromAgent,
    rebuildCommand,
    scriptCommand,
} from '../../src/package-manager';
import { bunRuntimeLines, diagnose, type DoctorOptions, type Finding } from '../../src/cli/doctor';
import { initProject } from '../../src/cli/init';
import { planSetup, clientById } from '../../src/cli/mcp-setup';
import { MissingPackageError } from '../../src/errors';
import PropmasterReporter from '../../src/reporter/index';

let root: string;
test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-pm-'));
});
test.afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const BUN_AGENT = { npm_config_user_agent: 'bun/1.3.12 npm/? node/v24.12.0 linux x64' };

test.describe('package manager — detection and commands', () => {
    test('the lock file decides; a folder without one is npm, however Propmaster was started', () => {
        expect(packageManager(root)).toBe('npm');
        write({ 'bun.lock': '{}' });
        expect(packageManager(root)).toBe('bun');
        fs.rmSync(path.join(root, 'bun.lock'));
        write({ 'bun.lockb': '' });
        expect(packageManager(root)).toBe('bun');
        fs.rmSync(path.join(root, 'bun.lockb'));
        write({ 'pnpm-lock.yaml': '' });
        expect(packageManager(root)).toBe('pnpm');
    });

    test('a new project: its lock file, else the command that started init', () => {
        expect(packageManagerForNewProject(root, {})).toBe('npm');
        expect(packageManagerForNewProject(root, BUN_AGENT)).toBe('bun');
        expect(packageManagerForNewProject(root, { npm_config_user_agent: 'pnpm/10.0.0 npm/? node/v24' })).toBe('pnpm');
        expect(packageManagerFromAgent({ npm_config_user_agent: 'something-else/1' })).toBeUndefined();
        write({ 'package-lock.json': '{}' });
        expect(packageManagerForNewProject(root, BUN_AGENT)).toBe('npm');
    });

    test('install, run a script, run a tool, rebuild', () => {
        expect(packageCommand('bun', 'install', ['pg'])).toEqual(['bun', 'add', '-d', 'pg']);
        expect(scriptCommand('npm', 'next-id', ['API', '3'])).toEqual(['npm', 'run', 'next-id', '--', 'API', '3']);
        expect(scriptCommand('npm', 'verify')).toEqual(['npm', 'run', 'verify']);
        expect(scriptCommand('bun', 'next-id', ['API'])).toEqual(['bun', 'run', 'next-id', 'API']);
        expect(scriptCommand('pnpm', 'lint:tests', ['--json'])).toEqual(['pnpm', 'lint:tests', '--json']);
        expect(execCommand('npm', 'playwright', ['install'])).toEqual(['npx', 'playwright', 'install']);
        expect(execCommand('bun', 'playwright', ['install'])).toEqual(['bunx', 'playwright', 'install']);
        expect(execCommand('pnpm', 'propmaster')).toEqual(['pnpm', 'exec', 'propmaster']);
        expect(rebuildCommand('bun', ['@confluentinc/kafka-javascript'])).toEqual(['bun', 'pm', 'trust', '@confluentinc/kafka-javascript']);
        expect(rebuildCommand('npm', ['x'])).toEqual(['npm', 'rebuild', 'x']);
    });

    test('adaptCommands rewrites npm commands in text, and leaves npm projects alone', () => {
        const text = [
            'npm install',
            'npm install --save-dev pg kafkajs',
            'npm run next-id -- API 3     # three IDs',
            'npm run lint:tests -- --json',
            'run `npm run verify` before finishing',
            'npx propmaster fixture add redis',
            'npx @playwright/mcp',
            '"verify": "npm run typecheck && npm run lint:tests"',
            'npm-run-all and npxtool stay',
        ].join('\n');
        expect(adaptCommands(text, 'npm')).toBe(text);
        expect(adaptCommands(text, 'bun').split('\n')).toEqual([
            'bun install',
            'bun add -d pg kafkajs',
            'bun run next-id API 3     # three IDs',
            'bun run lint:tests --json',
            'run `bun run verify` before finishing',
            'bunx propmaster fixture add redis',
            'bunx @playwright/mcp',
            '"verify": "bun run typecheck && bun run lint:tests"',
            'npm-run-all and npxtool stay',
        ]);
        expect(adaptCommands('npx playwright test and npm run x -- y', 'pnpm')).toBe('pnpm exec playwright test and pnpm x y');
    });

    test('MissingPackageError names the install command of the project in the current folder', () => {
        const cwd = process.cwd();
        write({ 'bun.lock': '{}' });
        try {
            process.chdir(root);
            expect(new MissingPackageError('kafkaClient', 'kafkajs').installCommand).toBe('bun add -d kafkajs');
        } finally {
            process.chdir(cwd);
        }
    });
});

test.describe('package manager — a Bun project', () => {
    test('init writes bun commands into AGENTS.md, SKILLS.md and package.json', () => {
        write({ 'bun.lock': '{}' });
        const lines: string[] = [];
        initProject(root, (l = '') => lines.push(l));
        expect(read('AGENTS.md')).toContain('bun run next-id API');
        fs.rmSync(root, { recursive: true });
        fs.mkdirSync(root);
        // A new folder, started with bunx: no lock file yet.
        initProject(root, (l = '') => lines.push(l), BUN_AGENT);
        expect(read('AGENTS.md')).toContain('bun run next-id API');
        expect(read('AGENTS.md')).not.toMatch(/\bnpm run\b|\bnpx /);
        expect(read('SKILLS.md')).not.toMatch(/\bnpm run\b|\bnpx /);
        expect(JSON.parse(read('package.json')).scripts.verify).toBe('bun run typecheck && bun run lint:tests');
        expect(JSON.parse(read('.mcp.json')).mcpServers.propmaster).toEqual({ command: 'bunx', args: ['propmaster', 'mcp'] });
        expect(lines).toEqual(expect.arrayContaining(['    1. bun install', '    3. bunx playwright install', '    5. Get a TestCaseID: bun run next-id API']));
    });

    test('an npm project keeps npm commands', () => {
        initProject(root, () => {});
        expect(read('AGENTS.md')).toContain('npm run next-id -- API');
        expect(planSetup(clientById('claude')!, { root, home: root }, {}).kind).toBe('unchanged');
        expect(JSON.parse(read('.mcp.json')).mcpServers.propmaster.command).toBe('npx');
    });
});

test.describe('package manager — doctor and the reporter', () => {
    const doctor = (extra: DoctorOptions = {}) => diagnose(root, { env: {}, skipMcp: true, offline: true, nodeVersion: '24.12.0', ...extra });
    const project = (files: Record<string, string> = {}) =>
        write({
            'package.json': JSON.stringify({ name: 's', scripts: { test: 'playwright test' } }),
            'bun.lock': '{}',
            'environments.json': JSON.stringify({ environments: { local: {} } }),
            'playwright.config.ts': "export default { reporter: [['@inluxc/propmaster/reporter']] };\n",
            'tsconfig.json': '{}',
            ...files,
        });
    const by = (findings: Finding[], check: string) => findings.filter((f) => f.check === check);

    test('--bun in scripts and CI files: supported from Bun 1.4.3 and Playwright 1.65, older ones warned about', async () => {
        project({
            'package.json': JSON.stringify({ name: 's', scripts: { test: 'bunx --bun playwright test', ok: 'bunx playwright test', also: 'bun add --bundle' } }, null, 2),
            '.github/workflows/ci.yml': 'steps:\n  - run: bun install\n  - run: bun --bun run test\n',
            'node_modules/@playwright/test/package.json': '{ "name": "@playwright/test", "version": "1.65.1" }',
        });
        expect(bunRuntimeLines(root)).toEqual([
            'package.json:4: "test": "bunx --bun playwright test",',
            '.github/workflows/ci.yml:3: - run: bun --bun run test',
        ]);
        const bunFinding = async (bunVersion: string | null) =>
            by((await doctor({ bunVersion })).findings, 'playwright').find((f) => /Bun/.test(f.message))!;
        expect(await bunFinding('1.4.5')).toMatchObject({ status: 'ok', message: 'tests run on Bun 1.4.5 with Playwright 1.65.1 (package.json:4, .github/workflows/ci.yml:3)' });
        expect(await bunFinding('1.3.12')).toMatchObject({ status: 'warn', message: expect.stringContaining('Bun 1.3.12 is older than 1.4.3') });
        expect(await bunFinding(null)).toMatchObject({ status: 'warn', message: "Bun isn't installed, but package.json:4, .github/workflows/ci.yml:3 run the tests with --bun." });

        write({ 'package.json': JSON.stringify({ name: 's', scripts: { test: 'bunx playwright test' } }) });
        fs.rmSync(path.join(root, '.github'), { recursive: true });
        expect(by((await doctor({ bunVersion: '1.3.12' })).findings, 'playwright').filter((f) => /Bun/.test(f.message))).toEqual([]);
    });

    test('version rules for Bun\'s runtime', () => {
        expect(compareVersions('1.4.3', '1.4.3')).toBe(0);
        expect(compareVersions('1.4.10', '1.4.3')).toBeGreaterThan(0);
        expect(compareVersions('1.65.0-alpha-1', '1.65.0')).toBe(0);
        expect(bunRuntimeProblem('1.4.3', '1.65.0')).toBeUndefined();
        expect(bunRuntimeProblem('1.5.0', undefined)).toBeUndefined();
        expect(bunRuntimeProblem('1.4.5', '1.64.2')).toBe('@playwright/test 1.64.2 doesn\'t run on Bun: it needs 1.65.0 or later. Upgrade, or run `bunx playwright test` without --bun to run the tests on Node.js.');
        expect(bunRuntimeProblem('1.3.12', '1.65.1')).toContain('Bun 1.3.12 is older than 1.4.3');
    });

    test('a driver installed without its native binding fails, and the fix is bun pm trust', async () => {
        project({
            'environments.json': JSON.stringify({ environments: { local: { kafka: { brokers: ['localhost:9092'], driver: 'confluent' } } } }),
            'tests/integration/kafka.spec.ts': "import { test } from '@inluxc/propmaster';\ntest('[TC-KFK-001] t', { tag: ['@TC-KFK-001'] }, async ({ kafkaClient }) => { await test.step('Step 1: s', async () => {}); });\n",
            'node_modules/@confluentinc/kafka-javascript/package.json': '{ "name": "@confluentinc/kafka-javascript" }',
        });
        const commands: string[] = [];
        const runner = (command: string[]) => {
            commands.push(command.join(' '));
            write({ 'node_modules/@confluentinc/kafka-javascript/build/Release/confluent-kafka-javascript.node': '' });
            return { ok: true, output: '' };
        };
        const [failure] = by((await doctor({ runner })).findings, 'drivers').filter((f) => f.status === 'fail');
        expect(failure.message).toBe("@confluentinc/kafka-javascript is installed without its native binding: its install script didn't run (Bun runs only the scripts of trusted packages).");
        expect(failure.fix).toMatchObject({ text: 'bun pm trust @confluentinc/kafka-javascript', safe: true });
        await failure.fix!.apply!();
        expect(commands).toEqual(['bun pm trust @confluentinc/kafka-javascript']);
        expect(by((await doctor({ runner })).findings, 'drivers').filter((f) => f.status === 'fail')).toEqual([]);
    });

    test('fix commands use bunx and bun', async () => {
        project({ 'environments.json': '{ "environments": { "dev": {} } }' });
        const fixes = (await doctor()).findings.map((f) => f.fix?.text).filter(Boolean).join('\n');
        expect(fixes).toContain('bunx propmaster env add local');
        expect(fixes).not.toMatch(/\bnpx |\bnpm /);
    });

    test('the reporter warns only about a Bun or Playwright too old for each other', () => {
        const logged: string[] = [];
        const original = console.log;
        console.log = (line: string) => logged.push(line);
        try {
            const begin = (bun: string | undefined, version: string) =>
                new PropmasterReporter({ bunVersion: () => bun, quarantine: false, history: false }).onBegin({ rootDir: root, configFile: path.join(root, 'playwright.config.ts'), version } as never, {} as never);
            begin(undefined, '1.65.1'); // Node.js
            begin('1.4.5', '1.65.1'); // supported
            begin('1.3.12', '1.65.1');
        } finally {
            console.log = original;
        }
        expect(logged).toEqual([`Propmaster: ${bunRuntimeProblem('1.3.12', '1.65.1')}`]);
    });
});

test.describe('package manager — installed packages', () => {
    test('a package counts as installed only when a node_modules folder has it', () => {
        write({ 'a/b/package.json': '{}', 'node_modules/ajv/package.json': '{ "name": "ajv" }', 'node_modules/@scope/pkg/package.json': '{}' });
        expect(installedPackageDir(path.join(root, 'a/b'), 'ajv')).toBe(path.join(root, 'node_modules/ajv'));
        expect(installedPackageDir(path.join(root, 'a/b'), '@scope/pkg')).toBe(path.join(root, 'node_modules/@scope/pkg'));
        // Not installed anywhere above: undefined, even where Bun's auto-install would resolve it from its cache.
        expect(installedPackageDir(path.join(root, 'a/b'), 'surely-not-installed-xyz')).toBeUndefined();
    });
});
