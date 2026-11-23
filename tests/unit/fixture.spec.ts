/**
 * Unit tests for `propmaster fixture add|remove|list`, the fixture catalog,
 * the in-place JSON / .env / compose editors and the MCP project tools. Each
 * test works on a scratch project; a fake package manager edits package.json
 * the way npm would, so add-then-remove can be compared byte for byte.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FIXTURE_CATALOG, PLACEHOLDER, catalogEntry, starterSource } from '../../src/cli/fixture-catalog';
import {
    addEnvSection,
    addService,
    applyPlan,
    fixtureStates,
    formatFixturePlan,
    hasService,
    packageCommand,
    packageManager,
    parseRequest,
    placeholderValue,
    planAdd,
    planRemove,
    removeEnvSection,
    removeService,
    resolveRequest,
    runFixture,
    type CommandRunner,
} from '../../src/cli/fixture';
import { addMember, formatJson, parseJsonSpans, removeMember } from '../../src/cli/json-edit';
import { checkSources } from '../../src/cli/check-tests';
import { FIXTURE_PACKAGES } from '../../src/fixtures/optional-package';
import { ConfigLoader } from '../../src/config/loader';
import { NotInteractiveError } from '../../src/cli/prompts';
import { projectTools } from '../../src/mcp/project-tools';

const REPO = process.cwd();

// ─── Scratch projects ───────────────────────────────────────────────────────

const ENVIRONMENTS = `{
    "environments": {
        "local": {
            "openapi": { "specPath": "./specs/api.yaml",   "baseUrl": "http://localhost:8080" },
            "tags": ["a", "b"]
        },
        "dev": {
            "openapi": { "specPath": "https://dev.example.com/openapi.json" }
        },
        "prod": {}
    }
}
`;

const COMPOSE = `# The app's own services
services:
  app:
    image: example/app:1
    ports: ["3000:3000"]

volumes:
  data: {}
`;

const ENV_EXAMPLE = `# Hand-written settings
PW_ENVIRONMENT=local
`;

const PACKAGE = (deps: Record<string, string> = {}) =>
    `${JSON.stringify({ name: 'scratch', private: true, dependencies: { '@inluxc/propmaster': '^1.0.0' }, devDependencies: { typescript: '^7.0.0', ...deps } }, null, 4)}\n`;

function project(files: Record<string, string> = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-fixture-'));
    const all: Record<string, string> = {
        'package.json': PACKAGE(),
        'environments.json': ENVIRONMENTS,
        'compose.test.yaml': COMPOSE,
        '.env.example': ENV_EXAMPLE,
        'tests/api/.keep': '',
        'tests/integration/.keep': '',
        'tests/mobile/.keep': '',
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

/** Every file under `root`, relative path → content. */
function snapshot(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) walk(full);
            else out[path.relative(root, full)] = fs.readFileSync(full, 'utf-8');
        }
    };
    walk(root);
    return out;
}

/** A package manager that edits devDependencies in place, like npm, and records its commands. */
function fakeNpm() {
    const commands: string[] = [];
    const runner: CommandRunner = (command, cwd) => {
        commands.push(command.join(' '));
        const file = path.join(cwd, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(file, 'utf-8')) as { devDependencies: Record<string, string> };
        const [, verb, ...rest] = command;
        const names = rest.filter((a) => !a.startsWith('-'));
        for (const name of names) {
            if (verb === 'install') pkg.devDependencies[name] = '^1.0.0';
            else delete pkg.devDependencies[name];
        }
        fs.writeFileSync(file, `${JSON.stringify(pkg, null, 4)}\n`);
        return { ok: true, output: `${verb} ${names.join(' ')}` };
    };
    return { runner, commands };
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const env = (root: string) => JSON.parse(read(root, 'environments.json')).environments;

// ─── The catalog ────────────────────────────────────────────────────────────

test.describe('fixture catalog', () => {
    test('every package is a known fixture package and an optional peer dependency', () => {
        const known = new Set<string>(Object.values(FIXTURE_PACKAGES).flat());
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')) as { peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional?: boolean }> };
        for (const entry of FIXTURE_CATALOG) {
            for (const name of entry.variants.flatMap((v) => v.packages)) {
                expect(known.has(name), `${entry.id}: ${name}`).toBe(true);
                expect(pkg.peerDependencies[name], `${entry.id}: ${name} in peerDependencies`).toBeTruthy();
                expect(pkg.peerDependenciesMeta[name]?.optional, `${entry.id}: ${name} optional`).toBe(true);
            }
        }
    });

    test('every fixture with a driver package has a catalog entry', () => {
        const fixtures = new Set(FIXTURE_CATALOG.flatMap((e) => e.fixtures));
        const notFixtures = ['testData', 'any backend with `container: true`'];
        for (const key of Object.keys(FIXTURE_PACKAGES)) {
            const fixture = key.split(' (')[0];
            if (notFixtures.includes(fixture)) continue;
            expect(fixtures.has(fixture), key).toBe(true);
        }
    });

    test("services use the same images as Propmaster's own compose.test.yaml", () => {
        const compose = fs.readFileSync(path.join(REPO, 'compose.test.yaml'), 'utf-8');
        const services = new Map(FIXTURE_CATALOG.flatMap((e) => e.variants.flatMap((v) => v.services)).map((s) => [s.name, s]));
        expect(services.size).toBeGreaterThan(10);
        for (const svc of services.values()) {
            const image = /image: (\S+)/.exec(svc.yaml)![1];
            const block = new RegExp(`^  ${svc.name}:\\n(?:(?: {4}.*)?\\n)*?    image: (\\S+)`, 'm').exec(compose);
            expect(block?.[1], svc.name).toBe(image);
            expect(svc.yaml.startsWith(`  ${svc.name}:\n`)).toBe(true);
        }
    });

    test('every PW_* variable is one the config loader reads', () => {
        const loader = fs.readFileSync(path.join(REPO, 'src/config/loader.ts'), 'utf-8');
        for (const entry of FIXTURE_CATALOG) {
            for (const name of entry.variants.flatMap((v) => v.env.flatMap((s) => s.vars.map((x) => x.name)))) {
                expect(loader.includes(`'${name}'`) || loader.includes(`"${name}"`) || loader.includes(name), `${entry.id}: ${name}`).toBe(true);
            }
        }
    });

    test("every variant's local config loads through ConfigLoader unchanged", () => {
        const saved = { ...process.env };
        try {
            for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
            for (const entry of FIXTURE_CATALOG) {
                for (const variant of entry.variants) {
                    const root = project({ 'environments.json': '{ "environments": { "local": {} } }\n' });
                    const plan = planAdd(root, [{ id: entry.id, variant: variant.id }], { service: false, test: false });
                    applyPlan(root, plan, { install: false });
                    const loaded = new ConfigLoader(root).load('local') as unknown as Record<string, unknown>;
                    for (const item of variant.config) {
                        let value: unknown = loaded;
                        for (const key of item.path) value = (value as Record<string, unknown> | undefined)?.[key];
                        const what = `${entry.id}:${variant.id} ${item.path.join('.')}`;
                        if (item.value && typeof item.value === 'object') expect(value, what).toMatchObject(item.value as Record<string, unknown>);
                        else expect(value, what).toBe(item.value);
                    }
                }
            }
        } finally {
            process.env = saved;
        }
    });

    test('every starter test follows the test conventions, and ids and file names are unique', () => {
        const sources = FIXTURE_CATALOG.map((entry, i) => ({ file: `tests/${entry.starter.file}.spec.ts`, content: starterSource(entry, `TC-${entry.category}-${String(i + 1).padStart(3, '0')}`), kind: 'test' as const }));
        expect(checkSources(sources).violations).toEqual([]);
        expect(new Set(FIXTURE_CATALOG.map((e) => e.id)).size).toBe(FIXTURE_CATALOG.length);
        expect(new Set(FIXTURE_CATALOG.map((e) => `${e.testType}/${e.starter.file}`)).size).toBe(FIXTURE_CATALOG.length);
    });

    test('entries are found by id or fixture name; variants are checked', () => {
        expect(catalogEntry('Redis')?.id).toBe('redis');
        expect(catalogEntry('databaseClient')?.id).toBe('database');
        expect(parseRequest('database:mysql')).toEqual({ id: 'database', variant: 'mysql' });
        expect(resolveRequest({ id: 'kafka' }).variant.id).toBe('kafkajs');
        expect(() => resolveRequest({ id: 'cockroach' })).toThrow(/unknown fixture "cockroach". Choose from: openapi, graphql/);
        expect(() => resolveRequest({ id: 'database', variant: 'oracle' })).toThrow('database has no variant "oracle". Choose from: postgresql, mysql, mssql, sqlite');
    });
});

// ─── Editors ────────────────────────────────────────────────────────────────

test.describe('editing files in place', () => {
    test('JSON: adding a member and removing it gives back the exact text', () => {
        const cases: Array<[string, string[]]> = [
            [ENVIRONMENTS, ['environments', 'local']],
            [ENVIRONMENTS, ['environments', 'prod']],
            ['{}', []],
            ['{"a":1,"b":{"c":[1, 2]}}', ['b']],
            ['{\n\t"a": {\n\t\t"x": true\n\t}\n}\n', ['a']],
        ];
        for (const [text, at] of cases) {
            const added = addMember(text, at, 'redis', { host: 'localhost', ports: [1, 2], nested: { a: null } });
            expect(added).not.toBe(text);
            expect(JSON.parse(added)).toBeTruthy();
            expect(removeMember(added, at, 'redis')).toBe(text);
        }
        expect(addMember(ENVIRONMENTS, ['environments', 'local'], 'tags', 1)).toBe(ENVIRONMENTS);
        expect(removeMember(ENVIRONMENTS, ['environments', 'local'], 'missing')).toBe(ENVIRONMENTS);
    });

    test('JSON: removing the first member, and the formatting of what is added', () => {
        expect(removeMember('{\n    "a": 1,\n    "b": 2\n}', [], 'a')).toBe('{\n    "b": 2\n}');
        expect(formatJson({ brokers: ['k:9092'], s3: {} }, '    ', '    ')).toBe('{\n        "brokers": ["k:9092"],\n        "s3": {}\n    }');
        expect(() => parseJsonSpans('{\n  "a": 1,\n  oops\n}')).toThrow('invalid JSON at line 3: expected a key');
        expect(() => addMember('{"a": 1}', ['a'], 'x', 1)).toThrow('no object at a');
    });

    test('.env.example: a marked section is added once, skipped when its variables are there, and removed exactly', () => {
        const redis = catalogEntry('redis')!.variants[0].env[0];
        const added = addEnvSection(ENV_EXAMPLE, redis)!;
        expect(added).toContain('# ─── Redis ── propmaster fixture: redis\nPW_REDIS_HOST=localhost\nPW_REDIS_PORT=6379\n# PW_REDIS_PASSWORD=\n');
        expect(addEnvSection(added, redis)).toBe(added);
        expect(removeEnvSection(added, 'redis')).toBe(ENV_EXAMPLE);
        expect(removeEnvSection(addEnvSection(null, redis), 'redis')).toBeNull();
        const handWritten = 'PW_REDIS_HOST=cache\n# PW_REDIS_PORT=6380\nPW_REDIS_PASSWORD=x\n';
        expect(addEnvSection(handWritten, redis)).toBe(handWritten);
        const two = addEnvSection(addEnvSection(ENV_EXAMPLE, redis), catalogEntry('mongodb')!.variants[0].env[0])!;
        expect(removeEnvSection(two, 'redis')).toBe(addEnvSection(ENV_EXAMPLE, catalogEntry('mongodb')!.variants[0].env[0]));
    });

    test('compose: a service is added under services and removed exactly; a changed one is kept', () => {
        const svc = catalogEntry('redis')!.variants[0].services[0];
        const added = addService(COMPOSE, svc);
        expect(added).toContain(`    ports: ["3000:3000"]\n\n${svc.yaml}\n\nvolumes:`);
        expect(hasService(added, 'redis')).toBe(true);
        expect(addService(added, svc)).toBe(added);
        expect(removeService(added, svc)).toEqual({ text: COMPOSE, removed: true, edited: false });

        const fresh = addService(null, svc);
        expect(fresh.startsWith('# Services for the tests')).toBe(true);
        expect(removeService(fresh, svc).text).toBeNull();

        const changed = added.replace('image: redis:7', 'image: redis:8');
        expect(removeService(changed, svc)).toEqual({ text: changed, removed: false, edited: true });
        expect(addService('name: x\n', svc)).toBe(`name: x\n\nservices:\n${svc.yaml}\n`);
    });

    test('values for other environments: CHANGE_ME, except settings that are the same everywhere', () => {
        expect(placeholderValue({ type: 'mysql', host: 'localhost', port: 3306, brokers: ['localhost:9092'], trustServerCertificate: true })).toEqual({
            type: 'mysql',
            host: PLACEHOLDER,
            port: 3306,
            brokers: [PLACEHOLDER],
            trustServerCertificate: true,
        });
    });
});

// ─── Plans ──────────────────────────────────────────────────────────────────

test.describe('fixture add and remove', () => {
    for (const entry of FIXTURE_CATALOG) {
        for (const variant of entry.variants) {
            const name = entry.variants.length > 1 ? `${entry.id}:${variant.id}` : entry.id;
            test(`${name}: add then remove gives back every file; adding twice changes nothing`, () => {
                const root = project();
                const before = snapshot(root);
                const npm = fakeNpm();
                const plan = planAdd(root, [{ id: entry.id, variant: variant.id }]);
                expect(applyPlan(root, plan, { runner: npm.runner }).ok).toBe(true);
                const after = snapshot(root);
                expect(after).not.toEqual(before);
                expect(env(root).local).toMatchObject(Object.fromEntries(variant.config.map((i) => [i.path[0], expect.anything()])));
                if (variant.packages.length) expect(npm.commands).toEqual([`npm install --save-dev ${variant.packages.join(' ')}`]);

                const again = planAdd(root, [{ id: entry.id, variant: variant.id }]);
                expect(again.files.size).toBe(0);
                expect(again.install).toEqual([]);
                expect(again.lines.every((l) => l.sign === '·')).toBe(true);

                const state = fixtureStates(root).find((s) => s.entry === entry)!;
                expect(state.present).toBe(true);
                expect(state.variant?.id).toBe(variant.id);

                const removal = planRemove(root, entry.id);
                expect(removal.blockers).toEqual([]);
                applyPlan(root, removal, { runner: npm.runner });
                expect(snapshot(root)).toEqual(before);
                expect(fixtureStates(root).find((s) => s.entry === entry)!.present).toBe(false);
            });
        }
    }

    test('several at once, all of them, and back again', () => {
        const root = project();
        const before = snapshot(root);
        const npm = fakeNpm();
        applyPlan(root, planAdd(root, FIXTURE_CATALOG.map((e) => ({ id: e.id }))), { runner: npm.runner });
        expect(fixtureStates(root).every((s) => s.present)).toBe(true);
        for (const entry of [...FIXTURE_CATALOG].reverse()) applyPlan(root, planRemove(root, entry.id), { runner: npm.runner });
        expect(snapshot(root)).toEqual(before);
    });

    test('starter test IDs follow the ones in use, and share a category across fixtures', () => {
        const root = project({ 'tests/integration/existing.spec.ts': "import { test } from '@inluxc/propmaster';\ntest('[TC-AWS-007] x', { tag: ['@TC-AWS-007'] }, async () => { await test.step('s', async () => {}); });\n" });
        const plan = planAdd(root, [{ id: 's3' }, { id: 'sqs' }]);
        expect(plan.lines.filter((l) => l.kind === 'test').map((l) => l.text)).toEqual(['tests/integration/s3.spec.ts [TC-AWS-008]', 'tests/integration/sqs.spec.ts [TC-AWS-009]']);
        expect(plan.install).toEqual(['@aws-sdk/client-s3', '@aws-sdk/client-sqs', '@aws-sdk/client-sns']);
    });

    test('other environments get CHANGE_ME; a project without environments.json gets one, and loses it again', () => {
        const root = project();
        applyPlan(root, planAdd(root, [{ id: 'database', variant: 'mysql' }], { test: false }), { install: false });
        expect(env(root).dev.database).toEqual({ type: 'mysql', host: PLACEHOLDER, port: 3306, database: PLACEHOLDER, username: PLACEHOLDER, password: PLACEHOLDER });
        expect(env(root).prod.database.type).toBe('mysql');
        expect(read(root, 'environments.json')).toContain('"tags": ["a", "b"]'); // the rest is untouched

        const bare = project();
        fs.rmSync(path.join(bare, 'environments.json'));
        const plan = planAdd(bare, [{ id: 'redis' }], { test: false, service: false });
        expect(plan.lines[0].text).toBe('environments.json (new, with a local environment)');
        applyPlan(bare, plan, { runner: fakeNpm().runner });
        expect(env(bare).local.redis).toEqual({ host: 'localhost', port: 6379 });
        applyPlan(bare, planRemove(bare, 'redis'), { runner: fakeNpm().runner });
        expect(fs.existsSync(path.join(bare, 'environments.json'))).toBe(false);
    });

    test('an existing block of another type is kept, with a warning', () => {
        const root = project({
            'environments.json': '{ "environments": { "local": { "database": { "type": "postgresql", "host": "db", "database": "app" } } } }\n',
        });
        const plan = planAdd(root, [{ id: 'database', variant: 'mysql' }]);
        expect(formatFixturePlan(plan).join('\n')).toContain('! config    environments.json: local.database.type is "postgresql", not "mysql": change it');
    });

    test('remove keeps config with your own values and compose services you changed', () => {
        const root = project();
        const npm = fakeNpm();
        applyPlan(root, planAdd(root, [{ id: 'redis' }]), { runner: npm.runner });
        const environments = read(root, 'environments.json').replace('"redis": {\n                "host": "CHANGE_ME"', '"redis": {\n                "host": "cache.dev.internal"');
        fs.writeFileSync(path.join(root, 'environments.json'), environments);
        fs.writeFileSync(path.join(root, 'compose.test.yaml'), read(root, 'compose.test.yaml').replace('redis:7', 'redis:8'));
        const plan = planRemove(root, 'redis');
        const text = formatFixturePlan(plan).join('\n');
        expect(text).toContain('- config    environments.json: local.redis, prod.redis');
        expect(text).toContain('! config    environments.json: dev.redis kept (your own values');
        expect(text).toContain('! service   compose.test.yaml: redis kept (changed since it was added');
        applyPlan(root, plan, { runner: npm.runner });
        expect(env(root).dev.redis.host).toBe('cache.dev.internal');
        expect(env(root).local.redis).toBeUndefined();
    });

    test('remove keeps what another fixture still uses: the AWS settings, variables and service', () => {
        const root = project();
        const npm = fakeNpm();
        applyPlan(root, planAdd(root, [{ id: 's3' }, { id: 'sqs' }]), { runner: npm.runner });
        applyPlan(root, planRemove(root, 's3'), { runner: npm.runner });
        expect(env(root).local.aws).toEqual({ endpoint: 'http://localhost:4566', region: 'us-east-1' });
        expect(read(root, '.env.example')).toContain('PW_AWS_ENDPOINT=');
        expect(read(root, '.env.example')).not.toContain('PW_AWS_S3_BUCKET');
        expect(hasService(read(root, 'compose.test.yaml'), 'moto')).toBe(true);
        expect(npm.commands.at(-1)).toBe('npm uninstall @aws-sdk/client-s3');
    });

    test('remove refuses while other tests use the fixture, and a changed starter counts as one', () => {
        const root = project();
        const npm = fakeNpm();
        applyPlan(root, planAdd(root, [{ id: 'redis' }]), { runner: npm.runner });
        fs.writeFileSync(
            path.join(root, 'tests/integration/cache.spec.ts'),
            "import { test, expect } from '@inluxc/propmaster';\ntest('[TC-RDS-002] cache', { tag: ['@TC-RDS-002'] }, async ({ redisClient }) => {\n    await test.step('s', async () => expect(await redisClient.get('k')).toBeNull());\n});\n",
        );
        const blocked = planRemove(root, 'redis');
        expect(blocked.blockers).toEqual(['tests/integration/cache.spec.ts']);
        expect(formatFixturePlan(blocked).join('\n')).toContain("Can't remove redis: these tests still use redisClient:");
        expect(() => applyPlan(root, blocked)).toThrow("can't remove redis: tests still use it (tests/integration/cache.spec.ts)");

        fs.rmSync(path.join(root, 'tests/integration/cache.spec.ts'));
        fs.appendFileSync(path.join(root, 'tests/integration/redis.spec.ts'), '// mine now\n');
        expect(planRemove(root, 'redis').blockers).toEqual(['tests/integration/redis.spec.ts']);
    });

    test('package managers: chosen by lock file, with their own commands', () => {
        const root = project();
        expect(packageManager(root)).toBe('npm');
        for (const [lock, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun']] as const) {
            const r = project({ [lock]: '' });
            expect(packageManager(r)).toBe(pm);
        }
        expect(packageCommand('npm', 'install', ['pg'])).toEqual(['npm', 'install', '--save-dev', 'pg']);
        expect(packageCommand('pnpm', 'install', ['pg'])).toEqual(['pnpm', 'add', '-D', 'pg']);
        expect(packageCommand('yarn', 'uninstall', ['pg'])).toEqual(['yarn', 'remove', 'pg']);
        expect(packageCommand('bun', 'install', ['pg'])).toEqual(['bun', 'add', '-d', 'pg']);
    });
});

// ─── CLI and MCP ────────────────────────────────────────────────────────────

test.describe('the fixture command and MCP tools', () => {
    test('list, a dry run that writes nothing, an unknown fixture, and no terminal to pick in', async () => {
        const root = project();
        const lines: string[] = [];
        const log = (l = '') => void lines.push(l);
        expect(await runFixture(['list', '--json', '--root', root], log)).toBe(0);
        expect(JSON.parse(lines.join('\n')).find((f: { id: string }) => f.id === 'database')).toEqual({
            id: 'database',
            label: 'SQL database',
            fixtures: ['databaseClient'],
            present: false,
            variants: ['postgresql', 'mysql', 'mssql', 'sqlite'],
        });

        const before = snapshot(root);
        lines.length = 0;
        expect(await runFixture(['add', 'redis', '--dry-run', '--root', root], log)).toBe(0);
        expect(lines.join('\n')).toContain('Dry run: nothing changed.');
        expect(snapshot(root)).toEqual(before);

        lines.length = 0;
        expect(await runFixture(['add', 'nope', '--root', root], log)).toBe(2);
        expect(lines.join('\n')).toContain('unknown fixture "nope"');

        await expect(runFixture(['add', '--root', root], log)).rejects.toBeInstanceOf(NotInteractiveError);
    });

    test('add with names asks nothing and applies; --no-install prints the command instead', async () => {
        const root = project();
        const npm = fakeNpm();
        const lines: string[] = [];
        expect(await runFixture(['add', 'redis', 'kafka:confluent', '--no-service', '--root', root], (l = '') => void lines.push(l), npm.runner)).toBe(0);
        expect(npm.commands).toEqual(['npm install --save-dev ioredis @confluentinc/kafka-javascript']);
        expect(env(root).local.kafka).toEqual({ brokers: ['localhost:9092'], driver: 'confluent' });
        expect(read(root, 'compose.test.yaml')).toBe(COMPOSE);

        const other = project();
        const out: string[] = [];
        expect(await runFixture(['add', 'mongodb', '--no-install', '--root', other], (l = '') => void out.push(l), npm.runner)).toBe(0);
        expect(out.join('\n')).toContain('Run: npm install --save-dev mongodb');
        expect(npm.commands).toHaveLength(1);
    });

    test('MCP: fixtures_list, fixture_add as a plan then applied, fixture_remove refused while tests use it', async () => {
        const root = project();
        const npm = fakeNpm();
        const tools = Object.fromEntries(projectTools(root, npm.runner).map((t) => [t.name, t]));
        expect(Object.keys(tools)).toEqual(['fixtures_list', 'fixture_add', 'fixture_remove', 'environments_list', 'environment_add', 'doctor']);

        const before = snapshot(root);
        const dry = (await tools.fixture_add.handler({ fixtures: ['redis'] })) as Record<string, unknown>;
        expect(dry).toMatchObject({ applied: false, reason: 'Dry run. Call again with apply: true to make these changes.', install: ['ioredis'] });
        expect((dry.plan as string[])[0]).toBe('Add redis');
        expect(snapshot(root)).toEqual(before);

        const applied = (await tools.fixture_add.handler({ fixtures: ['redis'], apply: true })) as Record<string, unknown>;
        expect(applied).toMatchObject({ applied: true, ok: true, command: 'npm install --save-dev ioredis', output: 'install ioredis' });
        const list = (await tools.fixtures_list.handler({})) as { fixtures: Array<{ id: string; present: boolean }> };
        expect(list.fixtures.find((f) => f.id === 'redis')!.present).toBe(true);

        fs.appendFileSync(path.join(root, 'tests/integration/redis.spec.ts'), '// changed\n');
        const refused = (await tools.fixture_remove.handler({ fixture: 'redis', apply: true })) as Record<string, unknown>;
        expect(refused).toMatchObject({ applied: false, blockedBy: ['tests/integration/redis.spec.ts'] });

        await expect(tools.fixture_add.handler({ fixtures: [] })).rejects.toThrow('fixtures must be a non-empty array');
        await expect(tools.fixture_add.handler({ fixtures: ['nope'] })).rejects.toThrow('unknown fixture "nope"');
        await expect(tools.fixture_remove.handler({ fixture: 'redis', apply: 'yes' })).rejects.toThrow('apply must be true or false');
    });
});
