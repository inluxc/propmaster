/**
 * MCP tools for the test loop: run tests and read why they failed
 * (run_tests, last_failures), the flake ranking (flaky_tests), what the tests
 * cover per layer (coverage_report) and the API tests the OpenAPI spec gives
 * (generate_api_tests).
 *
 * run_tests runs `playwright test` in the project with the Propmaster
 * reporter, which writes the failures with their steps and errors to the
 * last-run file; the tool reads that file back. It has a time limit and isn't
 * offered for a production environment.
 */

import { spawn } from 'node:child_process';
import { installedPackageDir, packageCommand, packageManager } from '../package-manager.js';
import { createRequire } from 'node:module';
import { extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLastRun, type LastRunTest } from '../reporter/last-run.js';
import { lastFailures, lastRunFile } from '../cli/failures.js';
import { flakyRows } from '../cli/flaky.js';
import { generateOpenApiTests } from '../cli/generate.js';
import type { FrameworkConfig } from '../config/schema.js';
import { coverageReport } from '../coverage/report.js';
import { LAYERS, type Layer } from '../coverage/inventory.js';
import { ToolInputError, type ToolDefinition } from './protocol.js';

export const DEFAULT_RUN_TIMEOUT_S = 300;
export const MAX_RUN_TIMEOUT_S = 1800;
const MAX_FAILURES = 20;
const MAX_OUTPUT = 4000;
const MAX_FILE_CONTENT = 20_000;
/** After the global timeout: how long Playwright gets to stop and report before it's killed. */
const KILL_GRACE_MS = 30_000;

const TEST_ID = /^TC-[A-Z][A-Z0-9]{1,5}-\d{3,}$/;

export interface RunTestsOptions {
    ids?: string[];
    files?: string[];
    projects?: string[];
    grep?: string;
    /** Seconds for the whole run. */
    timeout?: number;
    retries?: number;
    workers?: number;
    /** Add the run to the test history (default false: runs while writing a test aren't flakes). */
    history?: boolean;
    environment?: string;
}

export interface RunTestsResult {
    ok: boolean;
    status: string;
    exitCode: number | null;
    durationMs: number;
    counts?: { total: number; passed: number; flaky: number; failed: number; skipped: number };
    failures: LastRunTest[];
    moreFailures?: number;
    flaky: Array<Pick<LastRunTest, 'id' | 'title' | 'location' | 'project' | 'failedStep'>>;
    errors: string[];
    timedOut?: true;
    /** The same run in a terminal. */
    command: string;
    /** The end of Playwright's output, when the run didn't report (config errors and the like). */
    output?: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The arguments to `playwright test` for the options. Throws ToolInputError for a bad one. */
export function playwrightArgs(options: RunTestsOptions, reporter: string): string[] {
    const args = ['test'];
    for (const file of options.files ?? []) {
        if (typeof file !== 'string' || !file || file.startsWith('-')) throw new ToolInputError(`files must be test file paths or patterns, not "${String(file)}"`);
        args.push(file);
    }
    if (options.ids?.length && options.grep) throw new ToolInputError('Pass ids or grep, not both');
    if (options.ids?.length) {
        const bad = options.ids.filter((id) => typeof id !== 'string' || !TEST_ID.test(id));
        if (bad.length) throw new ToolInputError(`Not TestCaseIDs: ${bad.join(', ')} (expected TC-XXX-NNN)`);
        // The ID is in the title ([TC-API-001]) and the tag (@TC-API-001); (?!\d) keeps TC-API-001 from matching TC-API-0010.
        args.push(`--grep=(${options.ids.map((id) => `${escapeRegExp(id)}(?!\\d)`).join('|')})`);
    } else if (options.grep) {
        args.push(`--grep=${options.grep}`);
    }
    for (const project of options.projects ?? []) {
        if (typeof project !== 'string' || !project) throw new ToolInputError('projects must be project names');
        args.push(`--project=${project}`);
    }
    if (options.retries !== undefined) args.push(`--retries=${options.retries}`);
    if (options.workers !== undefined) args.push(`--workers=${options.workers}`);
    args.push(`--global-timeout=${(options.timeout ?? DEFAULT_RUN_TIMEOUT_S) * 1000}`);
    args.push(`--reporter=dot,${reporter}`);
    return args;
}

/** The Propmaster reporter of this copy of Propmaster (TypeScript under tsx, JavaScript once built). */
function reporterPath(): string {
    const ext = extname(fileURLToPath(import.meta.url));
    return fileURLToPath(new URL(`../reporter/index${ext}`, import.meta.url));
}

function playwrightCli(root: string): string {
    try {
        const dir = installedPackageDir(root, '@playwright/test');
        if (!dir) throw new Error('not installed');
        return createRequire(join(dir, 'package.json')).resolve('@playwright/test/cli');
    } catch {
        throw new ToolInputError(`@playwright/test isn't installed in ${root}: ${packageCommand(packageManager(root), 'install', ['@playwright/test']).join(' ')}`);
    }
}

/** The environment for the run: Playwright's own worker variables are dropped, so a run from inside a test starts clean. */
function childEnv(environment: string | undefined, lastRun: string, history: boolean): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TEST_|PW_TEST_|PW_TS_)/.test(k)));
    return {
        ...env,
        ...(environment ? { PW_ENVIRONMENT: environment } : {}),
        FORCE_COLOR: '0',
        PW_LAST_RUN_FILE: lastRun,
        ...(history ? {} : { PW_TEST_HISTORY: 'false' }),
    };
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** Runs the tests and reads the failures back from the last-run file. */
export async function runTests(root: string, options: RunTestsOptions): Promise<RunTestsResult> {
    const timeout = options.timeout ?? DEFAULT_RUN_TIMEOUT_S;
    const cli = playwrightCli(root);
    const args = playwrightArgs(options, reporterPath());
    const lastRun = lastRunFile(root);
    const started = Date.now();

    let output = '';
    let timedOut = false;
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
        const child = spawn(process.execPath, [cli, ...args], {
            cwd: root,
            env: childEnv(options.environment, lastRun, options.history === true),
            stdio: ['ignore', 'pipe', 'pipe'],
            // Its own process group, so a run that doesn't stop is killed with its workers.
            detached: process.platform !== 'win32',
        });
        const collect = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-MAX_OUTPUT * 4);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const kill = (signal: NodeJS.Signals) => {
            try {
                if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch {
                // already gone
            }
        };
        // Playwright stops itself at --global-timeout and reports; this is for a run that hangs anyway.
        const hard = setTimeout(() => {
            timedOut = true;
            kill('SIGINT');
            setTimeout(() => kill('SIGKILL'), 5000).unref();
        }, timeout * 1000 + KILL_GRACE_MS);
        child.on('error', (error) => {
            clearTimeout(hard);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(hard);
            resolveExit(code);
        });
    });

    const command = ['npx', 'playwright', ...args.filter((a) => !a.startsWith('--reporter=') && !a.startsWith('--global-timeout='))].map(quote).join(' ');
    const durationMs = Date.now() - started;
    const run = readLastRun(lastRun);
    const fresh = run && Date.parse(run.startedAt) >= started - 1000 ? run : undefined;
    const tail = output.trim().slice(-MAX_OUTPUT);

    if (!fresh) {
        return {
            ok: false, status: timedOut ? 'timedout' : 'error', exitCode, durationMs, failures: [], flaky: [], errors: [],
            ...(timedOut ? { timedOut: true as const } : {}),
            command,
            output: tail || '(no output)',
        };
    }
    const failures = fresh.tests.filter((t) => t.outcome === 'failed');
    const status = timedOut ? 'timedout' : fresh.status;
    return {
        // exit code 0 also covers a run whose only failures are quarantined
        ok: exitCode === 0,
        status,
        exitCode,
        durationMs,
        counts: fresh.counts,
        failures: failures.slice(0, MAX_FAILURES),
        ...(failures.length > MAX_FAILURES ? { moreFailures: failures.length - MAX_FAILURES } : {}),
        flaky: fresh.tests.filter((t) => t.outcome === 'flaky').map(({ id, title, location, project, failedStep }) => ({ id, title, location, project, ...(failedStep ? { failedStep } : {}) })),
        errors: fresh.errors,
        ...(timedOut || status === 'timedout' ? { timedOut: true as const } : {}),
        command,
        // Errors outside the tests (no tests found, a global setup) are clearer with Playwright's own words.
        ...(fresh.errors.length || (exitCode !== 0 && !failures.length) ? { output: tail } : {}),
    };
}

// ─── Argument helpers ───────────────────────────────────────────────────────

function strings(args: Record<string, unknown>, key: string): string[] | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') return [v];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new ToolInputError(`${key} must be a list of strings`);
    return v as string[];
}

function integer(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ToolInputError(`${key} must be a whole number from ${min} to ${max}`);
    return v;
}

function flag(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const v = args[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
    return v;
}

function text(args: Record<string, unknown>, key: string): string | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || !v) throw new ToolInputError(`${key} must be a string`);
    return v;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

export interface TestToolsContext {
    root: string;
    environment: string;
    /** A production environment: run_tests isn't offered. */
    production: boolean;
    /** The environment's config: the OpenAPI spec and which backends are configured, for coverage_report. */
    config?: FrameworkConfig;
}

export function testTools(ctx: TestToolsContext): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    if (!ctx.production) {
        tools.push({
            name: 'run_tests',
            title: 'Run tests',
            description:
                `Runs Playwright tests in the project for environment "${ctx.environment}" and returns, for each test that failed, the test.step() that failed, the error message, where it was thrown with the code around it, and the trace to open; flaky tests (passed on a retry) are listed too. Select tests by TestCaseID (ids), file, project or grep; with none, every test runs. The run stops after timeout seconds (default ${DEFAULT_RUN_TIMEOUT_S}). Tests create and clean up their own data through the fixtures. Runs aren't added to the test history unless history is true. Never offered for a production environment.`,
            inputSchema: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, description: 'TestCaseIDs, e.g. ["TC-API-003"]' },
                    files: { type: 'array', items: { type: 'string' }, description: 'Test files or patterns, e.g. ["tests/api/orders.spec.ts"] or ["orders.spec.ts:42"]' },
                    projects: { type: 'array', items: { type: 'string' }, description: 'Playwright projects (default: all of them)' },
                    grep: { type: 'string', description: 'Only tests whose title matches this regular expression (not with ids)' },
                    timeout: { type: 'integer', minimum: 10, maximum: MAX_RUN_TIMEOUT_S, description: `Seconds for the whole run (default ${DEFAULT_RUN_TIMEOUT_S})` },
                    retries: { type: 'integer', minimum: 0, maximum: 5, description: "Retries for failed tests (default: the config's)" },
                    workers: { type: 'integer', minimum: 1, maximum: 32, description: "Parallel workers (default: the config's)" },
                    history: { type: 'boolean', description: 'Add this run to the test history (default false)' },
                },
                additionalProperties: false,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            handler: async (args) => {
                if (ctx.production) throw new ToolInputError(`run_tests doesn't run in a production environment ("${ctx.environment}")`);
                return runTests(ctx.root, {
                    ids: strings(args, 'ids'),
                    files: strings(args, 'files'),
                    projects: strings(args, 'projects'),
                    grep: text(args, 'grep'),
                    timeout: integer(args, 'timeout', 10, MAX_RUN_TIMEOUT_S),
                    retries: integer(args, 'retries', 0, 5),
                    workers: integer(args, 'workers', 1, 32),
                    history: flag(args, 'history', false),
                    environment: ctx.environment,
                });
            },
        });
    }
    tools.push(
        {
            name: 'last_failures',
            title: 'Last failures',
            description:
                "The failed and flaky tests of the last run, whoever ran it (run_tests, a terminal, an IDE): the test.step() that failed, the error, where it was thrown, the trace, and the test's recent outcomes from the test history (✓ passed, ~ flaky, ✗ failed, oldest first), which tell a new failure from one that keeps coming back. Read from .propmaster/last-run.json, written by the Propmaster reporter.",
            inputSchema: { type: 'object', properties: { flaky: { type: 'boolean', description: 'Include flaky tests (default true)' } }, additionalProperties: false },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const result = lastFailures(ctx.root);
                if (!flag(args, 'flaky', true)) result.flaky = [];
                const more = result.failures.length - MAX_FAILURES;
                return { ...result, failures: result.failures.slice(0, MAX_FAILURES), ...(more > 0 ? { moreFailures: more } : {}) };
            },
        },
        {
            name: 'flaky_tests',
            title: 'Flaky tests',
            description:
                'Tests ranked by flake rate over the last runs in the test history, the same as npm run flaky: how often each was flaky (passed on a retry) or failed, its recent outcomes, and whether it is quarantined. Tests that never passed are listed last as failing (broken, not flaky). Fix the cause; quarantine.json only with an owner and an issue.',
            inputSchema: {
                type: 'object',
                properties: {
                    runs: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many of the newest runs to look at (default 30)' },
                    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Rows to return (default 20)' },
                    minRate: { type: 'number', minimum: 0, maximum: 1, description: 'Leave out tests below this flake rate, e.g. 0.1' },
                },
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const minRate = args.minRate;
                if (minRate !== undefined && (typeof minRate !== 'number' || minRate < 0 || minRate > 1)) throw new ToolInputError('minRate must be a number from 0 to 1');
                const limit = integer(args, 'limit', 1, 200) ?? 20;
                const { runs, rows } = flakyRows(ctx.root, { window: integer(args, 'runs', 1, 1000) ?? 30, minRate: minRate as number | undefined });
                if (runs === 0) return { runs, tests: [], message: 'No test history yet: add the Propmaster reporter to playwright.config.ts and run the tests.' };
                return { runs, tests: rows.slice(0, limit), ...(rows.length > limit ? { more: rows.length - limit } : {}) };
            },
        },
        {
            name: 'coverage_report',
            title: 'Coverage report',
            description:
                "What the project's tests cover, per layer of the test pyramid: unit (no service, browser or device; property tests; Vitest/Jest files; the application's own tests in other languages), integration (API and backend clients) and e2e (browser and device). For each layer: tests, files, skipped/fixme tests, the last run and pass rate from the test history, the fixtures used and what the tests touch (API operations, HTTP paths, GraphQL operations, gRPC methods, tables, collections, topics, queues, indexes, routes, deep links). Then the OpenAPI operations and documented status codes no test asserts, backends configured for the environment that no test uses, tests that never ran or fail, and the code-coverage reports already in the project, from any language's tools (LCOV, Istanbul, Cobertura, JaCoCo, Clover, OpenCover, Go cover profiles, coverage.py JSON, SimpleCov), with their least-covered files. The application can be in any language: its own tests in Python, Go, Java/Kotlin/Scala, C#, Ruby, PHP, Rust, Swift and Elixir are counted and layered, and their HTTP calls are matched to the spec's operations by method and path. Read statically from files: runs nothing, touches no backend. Use it to build a picture of coverage before deciding what to test next: weigh the gaps against the application code and the real backends (db_query, kafka_topics, openapi_operations), not by the numbers alone.",
            inputSchema: {
                type: 'object',
                properties: {
                    layer: { type: 'string', enum: [...LAYERS], description: 'Only this layer (default: all three)' },
                    tests: { type: 'boolean', description: 'Include every test with its fixtures, what it touches, asserted statuses and recent outcomes (default false)' },
                    spec: { type: 'string', description: 'OpenAPI spec path or URL (default: openapi.specPath of the environment)' },
                    reports: { type: 'array', items: { type: 'string' }, description: 'Code-coverage report files, relative to the project (default: the ones found in the project)' },
                    runs: { type: 'integer', minimum: 1, maximum: 1000, description: 'Newest test-history runs to read (default 30)' },
                    limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most items in each list (default 50)' },
                },
                additionalProperties: false,
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            handler: async (args) => {
                const layer = text(args, 'layer');
                if (layer !== undefined && !LAYERS.includes(layer as Layer)) throw new ToolInputError(`layer must be one of ${LAYERS.join(', ')}`);
                const reports = strings(args, 'reports');
                for (const r of reports ?? []) {
                    if (isAbsolute(r) || r.split(/[\\/]/).includes('..')) throw new ToolInputError(`reports must be paths inside the project, not "${r}"`);
                }
                return coverageReport({
                    root: ctx.root,
                    config: ctx.config,
                    spec: text(args, 'spec'),
                    layer: layer as Layer | undefined,
                    reports,
                    runs: integer(args, 'runs', 1, 1000),
                    tests: flag(args, 'tests', false),
                    limit: integer(args, 'limit', 1, 500),
                });
            },
        },
        {
            name: 'generate_api_tests',
            title: 'Generate API tests',
            description:
                'The API tests `propmaster generate openapi` would write from the OpenAPI spec: one file per tag, a test per operation and documented status code, with fresh TestCaseIDs and test.step() blocks. Operation/status pairs that already have a test are left out. Returns the files and their content as a preview; with apply: true it writes them (never over an existing file). Replace the example values with data the API has before running them.',
            inputSchema: {
                type: 'object',
                properties: {
                    tags: { type: 'array', items: { type: 'string' }, description: 'Only operations with these tags' },
                    operations: { type: 'array', items: { type: 'string' }, description: 'Only these operationIds' },
                    spec: { type: 'string', description: 'Spec path or URL (default: openapi.specPath of the environment)' },
                    out: { type: 'string', description: 'Output folder (default tests/api)' },
                    category: { type: 'string', description: 'TestCaseID category (default API)' },
                    prism: { type: 'boolean', description: 'Every status code runs against a Prism mock (Prefer: code=<status>)' },
                    content: { type: 'boolean', description: "Include each file's content (default true)" },
                    apply: { type: 'boolean', description: 'Write the files (default false: only the preview)' },
                },
                additionalProperties: false,
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            handler: async (args) => {
                const category = (text(args, 'category') ?? 'API').toUpperCase();
                if (!/^[A-Z][A-Z0-9]{1,5}$/.test(category)) throw new ToolInputError('category must be 2–6 capital letters or digits, starting with a letter');
                const out = text(args, 'out') ?? 'tests/api';
                const apply = flag(args, 'apply', false);
                const run = await generateOpenApiTests({
                    root: ctx.root,
                    spec: text(args, 'spec'),
                    tags: strings(args, 'tags') ?? [],
                    operations: strings(args, 'operations') ?? [],
                    out,
                    category,
                    prism: flag(args, 'prism', false),
                    importFrom: '@inluxc/propmaster',
                    environment: ctx.environment,
                    dryRun: !apply,
                }).catch((error: unknown) => {
                    throw new ToolInputError(error instanceof Error ? error.message : String(error));
                });
                const withContent = flag(args, 'content', true);
                const rel = (p: string) => relative(ctx.root, p).split('\\').join('/');
                return {
                    applied: apply && run.written.length > 0,
                    ...(apply ? { written: run.written.map(rel) } : { reason: run.result.files.length ? 'Preview. Call again with apply: true to write these files.' : 'Nothing to generate.' }),
                    files: run.result.files.map((f) => ({
                        file: rel(join(run.outDir, f.fileName)),
                        tag: f.tag,
                        tests: f.tests,
                        ...(withContent ? { content: f.content.length > MAX_FILE_CONTENT ? `${f.content.slice(0, MAX_FILE_CONTENT)}\n// … ${f.content.length - MAX_FILE_CONTENT} more characters` : f.content } : {}),
                    })),
                    ...(run.result.alreadyCovered.length ? { alreadyCovered: run.result.alreadyCovered } : {}),
                    ...(run.result.skipped.length ? { skipped: run.result.skipped } : {}),
                    ...(run.contractNote ? { note: run.contractNote } : {}),
                };
            },
        },
    );
    return tools;
}
