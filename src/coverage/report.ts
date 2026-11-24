/**
 * The coverage report: the test inventory per layer (unit, integration,
 * e2e), what the tests touch, how they did in recent runs, the OpenAPI
 * operations and status codes no test exercises, backends configured but
 * never tested, and the code-coverage reports the project already has.
 *
 * It is made for an AI agent to read: facts and gaps, each with where it
 * came from, so the agent can judge what is covered and what to test next —
 * not a single percentage.
 */

import type { FrameworkConfig } from '../config/schema.js';
import { loadOpenApiDocument } from '../openapi/load.js';
import { specOperations, type SpecOperation } from '../openapi/generate.js';
import { readHistories, type HistoryRun, type TestOutcome } from '../reporter/history.js';
import { loadQuarantine, quarantinePath } from '../reporter/quarantine.js';
import { historyFile } from '../cli/flaky.js';
import { buildInventory, LAYERS, type InventoryTest, type Layer, type TestKind, type Touch, type TouchKind } from './inventory.js';
import { findCoverageReports, NOT_A_REPORT, readCoverageReport, type CodeCoverageReport } from './code-coverage.js';

export interface CoverageOptions {
    root: string;
    config?: FrameworkConfig;
    /** Spec path or URL (default: config.openapi.specPath). `false`: don't read a spec. */
    spec?: string | false;
    /** Only this layer's tests and gaps. */
    layer?: Layer;
    /** Code-coverage report files (default: found under the root). */
    reports?: string[];
    /** Newest history runs to read (default 30). */
    runs?: number;
    /** Include every test with what it touches (default false: counts only). */
    tests?: boolean;
    /** Most items in each list (default 50). */
    limit?: number;
}

export interface LayerSummary {
    layer: Layer;
    tests: number;
    files: number;
    kinds: Partial<Record<TestKind, number>>;
    /** Tests per language: the application's own tests can be in any. */
    languages: Record<string, number>;
    /** Tests marked test.skip / fixme / fail (or it.skip / it.todo). */
    notActive: number;
    /** From the newest history run that ran tests of this layer. */
    lastRun?: { at: string; passed: number; flaky: number; failed: number; skipped: number; notRun: number };
    /** Pass rate over the history window, passes / runs (flaky counts as a pass). */
    passRate?: number;
    fixtures: Record<string, number>;
    /** What the layer's tests touch, by kind: name → number of tests. */
    touches: Partial<Record<TouchKind, Record<string, number>>>;
}

export interface OperationCoverage {
    operationId?: string;
    method: string;
    path: string;
    tags: string[];
    documented: string[];
    /** Status codes some test asserts (or annotates) for this operation. */
    asserted: string[];
    /** Documented codes no test asserts. */
    missing: string[];
    tests: string[];
    layers: Layer[];
}

export interface Gap {
    kind:
        | 'empty-layer'
        | 'unclassified'
        | 'operation-untested'
        | 'status-untested'
        | 'error-paths-untested'
        | 'backend-untested'
        | 'not-active'
        | 'never-run'
        | 'failing'
        | 'quarantined'
        | 'low-code-coverage'
        | 'stale-code-coverage'
        | 'no-code-coverage';
    layer?: Layer;
    message: string;
    items?: string[];
}

export interface CoverageReport {
    generatedAt: string;
    root: string;
    totals: { tests: number; files: number; byLayer: Record<Layer, number>; unclassified: number };
    layers: LayerSummary[];
    api?: {
        spec: string;
        operations: number;
        tested: number;
        /** Operations with a test, over all operations, percent. */
        operationPct: number | null;
        /** Documented status codes some test asserts, over all documented, percent. */
        statusPct: number | null;
        untested: OperationCoverage[];
        partial: OperationCoverage[];
        error?: string;
    };
    backends: Array<{ backend: string; configured: boolean; fixtures: string[]; tests: number }>;
    codeCoverage: Array<CodeCoverageReport | { path: string; error: string }>;
    history: { runs: number; file: string };
    gaps: Gap[];
    tests?: Array<Pick<InventoryTest, 'id' | 'title' | 'file' | 'line' | 'layer' | 'kind' | 'state' | 'fixtures' | 'touches' | 'statuses'> & { recent?: string }>;
    /** What an agent can do next to sharpen the picture. */
    nextSteps: string[];
}

/** Config block → the fixtures that use it. */
const BACKENDS: Array<{ backend: keyof FrameworkConfig; fixtures: string[] }> = [
    { backend: 'openapi', fixtures: ['openApiClient'] },
    { backend: 'graphql', fixtures: ['graphqlClient'] },
    { backend: 'grpc', fixtures: ['grpcClient'] },
    { backend: 'realtime', fixtures: ['realtimeClient'] },
    { backend: 'database', fixtures: ['databaseClient'] },
    { backend: 'mongodb', fixtures: ['mongoDbClient'] },
    { backend: 'neo4j', fixtures: ['neo4jClient'] },
    { backend: 'cassandra', fixtures: ['cassandraClient'] },
    { backend: 'kafka', fixtures: ['kafkaClient'] },
    { backend: 'amqp', fixtures: ['amqpClient'] },
    { backend: 'aws', fixtures: ['s3Client', 'sqsClient', 'dynamoDbClient'] },
    { backend: 'search', fixtures: ['searchClient'] },
    { backend: 'redis', fixtures: ['redisClient'] },
    { backend: 'otp', fixtures: ['otpClient'] },
    { backend: 'appium', fixtures: ['appiumDriver', 'gadsHub'] },
    { backend: 'mock', fixtures: ['mockServer'] },
    { backend: 'auth', fixtures: ['authToken', 'authHeaders', 'authRequest'] },
];

const SYMBOL: Record<TestOutcome, string> = { passed: '✓', flaky: '~', failed: '✗', skipped: '-' };
const LOW_CODE_COVERAGE = 60;
const STALE_DAYS = 30;

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const testKey = (t: Pick<InventoryTest, 'id' | 'file' | 'title'>) => t.id ?? `${t.file} › ${t.title}`;
const label = (t: InventoryTest) => (t.id ? `${t.id} ${t.title.replace(/^\[[^\]]+\]\s*/, '')}` : `${t.file}:${t.line} ${t.title}`);

/** An operation by its operationId, else by method and path (specs without operationIds). */
const opLabel = (o: Pick<OperationCoverage, 'operationId' | 'method' | 'path'>) => o.operationId ?? `${o.method} ${o.path}`;

function cap<T>(items: T[], limit: number): T[] {
    return items.slice(0, limit);
}

function withMore(items: string[], limit: number): string[] {
    return items.length > limit ? [...items.slice(0, limit), `… ${items.length - limit} more`] : items;
}

/** Each test's outcomes in the history, oldest first, keyed by TestCaseID (or file › title). */
function outcomesByTest(runs: HistoryRun[]): Map<string, Array<{ outcome: TestOutcome; at: string }>> {
    const out = new Map<string, Array<{ outcome: TestOutcome; at: string }>>();
    for (const run of runs) {
        for (const t of run.tests) {
            const list = out.get(t.id) ?? [];
            list.push({ outcome: t.outcome, at: run.startedAt });
            out.set(t.id, list);
        }
    }
    return out;
}

/**
 * The history IDs of each test. A TestCaseID is the ID; a test without one is
 * `file › describe › title` with the file relative to the project's testDir,
 * so it is matched by title and file suffix instead.
 */
function historyIdsOf(tests: InventoryTest[], runs: HistoryRun[]): Map<InventoryTest, string[]> {
    const byTitle = new Map<string, Map<string, string>>();
    for (const run of runs) {
        for (const h of run.tests) {
            const ids = byTitle.get(h.title) ?? new Map<string, string>();
            ids.set(h.id, h.file.split('\\').join('/'));
            byTitle.set(h.title, ids);
        }
    }
    const out = new Map<InventoryTest, string[]>();
    for (const t of tests) {
        if (t.id) {
            out.set(t, [t.id]);
            continue;
        }
        const candidates = byTitle.get(t.title);
        out.set(t, candidates ? [...candidates].filter(([, file]) => file && (t.file === file || t.file.endsWith(`/${file}`))).map(([id]) => id) : []);
    }
    return out;
}

/**
 * Whether an HTTP call a test makes (`GET /orders/42`, `GET /orders/${id}`,
 * `get "/v1/orders/{id}"`) is this operation: same method, and the path
 * matches the spec's template, with any prefix (a base path like /v1).
 */
export function pathMatcher(op: Pick<SpecOperation, 'method' | 'path'>): (call: string) => 'exact' | 'segment' | false {
    const template = op.path.replace(/\/+$/, '').split(/(\{[^}]+\})/).map((part) => (part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))).join('');
    const re = new RegExp(`^(?:/[^/]+)*?${template}/?$`);
    const method = op.method.toUpperCase();
    return (call) => {
        const [m, raw = ''] = call.split(' ');
        if (m !== method) return false;
        // Interpolations are one segment: ${id}, {id} (f-strings), #{id} (Ruby), %s / %d (format strings)
        const path = raw.replace(/\$\{[^}]*\}|#\{[^}]*\}|\{[^}]*\}|%[sdv]/g, 'X');
        if (re.test(path)) return 'exact';
        // `"/orders/" + id` leaves a trailing slash: one more segment, if no operation matches the path as it is
        return path.endsWith('/') && path.length > 1 && re.test(`${path}X`) ? 'segment' : false;
    };
}

/** The operations each HTTP call is: exact path matches, else the ones a trailing slash plus one segment would match. */
function callsToOperations(operations: SpecOperation[], tests: InventoryTest[]): Map<string, Set<SpecOperation>> {
    const matchers = operations.map((op) => [op, pathMatcher(op)] as const);
    const out = new Map<string, Set<SpecOperation>>();
    for (const call of new Set(tests.flatMap((t) => t.touches.filter((x) => x.kind === 'http').map((x) => x.name)))) {
        const results = matchers.map(([op, match]) => [op, match(call)] as const);
        const exact = results.filter(([, r]) => r === 'exact');
        out.set(call, new Set((exact.length ? exact : results.filter(([, r]) => r === 'segment')).map(([op]) => op)));
    }
    return out;
}

async function apiCoverage(spec: string, root: string, tests: InventoryTest[], limit: number): Promise<{ api: NonNullable<CoverageReport['api']>; operationIds: Set<string> } | { error: string }> {
    let operations: SpecOperation[];
    try {
        const doc = await loadOpenApiDocument(spec, root);
        operations = specOperations(doc);
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
    const calls = callsToOperations(operations, tests);
    const rows: OperationCoverage[] = operations.map((op) => {
        const byOp = tests.filter((t) => t.touches.some((x) => (x.kind === 'operation' && !!op.operationId && x.name === op.operationId) || (x.kind === 'http' && !!calls.get(x.name)?.has(op))));
        const asserted = new Set<string>();
        for (const t of tests) {
            for (const a of t.annotated) {
                const [id, status] = a.split(' ');
                if (id === op.operationId) asserted.add(status);
            }
        }
        // A status asserted in a test that calls the operation counts for it (approximate when a test calls several).
        for (const t of byOp) for (const s of t.statuses) if (op.statuses.includes(String(s))) asserted.add(String(s));
        const documented = op.statuses.filter((s) => s !== 'default');
        return {
            ...(op.operationId ? { operationId: op.operationId } : {}),
            method: op.method.toUpperCase(),
            path: op.path,
            tags: op.tags,
            documented,
            asserted: [...asserted].sort(),
            missing: documented.filter((s) => !asserted.has(s)),
            tests: byOp.map(testKey),
            layers: [...new Set(byOp.map((t) => t.layer).filter((l): l is Layer => l !== null))],
        };
    });
    const tested = rows.filter((r) => r.tests.length);
    const documented = rows.reduce((n, r) => n + r.documented.length, 0);
    const asserted = rows.reduce((n, r) => n + r.documented.length - r.missing.length, 0);
    return {
        operationIds: new Set(operations.map((o) => o.operationId).filter((id): id is string => !!id)),
        api: {
            spec,
            operations: rows.length,
            tested: tested.length,
            operationPct: pct(tested.length, rows.length),
            statusPct: pct(asserted, documented),
            untested: cap(rows.filter((r) => !r.tests.length), limit),
            partial: cap(tested.filter((r) => r.missing.length), limit),
        },
    };
}

function summarizeLayer(layer: Layer, tests: InventoryTest[], runs: HistoryRun[], outcomes: ReturnType<typeof outcomesByTest>, historyIds: Map<InventoryTest, string[]>): LayerSummary {
    const historyKeys = (t: InventoryTest) => historyIds.get(t) ?? [];
    const mine = tests.filter((t) => t.layer === layer);
    const kinds: Partial<Record<TestKind, number>> = {};
    const fixtures: Record<string, number> = {};
    const languages: Record<string, number> = {};
    const touches: Partial<Record<TouchKind, Record<string, number>>> = {};
    for (const t of mine) {
        if (t.kind) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
        languages[t.language] = (languages[t.language] ?? 0) + 1;
        for (const f of t.fixtures) fixtures[f] = (fixtures[f] ?? 0) + 1;
        for (const x of t.touches) {
            const byName = (touches[x.kind] ??= {});
            byName[x.name] = (byName[x.name] ?? 0) + 1;
        }
    }

    const keys = new Set(mine.flatMap(historyKeys));
    const summary: LayerSummary = {
        layer,
        tests: mine.length,
        files: new Set(mine.map((t) => t.file)).size,
        kinds,
        languages,
        notActive: mine.filter((t) => t.state === 'skip' || t.state === 'fixme' || t.state === 'fail').length,
        fixtures,
        touches,
    };

    const lastRun = [...runs].reverse().find((r) => r.tests.some((t) => keys.has(t.id)));
    if (lastRun) {
        const ran = lastRun.tests.filter((t) => keys.has(t.id));
        const count = (o: TestOutcome) => ran.filter((t) => t.outcome === o).length;
        const ranKeys = new Set(ran.map((t) => t.id));
        summary.lastRun = {
            at: lastRun.startedAt,
            passed: count('passed'),
            flaky: count('flaky'),
            failed: count('failed'),
            skipped: count('skipped'),
            notRun: mine.filter((t) => !historyKeys(t).some((k) => ranKeys.has(k))).length,
        };
    }
    let ran = 0;
    let passed = 0;
    for (const k of keys) {
        for (const o of outcomes.get(k) ?? []) {
            if (o.outcome === 'skipped') continue;
            ran++;
            if (o.outcome !== 'failed') passed++;
        }
    }
    if (ran) summary.passRate = Math.round((passed / ran) * 1000) / 1000;
    return summary;
}

/** Builds the report. Reads files only: no test run, no backend. */
export async function coverageReport(options: CoverageOptions): Promise<CoverageReport> {
    const { root, config } = options;
    const limit = options.limit ?? 50;
    const specPath = options.spec === false ? undefined : options.spec ?? config?.openapi?.specPath;

    // First pass without a spec, to know which tests call the API at all; then with the spec's operationIds.
    let inventory = buildInventory(root);
    let api: CoverageReport['api'];
    if (specPath) {
        const first = await apiCoverage(specPath, root, inventory.tests, limit);
        if ('error' in first) {
            api = { spec: specPath, operations: 0, tested: 0, operationPct: null, statusPct: null, untested: [], partial: [], error: first.error };
        } else {
            inventory = buildInventory(root, { operationIds: first.operationIds });
            const second = await apiCoverage(specPath, root, inventory.tests, limit);
            api = 'error' in second ? first.api : second.api;
        }
    }

    const all = inventory.tests;
    const inScope = options.layer ? all.filter((t) => t.layer === options.layer) : all;
    const runs = readHistories([historyFile(root)]).slice(-(options.runs ?? 30));
    const outcomes = outcomesByTest(runs);
    const historyIds = historyIdsOf(all, runs);
    const historyKeys = (t: InventoryTest) => historyIds.get(t) ?? [];
    const layers = (options.layer ? [options.layer] : LAYERS).map((l) => summarizeLayer(l, all, runs, outcomes, historyIds));

    let quarantined = new Set<string>();
    try {
        quarantined = new Set(loadQuarantine(quarantinePath(root)).entries.keys());
    } catch {
        // `propmaster check` reports a broken quarantine file
    }

    const used = (fixtures: string[]) => all.filter((t) => t.fixtures.some((f) => fixtures.includes(f)));
    const backends = BACKENDS.map(({ backend, fixtures }) => ({
        backend: String(backend),
        configured: config ? config[backend] !== undefined && config[backend] !== null : false,
        fixtures,
        tests: used(fixtures).length,
    })).filter((b) => b.configured || b.tests > 0);

    // Found files with a generic name (coverage.json, coverage.out) that turn out to be something else are left out; named ones say why.
    const codeCoverage = options.reports
        ? options.reports.map((p) => readCoverageReport(root, p))
        : findCoverageReports(root).map((p) => readCoverageReport(root, p)).filter((c) => !('error' in c && c.error === NOT_A_REPORT));

    // ─── Gaps ───
    const gaps: Gap[] = [];
    for (const l of layers) {
        if (!l.tests) gaps.push({ kind: 'empty-layer', layer: l.layer, message: `No ${l.layer} tests.` });
    }
    const unclassified = inScope.filter((t) => t.layer === null);
    if (!options.layer && unclassified.length) {
        gaps.push({
            kind: 'unclassified',
            message: `${unclassified.length} test(s) use custom fixtures or don't destructure them, so their layer can't be read; put them in tests/api, tests/integration or tests/e2e (propmaster organize) or read them yourself.`,
            items: withMore(unclassified.map(label), limit),
        });
    }
    if (api && !api.error) {
        if (api.untested.length) {
            gaps.push({
                kind: 'operation-untested',
                layer: 'integration',
                message: `${api.operations - api.tested} of ${api.operations} API operations have no test.`,
                items: withMore(api.untested.map((o) => (o.operationId ? `${o.operationId} ${o.method} ${o.path}` : `${o.method} ${o.path}`)), limit),
            });
        }
        const noErrors = api.partial.filter((o) => o.missing.some((s) => /^[45]/.test(s)) && !o.asserted.some((s) => /^[45]/.test(s)));
        if (noErrors.length) {
            gaps.push({
                kind: 'error-paths-untested',
                layer: 'integration',
                message: `${noErrors.length} tested operation(s) assert no error status (4xx/5xx), though the spec documents some.`,
                items: withMore(noErrors.map((o) => `${opLabel(o)} — documented ${o.missing.filter((s) => /^[45]/.test(s)).join(', ')}`), limit),
            });
        }
        const otherMissing = api.partial.filter((o) => !noErrors.includes(o));
        if (otherMissing.length) {
            gaps.push({
                kind: 'status-untested',
                layer: 'integration',
                message: `${otherMissing.length} tested operation(s) have documented status codes no test asserts.`,
                items: withMore(otherMissing.map((o) => `${opLabel(o)} — ${o.missing.join(', ')}`), limit),
            });
        }
    }
    const untestedBackends = backends.filter((b) => b.configured && !b.tests);
    if (untestedBackends.length && !options.layer) {
        gaps.push({
            kind: 'backend-untested',
            message: `Configured for this environment, but no test uses it: ${untestedBackends.map((b) => b.backend).join(', ')}.`,
            items: untestedBackends.map((b) => `${b.backend} (${b.fixtures.join(', ')})`),
        });
    }
    const notActive = inScope.filter((t) => t.state === 'skip' || t.state === 'fixme' || t.state === 'fail');
    if (notActive.length) {
        gaps.push({ kind: 'not-active', message: `${notActive.length} test(s) are marked skip, fixme or fail in the code: they cover nothing until fixed.`, items: withMore(notActive.map((t) => `${label(t)} (${t.state})`), limit) });
    }
    if (runs.length) {
        const never = inScope.filter((t) => t.runner === 'playwright' && t.state === 'active' && !historyKeys(t).some((k) => outcomes.has(k)));
        if (never.length) {
            gaps.push({
                kind: 'never-run',
                message: `${never.length} test(s) aren't in the last ${runs.length} run(s) of the test history: new, outside every Playwright project's testMatch, or skipped by CI.`,
                items: withMore(never.map(label), limit),
            });
        }
        const failing = inScope.filter((t) => historyKeys(t).some((k) => outcomes.get(k)?.at(-1)?.outcome === 'failed'));
        if (failing.length) gaps.push({ kind: 'failing', message: `${failing.length} test(s) failed in their latest run: what they cover isn't verified.`, items: withMore(failing.map(label), limit) });
    }
    const quarantinedTests = inScope.filter((t) => t.id && quarantined.has(t.id));
    if (quarantinedTests.length) gaps.push({ kind: 'quarantined', message: `${quarantinedTests.length} test(s) are quarantined: their failures don't fail the build.`, items: quarantinedTests.map(label) });

    const readable = codeCoverage.filter((c): c is CodeCoverageReport => !('error' in c));
    const inLayer = readable.filter((c) => !options.layer || c.layer === options.layer);
    for (const c of inLayer) {
        if (c.lines.pct !== null && c.lines.pct < LOW_CODE_COVERAGE) {
            gaps.push({ kind: 'low-code-coverage', layer: c.layer, message: `${c.path}: ${c.lines.pct}% of ${c.measure} covered (${c.layer}).`, items: c.lowest.slice(0, 10).map((f) => `${f.file} ${f.lines.pct}% (${f.lines.total - f.lines.covered} ${c.measure} uncovered)`) });
        }
        const age = (Date.now() - Date.parse(c.writtenAt)) / 86_400_000;
        if (age > STALE_DAYS) gaps.push({ kind: 'stale-code-coverage', layer: c.layer, message: `${c.path} was written ${Math.floor(age)} days ago: rerun the coverage before trusting it.` });
    }
    if (!readable.length) {
        gaps.push({
            kind: 'no-code-coverage',
            message: 'No code-coverage report found (LCOV, Istanbul, Cobertura, JaCoCo, Clover, OpenCover, Go cover profile, coverage.py JSON or SimpleCov): line coverage of the application is unknown. Point `reports` at the files its own test runs write, in whatever language it is.',
        });
    }

    const byLayer = Object.fromEntries(LAYERS.map((l) => [l, all.filter((t) => t.layer === l).length])) as Record<Layer, number>;
    const report: CoverageReport = {
        generatedAt: new Date().toISOString(),
        root,
        totals: { tests: all.length, files: inventory.files, byLayer, unclassified: all.filter((t) => t.layer === null).length },
        layers,
        ...(api ? { api } : {}),
        backends,
        codeCoverage,
        history: { runs: runs.length, file: historyFile(root) },
        gaps,
        nextSteps: nextSteps({ api, runs: runs.length, readable: readable.length, backends, layers }),
    };
    if (options.tests) {
        report.tests = cap(inScope, Math.max(limit, 200)).map((t) => {
            const recent = historyKeys(t).flatMap((k) => outcomes.get(k) ?? []).slice(-10).map((o) => SYMBOL[o.outcome]).join('');
            return {
                ...(t.id ? { id: t.id } : {}),
                title: t.title,
                file: t.file,
                line: t.line,
                layer: t.layer,
                kind: t.kind,
                state: t.state,
                fixtures: t.fixtures,
                touches: t.touches,
                statuses: t.statuses,
                ...(recent ? { recent } : {}),
            };
        });
    }
    return report;
}

function nextSteps(o: { api?: CoverageReport['api']; runs: number; readable: number; backends: CoverageReport['backends']; layers: LayerSummary[] }): string[] {
    const steps: string[] = [];
    if (!o.api) steps.push('No OpenAPI spec configured: set openapi.specPath (or pass spec) to see which operations and status codes have no test.');
    else if (o.api.error) steps.push(`The OpenAPI spec couldn't be read (${o.api.error}).`);
    if (!o.runs) steps.push('No test history: add the Propmaster reporter to playwright.config.ts and run the tests, so the report knows which tests pass.');
    if (o.backends.some((b) => b.backend === 'database' && b.configured)) {
        steps.push("Compare the tables the tests touch with the database's own (db_query on information_schema.tables, or sqlite_master) to find tables no test reads or writes.");
    }
    if (o.backends.some((b) => b.backend === 'kafka' && b.configured)) steps.push('Compare the topics the tests use with kafka_topics to find topics no test produces to or consumes.');
    if (o.layers.some((l) => l.layer === 'e2e' && l.tests)) steps.push("Compare the routes the e2e tests open (touches.route) with the application's routes or sitemap to find pages no journey visits.");
    steps.push('Read the application code behind the untested operations and the least-covered files to judge which gaps matter most (money, auth, data loss) before writing tests; next_test_id for the IDs.');
    return steps;
}

// ─── Text ───────────────────────────────────────────────────────────────────

const TOUCH_NOUNS: Partial<Record<TouchKind, string>> = { http: 'HTTP call', graphql: 'GraphQL operation', grpc: 'gRPC method', deeplink: 'deep link' };

/** The report as text for a terminal. */
export function formatCoverageReport(r: CoverageReport): string {
    const lines: string[] = [];
    lines.push(`Coverage: ${r.totals.tests} tests in ${r.totals.files} files`);
    lines.push('');
    for (const l of r.layers) {
        const kinds = Object.entries(l.kinds).map(([k, n]) => `${k} ${n}`).join(', ');
        const languages = Object.keys(l.languages).length > 1 || !['typescript', 'javascript'].includes(Object.keys(l.languages)[0] ?? 'typescript') ? Object.entries(l.languages).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') : '';
        const run = l.lastRun ? ` · last run ${l.lastRun.passed}✓ ${l.lastRun.flaky}~ ${l.lastRun.failed}✗${l.lastRun.notRun ? ` ${l.lastRun.notRun} not run` : ''}` : '';
        const rate = l.passRate !== undefined ? ` · pass rate ${Math.round(l.passRate * 100)}%` : '';
        lines.push(`  ${l.layer.padEnd(12)} ${String(l.tests).padStart(4)} tests${kinds ? ` (${kinds})` : ''}${l.notActive ? `, ${l.notActive} skipped/fixme` : ''}${run}${rate}`);
        const touched = Object.entries(l.touches)
            .map(([kind, names]) => {
                const n = Object.keys(names!).length;
                const noun = TOUCH_NOUNS[kind as TouchKind] ?? kind;
                return `${n} ${noun}${n === 1 ? '' : 's'}`;
            })
            .join(', ');
        if (languages) lines.push(`  ${''.padEnd(12)}      in ${languages}`);
        if (touched) lines.push(`  ${''.padEnd(12)}      touches ${touched}`);
    }
    if (r.totals.unclassified && r.layers.length === LAYERS.length) lines.push(`  ${'unclassified'.padEnd(12)} ${String(r.totals.unclassified).padStart(4)} tests`);
    if (r.api) {
        lines.push('');
        if (r.api.error) lines.push(`API (${r.api.spec}): ${r.api.error}`);
        else lines.push(`API (${r.api.spec}): ${r.api.tested}/${r.api.operations} operations tested (${r.api.operationPct ?? 0}%), ${r.api.statusPct ?? 0}% of documented status codes asserted`);
    }
    if (r.codeCoverage.length) {
        lines.push('');
        lines.push('Code coverage:');
        for (const c of r.codeCoverage) {
            if ('error' in c) lines.push(`  ${c.path}: ${c.error}`);
            else lines.push(`  ${c.layer.padEnd(12)} ${String(c.lines.pct ?? '-').padStart(5)}% ${c.measure}${c.branches ? `, ${c.branches.pct}% branches` : ''}  ${c.path} (${c.format}, ${c.files} files)`);
        }
    }
    if (r.gaps.length) {
        lines.push('');
        lines.push('Gaps:');
        for (const g of r.gaps) {
            lines.push(`  • ${g.message}`);
            for (const item of (g.items ?? []).slice(0, 8)) lines.push(`      ${item}`);
            if ((g.items?.length ?? 0) > 8) lines.push(`      … ${g.items!.length - 8} more (--json for all)`);
        }
    }
    return lines.join('\n');
}

export type { Touch };
