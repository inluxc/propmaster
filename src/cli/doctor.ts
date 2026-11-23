/**
 * `propmaster doctor`: finds what's wrong with a project's setup before a
 * test run does, says how to fix each problem, and with `--fix` applies the
 * safe fixes (installing a missing driver, adding a missing config block,
 * keeping .env files out of git, matching the CI image to Playwright).
 *
 * Each check returns findings: ok, warn (works, but look at it), fail (tests
 * will break) or skip. The exit code is 1 while a failure remains.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as path from 'node:path';
import { checkQuarantine, collect, findProjectRoot } from './check-tests.js';
import { FIXTURE_CATALOG, PLACEHOLDER, type CatalogEntry, type FixtureVariant } from './fixture-catalog.js';
import {
    COMPOSE_FILE,
    ENVIRONMENTS_FILE,
    applyPlan,
    hasService,
    inheritRunner,
    installedPackages,
    packageCommand,
    packageManager,
    planAdd,
    testFixtures,
    type CommandRunner,
} from './fixture.js';
import { gitIgnores, isProduction } from './env.js';
import { valueAt } from './json-edit.js';
import { ConfigLoader } from '../config/loader.js';
import type { FrameworkConfig } from '../config/schema.js';
import { styleFor } from './style.js';

export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface Fix {
    /** What the fix does, or the command to run by hand. */
    text: string;
    /** `--fix` applies it. Unsafe fixes are only printed. */
    safe: boolean;
    /** Applies it; returns whether it worked. Absent for fixes you do by hand. */
    apply?: () => boolean | Promise<boolean>;
}

export interface Finding {
    check: string;
    status: Status;
    message: string;
    fix?: Fix;
}

export interface DoctorOptions {
    /** The environment to check (default: PW_ENVIRONMENT, else local). */
    environment?: string;
    /** Don't try to reach the backends. */
    offline?: boolean;
    /** Skip starting the MCP server (the MCP tool, which is that server). */
    skipMcp?: boolean;
    /** Runs the package manager for fixes. */
    runner?: CommandRunner;
    /** Whether host:port accepts a connection (tests replace it). */
    reachable?: (host: string, port: number) => Promise<boolean>;
    /** Process environment (tests replace it). */
    env?: NodeJS.ProcessEnv;
    /** Node.js version (tests replace it). */
    nodeVersion?: string;
}

/** Propmaster's own Node.js requirement. */
export const MIN_NODE = '22.12.0';

const ok = (check: string, message: string): Finding => ({ check, status: 'ok', message });

// ─── Helpers ────────────────────────────────────────────────────────────────

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
}

/** Whether `pkg` is installed in the project's node_modules (not just listed in package.json). */
export function packageResolvable(root: string, pkg: string): boolean {
    return fs.existsSync(path.join(root, 'node_modules', ...pkg.split('/'), 'package.json'));
}

function readJson(file: string): Record<string, unknown> | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/** The config block a catalog entry lives under (e.g. `aws` for s3). */
const blockOf = (entry: CatalogEntry) => entry.variants[0].config[0].path[0];

/** The variant the config asks for: database by `type`, kafka by `driver`, search by its service. */
function variantFor(entry: CatalogEntry, config: FrameworkConfig | undefined): FixtureVariant {
    const block = (config as Record<string, unknown> | undefined)?.[blockOf(entry)] as Record<string, unknown> | undefined;
    if (entry.id === 'database' && block?.type) return entry.variants.find((v) => v.id === block.type) ?? entry.variants[0];
    if (entry.id === 'kafka' && block?.driver) return entry.variants.find((v) => v.id === block.driver) ?? entry.variants[0];
    return entry.variants[0];
}

/** Every value that's still CHANGE_ME in `block`, as dotted paths. */
export function placeholdersIn(block: unknown, at = ''): string[] {
    if (block === PLACEHOLDER) return [at];
    if (Array.isArray(block)) return block.flatMap((v, i) => placeholdersIn(v, `${at}[${i}]`));
    if (block && typeof block === 'object') return Object.entries(block).flatMap(([k, v]) => placeholdersIn(v, at ? `${at}.${k}` : k));
    return [];
}

const DEFAULT_PORTS: Record<string, number> = {
    'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'bolt:': 7687, 'neo4j:': 7687, 'bolt+s:': 7687, 'neo4j+s:': 7687,
    'amqp:': 5672, 'amqps:': 5671, 'mongodb:': 27017, 'grpc:': 443, 'grpcs:': 443, 'redis:': 6379,
};

function fromUrl(url: string): { host: string; port: number } | null {
    try {
        const u = new URL(url);
        const port = u.port ? parseInt(u.port, 10) : DEFAULT_PORTS[u.protocol];
        return u.hostname && port ? { host: u.hostname.replace(/^\[|\]$/g, ''), port } : null;
    } catch {
        return null;
    }
}

function fromHostPort(value: string, defaultPort: number): { host: string; port: number } {
    const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(value.trim());
    return { host: m?.[1] ?? value, port: m?.[2] ? parseInt(m[2], 10) : defaultPort };
}

const DB_PORTS: Record<string, number> = { postgresql: 5432, mysql: 3306, mssql: 1433 };

/** Where each configured backend listens, by config block. Blocks with placeholders, or none (real AWS, sqlite), are left out. */
export function backendAddresses(config: FrameworkConfig): Array<{ block: string; host: string; port: number }> {
    const c = config as unknown as Record<string, Record<string, unknown> | undefined>;
    const out: Array<{ block: string; host: string; port: number }> = [];
    const add = (block: string, address: { host: string; port: number } | null) => {
        if (address && address.host !== PLACEHOLDER && !address.host.includes(PLACEHOLDER)) out.push({ block, ...address });
    };
    const str = (v: unknown) => (typeof v === 'string' && v && v !== PLACEHOLDER ? v : undefined);
    const db = c.database;
    if (db && db.type !== 'sqlite' && str(db.host)) add('database', { host: String(db.host), port: Number(db.port) || DB_PORTS[String(db.type)] || 5432 });
    if (c.redis && str(c.redis.host)) add('redis', { host: String(c.redis.host), port: Number(c.redis.port) || 6379 });
    const mongo = c.mongodb;
    if (mongo) {
        if (str(mongo.uri) && !String(mongo.uri).startsWith('mongodb+srv:')) add('mongodb', fromUrl(String(mongo.uri).split(',')[0]));
        else if (str(mongo.host) && !mongo.srv) add('mongodb', { host: String(mongo.host), port: Number(mongo.port) || 27017 });
    }
    if (c.neo4j && str(c.neo4j.uri)) add('neo4j', fromUrl(String(c.neo4j.uri)));
    if (c.cassandra && Array.isArray(c.cassandra.contactPoints) && str(c.cassandra.contactPoints[0])) {
        add('cassandra', fromHostPort(String(c.cassandra.contactPoints[0]), Number(c.cassandra.port) || 9042));
    }
    if (c.kafka && Array.isArray(c.kafka.brokers) && str(c.kafka.brokers[0])) add('kafka', fromHostPort(String(c.kafka.brokers[0]), 9092));
    if (c.amqp) {
        if (str(c.amqp.url)) add('amqp', fromUrl(String(c.amqp.url)));
        else if (str(c.amqp.host)) add('amqp', { host: String(c.amqp.host), port: Number(c.amqp.port) || 5672 });
    }
    if (c.aws && str(c.aws.endpoint)) add('aws', fromUrl(String(c.aws.endpoint)));
    for (const [block, key] of [['search', 'url'], ['realtime', 'url'], ['inbox', 'url'], ['mock', 'url'], ['openapi', 'baseUrl'], ['graphql', 'endpoint'], ['appium', 'serverUrl']] as const) {
        const value = str(c[block]?.[key]);
        if (value) add(block, fromUrl(value));
    }
    if (c.grpc && str(c.grpc.address)) {
        const address = String(c.grpc.address);
        add('grpc', /^grpcs?:\/\//.test(address) ? fromUrl(address) : fromHostPort(address, 443));
    }
    return out;
}

/** Whether a TCP connection to host:port opens within `timeoutMs`. */
export function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (result: boolean) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

// ─── The checks ─────────────────────────────────────────────────────────────

interface Context {
    root: string;
    environment: string;
    options: DoctorOptions;
    runner: CommandRunner;
    /** The loaded config, or undefined when it couldn't be loaded. */
    config?: FrameworkConfig;
    configError?: string;
    /** Fixture names the tests request. */
    used: Set<string>;
    /** Catalog entries the tests use. */
    entries: CatalogEntry[];
}

function checkNode(ctx: Context): Finding[] {
    const version = (ctx.options.nodeVersion ?? process.versions.node).replace(/^v/, '');
    if (compareVersions(version, MIN_NODE) < 0) {
        return [{ check: 'node', status: 'fail', message: `Node.js ${version} is too old: Propmaster needs ${MIN_NODE} or newer.`, fix: { text: `Install Node.js ${MIN_NODE}+ (e.g. \`nvm install 24\`)`, safe: false } }];
    }
    return [ok('node', `Node.js ${version}`)];
}

function checkConfig(ctx: Context): Finding[] {
    const file = path.join(ctx.root, ENVIRONMENTS_FILE);
    if (!fs.existsSync(file)) {
        return [{ check: 'config', status: 'fail', message: `${ENVIRONMENTS_FILE} not found.`, fix: { text: 'npx propmaster init (or create it: { "environments": { "local": {} } })', safe: false } }];
    }
    if (ctx.configError) return [{ check: 'config', status: 'fail', message: ctx.configError }];
    const findings: Finding[] = [];
    const text = fs.readFileSync(file, 'utf-8');
    const block = valueAt(text, ['environments', ctx.environment]);
    if (block === undefined) {
        const names = Object.keys((valueAt(text, ['environments']) as Record<string, unknown>) ?? {});
        findings.push({
            check: 'config',
            status: 'fail',
            message: `environment "${ctx.environment}" isn't in ${ENVIRONMENTS_FILE} (it has ${names.join(', ') || 'none'}).`,
            fix: { text: `npx propmaster env add ${ctx.environment}, or set PW_ENVIRONMENT to one of those`, safe: false },
        });
        return findings;
    }
    findings.push(ok('config', `environment "${ctx.environment}"${isProduction(ctx.environment, block) ? ' (production)' : ''} loads`));

    // Every fixture the tests use needs its block (otp works without one).
    for (const entry of ctx.entries) {
        if (entry.id === 'otp') continue;
        const key = blockOf(entry);
        if ((ctx.config as unknown as Record<string, unknown>)[key] !== undefined) continue;
        const fixture = entry.fixtures.find((f) => ctx.used.has(f))!;
        findings.push({
            check: 'config',
            status: 'fail',
            message: `tests use ${fixture}, but "${ctx.environment}" has no ${key} config.`,
            fix: {
                text: `add the ${key} block to every environment (\`propmaster fixture add ${entry.id} --no-test --no-service --no-install\`)`,
                safe: true,
                apply: () => {
                    const variant = variantFor(entry, ctx.config);
                    applyPlan(ctx.root, planAdd(ctx.root, [{ id: entry.id, variant: variant.id }], { service: false, test: false }), { install: false });
                    return true;
                },
            },
        });
    }

    const placeholders = placeholdersIn(block);
    if (placeholders.length) {
        findings.push({
            check: 'config',
            status: 'warn',
            message: `${placeholders.length} value${placeholders.length > 1 ? 's' : ''} in "${ctx.environment}" still ${PLACEHOLDER}: ${placeholders.slice(0, 6).join(', ')}${placeholders.length > 6 ? ', ...' : ''}`,
            fix: { text: `fill them in, in ${ENVIRONMENTS_FILE} or .env.${ctx.environment}`, safe: false },
        });
    }
    return findings;
}

function checkDrivers(ctx: Context): Finding[] {
    const findings: Finding[] = [];
    const installedOk: string[] = [];
    const listed = installedPackages(ctx.root);
    for (const entry of ctx.entries) {
        const variant = variantFor(entry, ctx.config);
        const fixture = entry.fixtures.find((f) => ctx.used.has(f))!;
        const missing = variant.packages.filter((p) => !packageResolvable(ctx.root, p));
        if (!variant.packages.length) continue;
        if (!missing.length) {
            installedOk.push(...variant.packages);
            continue;
        }
        const notListed = missing.filter((p) => !listed.has(p));
        const command = notListed.length ? packageCommand(packageManager(ctx.root), 'install', notListed) : [packageManager(ctx.root), 'install'];
        findings.push({
            check: 'drivers',
            status: 'fail',
            message: notListed.length
                ? `tests use ${fixture}, but ${notListed.join(', ')} ${notListed.length > 1 ? "aren't" : "isn't"} installed${variant.id !== 'default' ? ` (${variant.label})` : ''}.`
                : `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} in package.json but not in node_modules.`,
            fix: { text: command.join(' '), safe: true, apply: () => ctx.runner(command, ctx.root).ok },
        });
    }
    if (installedOk.length) findings.unshift(ok('drivers', `installed for the fixtures the tests use: ${installedOk.join(', ')}`));
    return findings;
}

async function checkBackends(ctx: Context): Promise<Finding[]> {
    if (!ctx.config) return [];
    if (ctx.options.offline) return [{ check: 'backends', status: 'skip', message: 'not checked (--offline)' }];
    const reachable = ctx.options.reachable ?? ((h, p) => tcpReachable(h, p));
    const usedBlocks = new Set(ctx.entries.map(blockOf));
    const addresses = backendAddresses(ctx.config);
    const compose = fs.existsSync(path.join(ctx.root, COMPOSE_FILE)) ? fs.readFileSync(path.join(ctx.root, COMPOSE_FILE), 'utf-8') : null;
    const results = await Promise.all(addresses.map(async (a) => ({ ...a, up: await reachable(a.host, a.port) })));
    const answering = results.filter((r) => r.up).map((r) => `${r.block} (${r.host}:${r.port})`);
    const head: Finding[] = answering.length ? [ok('backends', `answering: ${answering.join(', ')}`)] : [];
    return head.concat(results.filter((r) => !r.up).map(({ block, host, port }): Finding => {
        const services = FIXTURE_CATALOG.filter((e) => blockOf(e) === block)
            .flatMap((e) => e.variants.flatMap((v) => v.services.map((s) => s.name)))
            .filter((name, i, all) => all.indexOf(name) === i && hasService(compose, name));
        return {
            check: 'backends',
            status: usedBlocks.has(block) ? 'fail' : 'warn',
            message: `${block} at ${host}:${port} doesn't answer${usedBlocks.has(block) ? '' : ' (no test uses it yet)'}.`,
            fix: { text: services.length ? `docker compose -f ${COMPOSE_FILE} up -d --wait ${services.join(' ')}` : `start it, or point ${block} in ${ENVIRONMENTS_FILE} at where it runs`, safe: false },
        };
    }));
}

function checkPlaywright(ctx: Context): Finding[] {
    const findings: Finding[] = [];
    const configFile = fs.readdirSync(ctx.root).find((f) => /^playwright\.config\.(?:c|m)?[jt]s$/.test(f));
    if (!configFile) {
        return [{ check: 'playwright', status: 'fail', message: 'no playwright.config.ts.', fix: { text: 'npx propmaster init', safe: false } }];
    }
    const text = fs.readFileSync(path.join(ctx.root, configFile), 'utf-8');
    findings.push(ok('playwright', configFile));
    if (!/propmaster\/reporter|src\/reporter/.test(text)) {
        findings.push({
            check: 'playwright',
            status: 'warn',
            message: `${configFile} doesn't use the Propmaster reporter, so there's no test history for \`propmaster flaky\` and quarantine.json is ignored.`,
            fix: { text: "add ['@inluxc/propmaster/reporter'] to reporter in playwright.config.ts", safe: false },
        });
    }
    if (!fs.existsSync(path.join(ctx.root, 'tsconfig.json'))) {
        findings.push({ check: 'playwright', status: 'warn', message: 'no tsconfig.json: editors and `tsc --noEmit` won\'t type-check the tests.', fix: { text: 'npx propmaster init adds one', safe: false } });
    }

    // Browsers, when tests use one.
    if (['page', 'context', 'browser', 'browserName'].some((f) => ctx.used.has(f))) {
        const browsers = ['chromium', ...(/firefox/i.test(text) ? ['firefox'] : []), ...(/webkit|safari/i.test(text) ? ['webkit'] : [])];
        try {
            const require = createRequire(path.join(ctx.root, 'package.json'));
            const core = require('playwright-core') as Record<string, { executablePath(): string }>;
            const missing = browsers.filter((b) => {
                try {
                    return !fs.existsSync(core[b].executablePath());
                } catch {
                    return true;
                }
            });
            findings.push(
                missing.length
                    ? { check: 'playwright', status: 'fail', message: `browser${missing.length > 1 ? 's' : ''} not installed: ${missing.join(', ')}.`, fix: { text: `npx playwright install ${missing.join(' ')}`, safe: false } }
                    : ok('playwright', `browsers installed: ${browsers.join(', ')}`),
            );
        } catch {
            findings.push({ check: 'playwright', status: 'fail', message: '@playwright/test isn\'t installed.', fix: { text: `${packageManager(ctx.root)} install`, safe: false } });
        }
    }
    return findings;
}

/** CI files that may name the Playwright image. */
function ciFiles(root: string): string[] {
    const files = ['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', '.circleci/config.yml', 'bitbucket-pipelines.yml'].filter((f) => fs.existsSync(path.join(root, f)));
    const workflows = path.join(root, '.github', 'workflows');
    if (fs.existsSync(workflows)) for (const f of fs.readdirSync(workflows)) if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`);
    return files;
}

function checkCiImage(ctx: Context): Finding[] {
    const installed = readJson(path.join(ctx.root, 'node_modules', '@playwright', 'test', 'package.json'))?.version as string | undefined;
    if (!installed) return [];
    const findings: Finding[] = [];
    for (const file of ciFiles(ctx.root)) {
        const full = path.join(ctx.root, file);
        const text = fs.readFileSync(full, 'utf-8');
        const tags = [...new Set([...text.matchAll(/mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)/g)].map((m) => m[1]))];
        const stale = tags.filter((t) => t !== installed);
        if (!tags.length) continue;
        if (!stale.length) {
            findings.push(ok('ci', `${file}: Playwright image v${installed}`));
            continue;
        }
        findings.push({
            check: 'ci',
            status: 'warn',
            message: `${file} runs the Playwright image v${stale.join(', v')}, but @playwright/test is ${installed}: the browsers won't match.`,
            fix: {
                text: `use mcr.microsoft.com/playwright:v${installed} in ${file}`,
                safe: true,
                apply: () => {
                    const current = fs.readFileSync(full, 'utf-8');
                    fs.writeFileSync(full, current.replace(/(mcr\.microsoft\.com\/playwright:v)\d+\.\d+\.\d+/g, `$1${installed}`));
                    return true;
                },
            },
        });
    }
    return findings;
}

function checkEnvFiles(ctx: Context): Finding[] {
    const isGit = fs.existsSync(path.join(ctx.root, '.git'));
    if (!isGit) return [];
    const envFiles = fs.readdirSync(ctx.root).filter((f) => (f === '.env' || f.startsWith('.env.')) && !f.endsWith('.example'));
    if (!envFiles.length) return [];
    const gitignorePath = path.join(ctx.root, '.gitignore');
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    const findings: Finding[] = [];
    const exposed = envFiles.filter((f) => !gitIgnores(gitignore, f));
    if (exposed.length) {
        findings.push({
            check: 'secrets',
            status: 'fail',
            message: `${exposed.join(', ')} ${exposed.length > 1 ? "aren't" : "isn't"} in .gitignore: secrets in ${exposed.length > 1 ? 'them' : 'it'} could be committed.`,
            fix: {
                text: `add ${exposed.join(', ')} to .gitignore`,
                safe: true,
                apply: () => {
                    const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
                    fs.writeFileSync(gitignorePath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${exposed.join('\n')}\n`);
                    return true;
                },
            },
        });
    }
    const tracked = spawnSync('git', ['ls-files', '--', ...envFiles], { cwd: ctx.root, encoding: 'utf-8' });
    const committed = tracked.status === 0 ? tracked.stdout.split('\n').filter(Boolean) : [];
    if (committed.length) {
        findings.push({
            check: 'secrets',
            status: 'fail',
            message: `${committed.join(', ')} ${committed.length > 1 ? 'are' : 'is'} committed to git.`,
            fix: { text: `git rm --cached ${committed.join(' ')}, and change any secret ${committed.length > 1 ? 'they' : 'it'} held`, safe: false },
        });
    }
    if (!exposed.length && !committed.length) findings.push(ok('secrets', `${envFiles.join(', ')} kept out of git`));
    return findings;
}

async function checkMcp(ctx: Context): Promise<Finding[]> {
    const findings: Finding[] = [];
    const configs = ['.mcp.json', '.vscode/mcp.json', '.cursor/mcp.json'].filter((f) => {
        const json = readJson(path.join(ctx.root, f));
        const servers = (json?.mcpServers ?? json?.servers) as Record<string, unknown> | undefined;
        return !!servers && Object.keys(servers).includes('propmaster');
    });
    findings.push(
        configs.length
            ? ok('mcp', `the propmaster server is set up in ${configs.join(', ')}`)
            : {
                  check: 'mcp',
                  status: 'warn',
                  message: 'no editor is set up to start the propmaster MCP server, so agents can\'t see the backends.',
                  fix: { text: 'add it to .mcp.json: { "mcpServers": { "propmaster": { "command": "npx", "args": ["propmaster", "mcp"] } } }', safe: false },
              },
    );
    if (ctx.options.skipMcp || !ctx.config) return findings;
    try {
        const { createPropmasterMcpServer } = await import('../mcp/server.js');
        const created = await createPropmasterMcpServer({ root: ctx.root, environment: ctx.environment, allowWrites: false, allowProd: true }, () => undefined);
        try {
            findings.push(ok('mcp', `the server starts for "${ctx.environment}" with ${created.server.toolNames.length} tools`));
        } finally {
            await created.close();
        }
    } catch (error) {
        findings.push({ check: 'mcp', status: 'fail', message: `the MCP server doesn't start: ${error instanceof Error ? error.message : String(error)}` });
    }
    return findings;
}

function checkTests(ctx: Context): Finding[] {
    const { violations, ids } = collect(ctx.root);
    const findings: Finding[] = [];
    findings.push(
        violations.length
            ? {
                  check: 'tests',
                  status: 'fail',
                  message: `${violations.length} test convention violation${violations.length > 1 ? 's' : ''}, first: ${violations[0].file}:${violations[0].line} ${violations[0].message}`,
                  fix: { text: 'npx propmaster check (lists each one with its fix)', safe: false },
              }
            : ok('tests', `test conventions OK (${new Set(ids.filter((i) => !i.reserved).map((i) => i.id)).size} TestCaseIDs)`),
    );
    const quarantine = checkQuarantine(ctx.root, ids);
    for (const v of quarantine.violations) findings.push({ check: 'tests', status: 'fail', message: `${v.file}: ${v.message}` });
    for (const w of quarantine.warnings) findings.push({ check: 'tests', status: 'warn', message: w, fix: { text: 'fix the test and remove its quarantine entry, or update the entry', safe: false } });
    return findings;
}

// ─── Running ────────────────────────────────────────────────────────────────

function context(root: string, options: DoctorOptions): Context {
    const env = options.env ?? process.env;
    const environment = options.environment ?? env.PW_ENVIRONMENT ?? 'local';
    const used = new Set(testFixtures(root));
    const entries = FIXTURE_CATALOG.filter((e) => e.fixtures.some((f) => used.has(f)));
    const ctx: Context = { root, environment, options, runner: options.runner ?? inheritRunner, used, entries };
    if (fs.existsSync(path.join(root, ENVIRONMENTS_FILE))) {
        try {
            ctx.config = new ConfigLoader(root).load(environment);
        } catch (error) {
            ctx.configError = error instanceof Error ? error.message : String(error);
        }
    }
    return ctx;
}

/** Runs every check on the project at `root`. */
export async function diagnose(root: string, options: DoctorOptions = {}): Promise<{ environment: string; findings: Finding[] }> {
    const ctx = context(root, options);
    const findings = [
        ...checkNode(ctx),
        ...checkConfig(ctx),
        ...checkDrivers(ctx),
        ...(await checkBackends(ctx)),
        ...checkPlaywright(ctx),
        ...checkCiImage(ctx),
        ...checkEnvFiles(ctx),
        ...(await checkMcp(ctx)),
        ...checkTests(ctx),
    ];
    return { environment: ctx.environment, findings };
}

/** Applies every safe fix, in order. Returns the findings fixed and those whose fix failed. */
export async function applyFixes(findings: Finding[]): Promise<{ fixed: Finding[]; failed: Finding[] }> {
    const fixed: Finding[] = [];
    const failed: Finding[] = [];
    for (const f of findings) {
        if (f.status === 'ok' || f.status === 'skip' || !f.fix?.safe || !f.fix.apply) continue;
        try {
            ((await f.fix.apply()) ? fixed : failed).push(f);
        } catch {
            failed.push(f);
        }
    }
    return { fixed, failed };
}

export function summarize(findings: Finding[]): { fail: number; warn: number; fixable: number } {
    const problems = findings.filter((f) => f.status === 'fail' || f.status === 'warn');
    return { fail: findings.filter((f) => f.status === 'fail').length, warn: findings.filter((f) => f.status === 'warn').length, fixable: problems.filter((f) => f.fix?.safe && f.fix.apply).length };
}

/** The findings as lines of text. */
export function formatFindings(findings: Finding[], color = false, verbose = true): string[] {
    const s = styleFor({ isTTY: color }, color ? { FORCE_COLOR: '1' } : { NO_COLOR: '1' });
    const mark = { ok: s.green('✔'), warn: s.yellow('!'), fail: s.red('✖'), skip: s.dim('·') };
    const out: string[] = [];
    for (const f of findings) {
        if (!verbose && f.status === 'ok') continue;
        out.push(`${mark[f.status]} ${s.dim(f.check.padEnd(9))} ${f.status === 'ok' || f.status === 'skip' ? s.dim(f.message) : f.message}`);
        if (f.fix && f.status !== 'ok') out.push(`  ${' '.repeat(10)}${s.cyan('→')} ${f.fix.text}${f.fix.safe && f.fix.apply ? s.dim('  (--fix)') : ''}`);
    }
    return out;
}

const HELP = `
  Usage:
    npx propmaster doctor [-e <env>] [--fix] [--offline] [--json] [--problems]

  Checks the project's setup and says how to fix each problem: Node.js, the
  environment's config, drivers and config for the fixtures the tests use,
  whether the backends answer, the Playwright config and browsers, the CI
  image, .env files kept out of git, the MCP server, and test conventions.
  Exits 1 while a problem (✖) remains; warnings (!) don't fail it.

  Options:
    -e, --environment <env>  the environment to check (default: PW_ENVIRONMENT, else local)
    --fix                    apply the safe fixes (marked --fix), then check again
    --offline                don't try to reach the backends
    --problems               show only the problems
    --json                   findings as JSON
    --root <dir>             the project (default: the nearest package.json)
`;

function option(argv: string[], ...names: string[]): string | undefined {
    for (const name of names) {
        const i = argv.indexOf(name);
        if (i !== -1) return argv[i + 1];
        const eq = argv.find((a) => a.startsWith(`${name}=`));
        if (eq) return eq.slice(name.length + 1);
    }
    return undefined;
}

/** `propmaster doctor ...` */
export async function runDoctor(argv: string[], log: (line?: string) => void = console.log, options: DoctorOptions = {}): Promise<number> {
    if (argv.includes('--help')) {
        log(HELP);
        return 0;
    }
    const root = option(argv, '--root') ? path.resolve(option(argv, '--root')!) : findProjectRoot();
    const opts: DoctorOptions = { ...options, environment: option(argv, '-e', '--environment') ?? options.environment, offline: argv.includes('--offline') || options.offline };
    let { environment, findings } = await diagnose(root, opts);
    const s = styleFor();
    const fixedNow: Finding[] = [];
    if (argv.includes('--fix')) {
        const { fixed, failed } = await applyFixes(findings);
        fixedNow.push(...fixed);
        if (fixed.length || failed.length) ({ environment, findings } = await diagnose(root, opts));
        if (failed.length && !argv.includes('--json')) for (const f of failed) log(`  ${s.red('✖')} couldn't fix: ${f.message}`);
    }
    const { fail, warn, fixable } = summarize(findings);
    if (argv.includes('--json')) {
        log(JSON.stringify({ environment, ok: fail === 0, fixed: fixedNow.map((f) => f.message), findings: findings.map(({ fix, ...f }) => ({ ...f, ...(fix ? { fix: fix.text, autoFix: !!(fix.safe && fix.apply) } : {}) })) }, null, 2));
        return fail ? 1 : 0;
    }
    log('');
    log(`  ${s.bold('Doctor')} ${s.dim('·')} environment ${s.cyan(environment)} ${s.dim(`· ${root}`)}`);
    log('');
    for (const f of fixedNow) log(`  ${s.green('✔')} ${s.dim('fixed'.padEnd(9))} ${f.fix!.text}`);
    for (const line of formatFindings(findings, s.enabled, !argv.includes('--problems'))) log(`  ${line}`);
    log('');
    if (!fail && !warn) log(`  ${s.green('All good.')}`);
    else {
        const parts = [fail ? s.red(`${fail} problem${fail > 1 ? 's' : ''}`) : '', warn ? s.yellow(`${warn} warning${warn > 1 ? 's' : ''}`) : ''].filter(Boolean).join(', ');
        log(`  ${parts}.${fixable ? ` \`propmaster doctor --fix\` fixes ${fixable} of them.` : ''}`);
    }
    return fail ? 1 : 0;
}
