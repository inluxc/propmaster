/**
 * Unit tests for `propmaster doctor`: each check's pass, fail and fix, on
 * scratch projects. Backends are "reached" through a stand-in, packages are
 * "installed" by a fake package manager, and the MCP server start is skipped
 * except where it's the thing under test.
 */

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyFixes, backendAddresses, diagnose, formatFindings, placeholdersIn, runDoctor, summarize, type DoctorOptions, type Finding } from '../../src/cli/doctor';
import type { CommandRunner } from '../../src/cli/fixture';
import type { FrameworkConfig } from '../../src/config/schema';
import { stripAnsi } from '../../src/cli/style';
import { projectTools } from '../../src/mcp/project-tools';

const TEST = (fixtures: string, id = 'TC-RDS-001') =>
    `import { test, expect } from '@inluxc/propmaster';\ntest('[${id}] t', { tag: ['@${id}'] }, async ({ ${fixtures} }) => {\n    await test.step('Step 1: s', async () => expect(1).toBe(1));\n});\n`;

const CONFIG = "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ reporter: [['list'], ['@inluxc/propmaster/reporter']] });\n";

function project(files: Record<string, string> = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-doctor-'));
    const all: Record<string, string> = {
        'package.json': `${JSON.stringify({ name: 'scratch', devDependencies: { ioredis: '^5' } }, null, 4)}\n`,
        'environments.json': JSON.stringify({ environments: { local: { redis: { host: 'localhost', port: 6379 } }, dev: { redis: { host: 'CHANGE_ME', port: 6379 } } } }, null, 4),
        'playwright.config.ts': CONFIG,
        'tsconfig.json': '{}',
        '.mcp.json': '{ "mcpServers": { "propmaster": { "command": "npx", "args": ["propmaster", "mcp"] } } }',
        'node_modules/ioredis/package.json': '{ "name": "ioredis", "version": "5.0.0" }',
        'tests/integration/redis.spec.ts': TEST('redisClient'),
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

/** Every backend answers, unless listed as down. */
const network = (...down: string[]) => async (host: string, port: number) => !down.includes(`${host}:${port}`);

function fakeNpm() {
    const commands: string[] = [];
    const runner: CommandRunner = (command, cwd) => {
        commands.push(command.join(' '));
        // `npm install` with no names installs what package.json lists.
        const names = command.length > 2 ? command.slice(3) : Object.keys(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')).devDependencies ?? {});
        for (const name of names) {
            fs.mkdirSync(path.join(cwd, 'node_modules', name), { recursive: true });
            fs.writeFileSync(path.join(cwd, 'node_modules', name, 'package.json'), `{ "name": "${name}" }`);
        }
        return { ok: true, output: '' };
    };
    return { runner, commands };
}

const opts = (extra: DoctorOptions = {}): DoctorOptions => ({ env: {}, skipMcp: true, reachable: network(), nodeVersion: '24.12.0', ...extra });
const problems = (findings: Finding[]) => findings.filter((f) => f.status === 'fail' || f.status === 'warn');
const by = (findings: Finding[], check: string) => findings.filter((f) => f.check === check);

test.describe('doctor checks', () => {
    test('a healthy project has no problems', async () => {
        const { environment, findings } = await diagnose(project(), opts());
        expect(environment).toBe('local');
        expect(problems(findings)).toEqual([]);
        expect(findings.map((f) => f.check)).toEqual(['node', 'config', 'drivers', 'backends', 'playwright', 'mcp', 'tests']);
        expect(by(findings, 'backends')[0].message).toBe('answering: redis (localhost:6379)');
    });

    test('Node.js older than 22.12 fails', async () => {
        const { findings } = await diagnose(project(), opts({ nodeVersion: 'v20.11.1' }));
        expect(by(findings, 'node')[0]).toMatchObject({ status: 'fail', message: 'Node.js 20.11.1 is too old: Propmaster needs 22.12.0 or newer.' });
    });

    test('config: no environments.json, an unknown environment, CHANGE_ME values, production', async () => {
        const bare = project();
        fs.rmSync(path.join(bare, 'environments.json'));
        expect(by((await diagnose(bare, opts())).findings, 'config')[0]).toMatchObject({ status: 'fail', message: 'environments.json not found.' });

        const root = project();
        const unknown = by((await diagnose(root, opts({ environment: 'stg' }))).findings, 'config');
        expect(unknown[0]).toMatchObject({ status: 'fail', message: 'environment "stg" isn\'t in environments.json (it has local, dev).' });
        expect(unknown[0].fix!.text).toContain('npx propmaster env add stg');

        const dev = by((await diagnose(root, opts({ environment: 'dev', offline: true }))).findings, 'config');
        expect(dev[1]).toMatchObject({ status: 'warn', message: '1 value in "dev" still CHANGE_ME: redis.host' });
        expect(placeholdersIn({ a: ['CHANGE_ME', 'x'], b: { c: 'CHANGE_ME' } })).toEqual(['a[0]', 'b.c']);

        const prod = project({ 'environments.json': JSON.stringify({ environments: { live: { redis: { host: 'localhost', port: 6379 } } } }) });
        expect(by((await diagnose(prod, opts({ environment: 'live' }))).findings, 'config')[0].message).toBe('environment "live" (production) loads');
    });

    test('config: a fixture the tests use with no block fails, and --fix adds it to every environment', async () => {
        const root = project({ 'tests/integration/db.spec.ts': TEST('databaseClient, otpClient', 'TC-DB-001'), 'node_modules/pg/package.json': '{}', 'node_modules/otplib/package.json': '{}' });
        const { findings } = await diagnose(root, opts());
        const missing = by(findings, 'config').filter((f) => f.status === 'fail');
        expect(missing.map((f) => f.message)).toEqual(['tests use databaseClient, but "local" has no database config.']); // otp needs none
        expect(missing[0].fix).toMatchObject({ safe: true });
        const { fixed } = await applyFixes(findings);
        expect(fixed).toHaveLength(1);
        const envs = JSON.parse(fs.readFileSync(path.join(root, 'environments.json'), 'utf-8')).environments;
        expect(envs.local.database).toMatchObject({ type: 'postgresql', host: 'localhost' });
        expect(envs.dev.database.host).toBe('CHANGE_ME');
        expect(fs.existsSync(path.join(root, 'tests/integration/database.spec.ts'))).toBe(false); // no starter test, no service
    });

    test('drivers: not installed, or in package.json but not in node_modules; the variant the config asks for', async () => {
        const root = project({
            'tests/integration/db.spec.ts': TEST('databaseClient', 'TC-DB-001'),
            'environments.json': JSON.stringify({ environments: { local: { redis: { host: 'localhost', port: 6379 }, database: { type: 'mysql', host: 'localhost', database: 'x' } } } }),
        });
        fs.rmSync(path.join(root, 'node_modules/ioredis'), { recursive: true });
        const { findings } = await diagnose(root, opts());
        expect(by(findings, 'drivers').map((f) => [f.status, f.message, f.fix?.text])).toEqual([
            ['fail', 'tests use databaseClient, but mysql2 isn\'t installed (MySQL / MariaDB).', 'npm install --save-dev mysql2'],
            ['fail', 'ioredis is in package.json but not in node_modules.', 'npm install'],
        ]);
        const npm = fakeNpm();
        await applyFixes((await diagnose(root, opts({ runner: npm.runner }))).findings);
        expect(npm.commands).toEqual(['npm install --save-dev mysql2', 'npm install']);
    });

    test('backends: down ones fail when tests use them, warn otherwise, and say how to start them', async () => {
        const root = project({
            'environments.json': JSON.stringify({ environments: { local: { redis: { host: 'localhost', port: 6379 }, kafka: { brokers: ['localhost:9092'] } } } }),
            'compose.test.yaml': 'services:\n  redis:\n    image: redis:7\n',
        });
        const findings = by((await diagnose(root, opts({ reachable: network('localhost:6379', 'localhost:9092') }))).findings, 'backends');
        expect(findings.map((f) => [f.status, f.message, f.fix?.text])).toEqual([
            ['fail', "redis at localhost:6379 doesn't answer.", 'docker compose -f compose.test.yaml up -d --wait redis'],
            ['warn', "kafka at localhost:9092 doesn't answer (no test uses it yet).", 'start it, or point kafka in environments.json at where it runs'],
        ]);
        expect(by((await diagnose(root, opts({ offline: true }))).findings, 'backends')).toEqual([{ check: 'backends', status: 'skip', message: 'not checked (--offline)' }]);
    });

    test('backend addresses from every kind of block; placeholders, sqlite, SRV and real AWS are left out', () => {
        const config = {
            environment: 'x',
            database: { type: 'mssql', host: 'db', database: 'd' },
            redis: { host: 'cache', port: 6380 },
            mongodb: { uri: 'mongodb://u:p@m1:27018,m2/db', database: 'db' },
            neo4j: { uri: 'neo4j+s://graph.example.com', username: 'n', password: 'p' },
            cassandra: { contactPoints: ['c1:9043', 'c2'] },
            kafka: { brokers: ['[::1]:9093'] },
            amqp: { url: 'amqps://rabbit' },
            aws: { region: 'eu-west-1' },
            search: { url: 'https://search.example.com' },
            grpc: { address: 'grpcs://api.example.com:8443' },
            realtime: { url: 'CHANGE_ME' },
            appium: { serverUrl: 'http://127.0.0.1:4723' },
        } as unknown as FrameworkConfig;
        expect(backendAddresses(config)).toEqual([
            { block: 'database', host: 'db', port: 1433 },
            { block: 'redis', host: 'cache', port: 6380 },
            { block: 'mongodb', host: 'm1', port: 27018 },
            { block: 'neo4j', host: 'graph.example.com', port: 7687 },
            { block: 'cassandra', host: 'c1', port: 9043 },
            { block: 'kafka', host: '::1', port: 9093 },
            { block: 'amqp', host: 'rabbit', port: 5671 },
            { block: 'search', host: 'search.example.com', port: 443 },
            { block: 'appium', host: '127.0.0.1', port: 4723 },
            { block: 'grpc', host: 'api.example.com', port: 8443 },
        ]);
        expect(backendAddresses({ environment: 'x', database: { type: 'sqlite', database: './t.db' }, mongodb: { uri: 'mongodb+srv://c.example.net', database: 'd' } } as FrameworkConfig)).toEqual([]);
    });

    test('playwright: no config fails; no reporter or tsconfig warns; browser tests need @playwright/test', async () => {
        const none = project();
        fs.rmSync(path.join(none, 'playwright.config.ts'));
        expect(by((await diagnose(none, opts())).findings, 'playwright')).toMatchObject([{ status: 'fail', message: 'no playwright.config.ts.' }]);

        const root = project({ 'playwright.config.ts': "export default { reporter: 'list' };\n", 'tests/e2e/home.spec.ts': TEST('page', 'TC-BRW-001') });
        fs.rmSync(path.join(root, 'tsconfig.json'));
        const findings = by((await diagnose(root, opts())).findings, 'playwright');
        expect(findings.map((f) => [f.status, f.message.split(':')[0].split(',')[0]])).toEqual([
            ['ok', 'playwright.config.ts'],
            ['warn', "playwright.config.ts doesn't use the Propmaster reporter"],
            ['warn', 'no tsconfig.json'],
            ['fail', "@playwright/test isn't installed."],
        ]);
    });

    test('ci: a Playwright image older than @playwright/test warns, and --fix updates it', async () => {
        const workflow = 'jobs:\n  e2e:\n    container:\n      image: mcr.microsoft.com/playwright:v1.60.0-noble\n';
        const root = project({ '.github/workflows/ci.yml': workflow, 'node_modules/@playwright/test/package.json': '{ "version": "1.65.1" }' });
        const findings = (await diagnose(root, opts())).findings;
        expect(by(findings, 'ci')).toMatchObject([{ status: 'warn', message: ".github/workflows/ci.yml runs the Playwright image v1.60.0, but @playwright/test is 1.65.1: the browsers won't match." }]);
        await applyFixes(findings);
        expect(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf-8')).toBe(workflow.replace('v1.60.0', 'v1.65.1'));
        expect(by((await diagnose(root, opts())).findings, 'ci')).toMatchObject([{ status: 'ok' }]);
    });

    test('secrets: .env files git would pick up fail, --fix ignores them; committed ones say how to undo it', async () => {
        const root = project({ '.env.local': 'PW_REDIS_PASSWORD=x\n', '.env.example': '', '.gitignore': 'node_modules/\n' });
        expect(by((await diagnose(root, opts())).findings, 'secrets')).toEqual([]); // not a git project
        spawnSync('git', ['init', '-q'], { cwd: root });
        const findings = (await diagnose(root, opts())).findings;
        expect(by(findings, 'secrets')).toMatchObject([{ status: 'fail', message: ".env.local isn't in .gitignore: secrets in it could be committed." }]);
        await applyFixes(findings);
        expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')).toBe('node_modules/\n.env.local\n');
        expect(by((await diagnose(root, opts())).findings, 'secrets')).toMatchObject([{ status: 'ok', message: '.env.local kept out of git' }]);

        spawnSync('git', ['add', '-f', '.env.local'], { cwd: root });
        expect(by((await diagnose(root, opts())).findings, 'secrets')).toMatchObject([{ status: 'fail', message: '.env.local is committed to git.' }]);
    });

    test('mcp: no editor set up warns; the server is started for real when asked', async () => {
        const root = project();
        fs.rmSync(path.join(root, '.mcp.json'));
        expect(by((await diagnose(root, opts())).findings, 'mcp')).toMatchObject([{ status: 'warn' }]);
        fs.mkdirSync(path.join(root, '.vscode'));
        fs.writeFileSync(path.join(root, '.vscode/mcp.json'), '{ "servers": { "propmaster": {} } }');
        const started = by((await diagnose(root, opts({ skipMcp: false }))).findings, 'mcp');
        expect(started.map((f) => f.message)).toEqual(['the propmaster server is set up in .vscode/mcp.json', expect.stringMatching(/^the server starts for "local" with \d+ tools$/)]);
    });

    test('tests: convention violations fail; quarantine warnings warn', async () => {
        const root = project({
            'tests/integration/bad.spec.ts': "import { test } from '@inluxc/propmaster';\ntest('no id', async ({ redisClient }) => {});\n",
            'quarantine.json': JSON.stringify({ maxAgeDays: 1, tests: [{ id: 'TC-RDS-404', owner: 'a', issue: 'https://example.test/1', since: '2020-01-01' }] }),
        });
        const findings = by((await diagnose(root, opts())).findings, 'tests');
        expect(findings[0]).toMatchObject({ status: 'fail' });
        expect(findings[0].message).toMatch(/^2 test convention violations, first: tests\/integration\/bad.spec.ts:2 /);
        expect(findings.slice(1).map((f) => f.status)).toEqual(['warn', 'warn']); // too old, and no test has TC-RDS-404
    });
});

test.describe('doctor command and MCP tool', () => {
    test('text and JSON output, --problems, exit codes, and --fix checking again', async () => {
        const root = project();
        fs.rmSync(path.join(root, 'node_modules/ioredis'), { recursive: true });
        const lines: string[] = [];
        const log = (l = '') => void lines.push(l);
        const npm = fakeNpm();
        expect(await runDoctor(['--root', root, '--problems'], log, opts({ runner: npm.runner }))).toBe(1);
        const text = stripAnsi(lines.join('\n'));
        expect(text).toContain('✖ drivers   ioredis is in package.json but not in node_modules.');
        expect(text).toContain('→ npm install  (--fix)');
        expect(text).not.toContain('✔ node');
        expect(text).toContain('1 problem. `propmaster doctor --fix` fixes 1 of them.');

        lines.length = 0;
        expect(await runDoctor(['--root', root, '--fix', '--json'], log, opts({ runner: npm.runner }))).toBe(0);
        const json = JSON.parse(stripAnsi(lines.join('\n')));
        expect(json).toMatchObject({ environment: 'local', ok: true, fixed: ['ioredis is in package.json but not in node_modules.'] });
        expect(json.findings.every((f: { status: string }) => f.status === 'ok')).toBe(true);
        expect(npm.commands).toEqual(['npm install']);
    });

    test('summary counts, and the --fix marker only on fixes doctor can apply', () => {
        const findings: Finding[] = [
            { check: 'a', status: 'fail', message: 'broken', fix: { text: 'do x', safe: true, apply: () => true } },
            { check: 'b', status: 'warn', message: 'meh', fix: { text: 'do y by hand', safe: false } },
            { check: 'c', status: 'ok', message: 'fine' },
        ];
        expect(summarize(findings)).toEqual({ fail: 1, warn: 1, fixable: 1 });
        expect(formatFindings(findings)).toEqual(['✖ a         broken', '            → do x  (--fix)', '! b         meh', '            → do y by hand', '✔ c         fine']);
        expect(formatFindings(findings, false, false)).not.toContain('✔ c         fine');
    });

    test('the MCP doctor tool: problems only by default, and fix: true applies the safe fixes', async () => {
        const root = project();
        fs.rmSync(path.join(root, 'node_modules/ioredis'), { recursive: true });
        const npm = fakeNpm();
        const tool = projectTools(root, npm.runner).find((t) => t.name === 'doctor')!;
        const before = (await tool.handler({ offline: true })) as Record<string, unknown>;
        expect(before).toMatchObject({ environment: 'local', ok: false, summary: '1 problem(s), 0 warning(s); 1 can be fixed with fix: true' });
        expect(before.findings).toEqual([{ check: 'drivers', status: 'fail', message: 'ioredis is in package.json but not in node_modules.', fix: 'npm install', autoFix: true }]);
        const after = (await tool.handler({ offline: true, fix: true })) as Record<string, unknown>;
        expect(after).toMatchObject({ ok: true, fixed: ['npm install'], findings: [] });
        await expect(tool.handler({ environment: 3 })).rejects.toThrow('environment must be a string');
    });
});
