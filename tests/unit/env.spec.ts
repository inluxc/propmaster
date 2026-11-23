/**
 * Unit tests for `propmaster env list | add`, the production mark the MCP
 * server honours, and the environment MCP tools, on scratch projects.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyEnvPlan, envFileFor, formatEnvPlan, gitIgnores, isProduction, listEnvironments, nameProblem, newEnvironmentBlock, planEnvAdd, runEnv } from '../../src/cli/env';
import { PLACEHOLDER } from '../../src/cli/fixture-catalog';
import { ConfigLoader } from '../../src/config/loader';
import { createPropmasterMcpServer } from '../../src/mcp/server';
import { projectTools } from '../../src/mcp/project-tools';
import { NotInteractiveError } from '../../src/cli/prompts';

const ENVIRONMENTS = `{
    "environments": {
        "local": {
            "database": { "type": "postgresql", "host": "localhost", "port": 5432, "database": "testdb", "username": "testuser", "password": "testpass" },
            "redis": { "host": "localhost", "port": 6379 }
        },
        "dev": {
            "openapi": { "baseUrl": "https://dev.example.com" },
            "kafka": { "brokers": ["k1.dev:9092", "k2.dev:9092"], "ssl": true, "sasl": { "mechanism": "plain", "username": "svc", "password": "s3cret" } },
            "secrets": { "provider": "vault", "options": { "address": "https://vault.example.com", "token": "hvs.abc" }, "keyMappings": { "kafka-password": "kafka.sasl.password" } }
        }
    }
}
`;

function project(files: Record<string, string> = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-env-'));
    const all: Record<string, string> = {
        'package.json': '{ "name": "scratch" }\n',
        'environments.json': ENVIRONMENTS,
        '.gitignore': 'node_modules/\n.env\n.env.*\n!.env.example\n',
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) fs.writeFileSync(path.join(root, rel), content);
    return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const envs = (root: string) => JSON.parse(read(root, 'environments.json')).environments;

test.describe('new environment blocks', () => {
    test('values become CHANGE_ME, settings that are the same everywhere stay, credentials come out empty', () => {
        const dev = JSON.parse(ENVIRONMENTS).environments.dev;
        expect(newEnvironmentBlock(dev, false)).toEqual({
            openapi: { baseUrl: PLACEHOLDER },
            kafka: { brokers: [PLACEHOLDER, PLACEHOLDER], ssl: true, sasl: { mechanism: PLACEHOLDER, username: PLACEHOLDER, password: '' } },
            // secrets is copied as is: its key mappings are references, not secrets. Its token isn't.
            secrets: { provider: 'vault', options: { address: 'https://vault.example.com', token: '' }, keyMappings: { 'kafka-password': 'kafka.sasl.password' } },
        });
    });

    test('--copy-values keeps the values, still without credentials, and never the production mark', () => {
        expect(newEnvironmentBlock({ production: true, redis: { host: 'cache', port: 6380, password: 'x' }, aws: { accessKeyId: 'AKIA', secretAccessKey: 'shh', region: 'eu-west-1' } }, true)).toEqual({
            redis: { host: 'cache', port: 6380, password: '' },
            aws: { accessKeyId: '', secretAccessKey: '', region: 'eu-west-1' },
        });
    });

    test('names: production by name or mark; what a new name may be', () => {
        for (const name of ['prod', 'PRODUCTION', 'prd', 'live']) expect(isProduction(name)).toBe(true);
        expect(isProduction('stg')).toBe(false);
        expect(isProduction('stg', { production: true })).toBe(true);
        expect(nameProblem('stg', ['local'])).toBeUndefined();
        expect(nameProblem('local', ['local'])).toBe('"local" already exists');
        expect(nameProblem('my env', [])).toBe('letters, digits, - and _ only, starting with a letter or digit');
        expect(nameProblem('example', [])).toBe('"example" is taken by .env.example');
    });

    test('.gitignore: last matching pattern wins, ! un-ignores, paths with a slash are ignored here', () => {
        expect(gitIgnores('.env.*\n!.env.example\n', '.env.stg')).toBe(true);
        expect(gitIgnores('.env.*\n!.env.example\n', '.env.example')).toBe(false);
        expect(gitIgnores('.env*\n', '.env.stg')).toBe(true);
        expect(gitIgnores('/.env.stg\n', '.env.stg')).toBe(true);
        expect(gitIgnores('.env\n', '.env.stg')).toBe(false);
        expect(gitIgnores('.env.*\n!.env.stg\n', '.env.stg')).toBe(false);
        expect(gitIgnores('config/.env.*\n# .env.*\n', '.env.stg')).toBe(false);
    });

    test('the .env file lists every variable of the blocks, commented out, grouped by fixture', () => {
        const text = envFileFor('stg', { redis: {}, aws: {}, secrets: {} });
        expect(text).toContain('# Settings for the "stg" environment (PW_ENVIRONMENT=stg).');
        expect(text).toContain('# ─── Redis\n# PW_REDIS_HOST=\n# PW_REDIS_PORT=\n# PW_REDIS_PASSWORD=');
        expect(text).toContain('# ─── AWS (S3, SQS, SNS, DynamoDB)\n# PW_AWS_ENDPOINT=\n# PW_AWS_REGION=\n\n# ─── S3\n# PW_AWS_S3_BUCKET=');
        expect(text.match(/PW_AWS_ENDPOINT/g)).toHaveLength(1); // s3, sqs and dynamodb share it: listed once
        expect(text.split('\n').filter((l) => l.startsWith('PW_'))).toEqual([]); // nothing set
    });
});

test.describe('env add', () => {
    test('copies local by default, writes .env.<name>, leaves the rest of environments.json alone, and the result loads', () => {
        const root = project();
        const plan = planEnvAdd(root, 'stg');
        expect(formatEnvPlan(plan)).toEqual([
            'Add environment stg',
            '  + config    environments.json: stg from local (database, redis, CHANGE_ME to fill in; credentials left empty)',
            '  + variables .env.stg (9 variables, commented out)',
        ]);
        expect([...plan.files.keys()].sort()).toEqual(['.env.stg', 'environments.json']);
        applyEnvPlan(root, plan);
        expect(read(root, 'environments.json').startsWith(ENVIRONMENTS.slice(0, ENVIRONMENTS.lastIndexOf('        }\n    }')))).toBe(true);
        expect(envs(root).stg).toEqual({
            database: { type: 'postgresql', host: PLACEHOLDER, port: 5432, database: PLACEHOLDER, username: PLACEHOLDER, password: '' },
            redis: { host: PLACEHOLDER, port: 6379 },
        });

        const saved = { ...process.env };
        try {
            for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
            const config = new ConfigLoader(root).load('stg');
            expect(config.database).toEqual(envs(root).stg.database); // the commented-out .env.stg overrides nothing
        } finally {
            process.env = saved;
        }
        expect(planEnvAdd(root, 'stg').blockers).toEqual(['can\'t add "stg": "stg" already exists.']);
    });

    test('--from, --empty, an unknown source, and no environments.json', () => {
        const root = project();
        expect(planEnvAdd(root, 'qa', { from: 'dev' }).lines[0].text).toBe(
            'environments.json: qa from dev (openapi, kafka, secrets, CHANGE_ME to fill in; credentials left empty)',
        );
        const empty = planEnvAdd(root, 'scratch', { from: null });
        applyEnvPlan(root, empty);
        expect(envs(root).scratch).toEqual({});
        expect(read(root, '.env.scratch')).not.toContain('# ───');
        expect(planEnvAdd(root, 'qa', { from: 'stg' }).blockers).toEqual(['no environment "stg" to copy. Environments: local, dev, scratch.']);

        const bare = project();
        fs.rmSync(path.join(bare, 'environments.json'));
        expect(planEnvAdd(bare, 'stg').blockers).toEqual(['environments.json not found: run `npx propmaster init` first.']);
        expect(() => applyEnvPlan(bare, planEnvAdd(bare, 'stg'))).toThrow('environments.json not found');
    });

    test('production: by name, or --prod for any name; --no-prod overrides the name', () => {
        const root = project();
        applyEnvPlan(root, planEnvAdd(root, 'prod'));
        applyEnvPlan(root, planEnvAdd(root, 'eu-main', { production: true }));
        applyEnvPlan(root, planEnvAdd(root, 'live', { production: false }));
        expect(envs(root).prod.production).toBe(true);
        expect(Object.keys(envs(root)['eu-main'])[0]).toBe('production');
        expect(envs(root).live.production).toBeUndefined();
        expect(listEnvironments(root).map((e) => [e.name, e.production])).toEqual([
            ['local', false],
            ['dev', false],
            ['prod', true],
            ['eu-main', true],
            ['live', true], // its name still makes it production
        ]);
    });

    test('.env.<name> is kept out of git when the .gitignore does not cover it, and an existing one is kept', () => {
        const root = project({ '.gitignore': 'node_modules/\n.env\n' });
        const plan = planEnvAdd(root, 'stg');
        expect(plan.lines.at(-1)).toEqual({ sign: '+', kind: 'git', text: '.gitignore: .env.stg' });
        applyEnvPlan(root, plan);
        expect(read(root, '.gitignore')).toBe('node_modules/\n.env\n.env.stg\n');

        const noGit = project();
        fs.rmSync(path.join(noGit, '.gitignore'));
        expect(planEnvAdd(noGit, 'stg').files.has('.gitignore')).toBe(false); // not a git project: leave it

        const kept = project({ '.env.stg': 'PW_REDIS_HOST=cache\n' });
        const again = planEnvAdd(kept, 'stg');
        expect(again.lines.find((l) => l.kind === 'variables')).toEqual({ sign: '·', kind: 'variables', text: '.env.stg already exists' });
        applyEnvPlan(kept, again);
        expect(read(kept, '.env.stg')).toBe('PW_REDIS_HOST=cache\n');
    });

    test('list: production, the blocks, the .env file, and what is still CHANGE_ME', () => {
        const root = project();
        applyEnvPlan(root, planEnvAdd(root, 'stg'));
        expect(listEnvironments(root).find((e) => e.name === 'stg')).toEqual({
            name: 'stg',
            production: false,
            blocks: ['database', 'redis'],
            envFile: true,
            placeholders: ['database.host', 'database.database', 'database.username', 'redis.host'],
        });
    });
});

test.describe('env command and MCP', () => {
    test('the CLI: list --json, a dry run, a bad name, and no terminal to ask in', async () => {
        const root = project();
        const lines: string[] = [];
        const log = (l = '') => void lines.push(l);
        expect(await runEnv(['list', '--json', '--root', root], log)).toBe(0);
        expect(JSON.parse(lines.join('\n')).map((e: { name: string }) => e.name)).toEqual(['local', 'dev']);

        const before = read(root, 'environments.json');
        lines.length = 0;
        expect(await runEnv(['add', 'stg', '--from', 'dev', '--prod', '--dry-run', '--root', root], log)).toBe(0);
        expect(lines.join('\n')).toContain('Add environment stg (production)');
        expect(read(root, 'environments.json')).toBe(before);
        expect(fs.existsSync(path.join(root, '.env.stg'))).toBe(false);

        lines.length = 0;
        expect(await runEnv(['add', 'dev', '--root', root], log)).toBe(2);
        expect(lines.join('\n')).toContain('"dev" already exists');

        expect(await runEnv(['add', 'qa', '--empty', '--root', root], log)).toBe(0);
        expect(envs(root).qa).toEqual({});

        await expect(runEnv(['add', '--root', root], log)).rejects.toBeInstanceOf(NotInteractiveError);
    });

    test('the MCP server refuses an environment marked production, as it does one named prod', async () => {
        const root = project();
        applyEnvPlan(root, planEnvAdd(root, 'eu-main', { production: true }));
        const logs: string[] = [];
        await expect(createPropmasterMcpServer({ root, environment: 'eu-main', allowWrites: false, allowProd: false }, (l) => void logs.push(l))).rejects.toThrow(
            'Refusing to start for environment "eu-main"',
        );
        const created = await createPropmasterMcpServer({ root, environment: 'eu-main', allowWrites: true, allowProd: true }, (l) => void logs.push(l));
        try {
            expect(created.context.allowWrites).toBe(false);
            expect(logs.join('\n')).toContain('--allow-writes ignored: "eu-main" is a production environment');
        } finally {
            await created.close();
        }
    });

    test('environments_list and environment_add: a plan, then applied; a taken name is refused', async () => {
        const root = project();
        const tools = Object.fromEntries(projectTools(root).map((t) => [t.name, t]));
        const dry = (await tools.environment_add.handler({ name: 'stg', from: 'dev' })) as Record<string, unknown>;
        expect(dry).toMatchObject({ applied: false, files: ['environments.json', '.env.stg'] });
        expect(envs(root).stg).toBeUndefined();

        const applied = (await tools.environment_add.handler({ name: 'stg', from: 'dev', apply: true })) as Record<string, unknown>;
        expect(applied).toMatchObject({ applied: true, written: ['environments.json', '.env.stg'] });
        expect(envs(root).stg.kafka.sasl.password).toBe('');

        const taken = (await tools.environment_add.handler({ name: 'stg', apply: true })) as Record<string, unknown>;
        expect(taken).toMatchObject({ applied: false, reason: 'can\'t add "stg": "stg" already exists.' });

        const list = (await tools.environments_list.handler({})) as { environments: Array<{ name: string }> };
        expect(list.environments.map((e) => e.name)).toEqual(['local', 'dev', 'stg']);
        await expect(tools.environment_add.handler({ name: 'x', from: 3 })).rejects.toThrow('from must be an environment name or null');
    });
});
