/**
 * The test inventory behind the coverage report: every test in the project,
 * its layer (unit, integration, e2e), and what it touches — the API
 * operations it calls, the tables it queries, the topics it produces to, the
 * pages it opens. Read statically from the source, so it needs no run and no
 * backend; the report adds the run history and the spec on top.
 *
 * Layers follow the test pyramid:
 *   unit         no service, browser or device: plain logic, property tests, other runners (Vitest, Jest, ...),
 *                and the application's own tests in any language (languages.ts)
 *   integration  across a service boundary without a UI: API clients (api) and backend clients (integration)
 *   e2e          a browser (e2e) or a device (mobile)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { findTests, lineOf } from '../cli/check-tests.js';
import { analyzeSource, classifyFixtures, fixturesOf } from '../cli/organize.js';
import { testIdOf } from '../reporter/quarantine.js';
import { findOtherTests, languageOf, layerFromFile, layerFromMarkers, type Language } from './languages.js';

export type Layer = 'unit' | 'integration' | 'e2e';
/** The finer kind inside a layer; api, integration, e2e and mobile are the folders `propmaster init` scaffolds. */
export type TestKind = 'unit' | 'property' | 'api' | 'integration' | 'e2e' | 'mobile';
export const LAYERS: readonly Layer[] = ['unit', 'integration', 'e2e'];

export const LAYER_OF: Record<TestKind, Layer> = {
    unit: 'unit',
    property: 'unit',
    api: 'integration',
    integration: 'integration',
    e2e: 'e2e',
    mobile: 'e2e',
};

/** What a test exercises. `name` is the operationId, table, topic, route, ... */
export type TouchKind =
    | 'operation'
    | 'http'
    | 'graphql'
    | 'grpc'
    | 'stream'
    | 'table'
    | 'collection'
    | 'label'
    | 'topic'
    | 'queue'
    | 'exchange'
    | 'channel'
    | 'index'
    | 'bucket'
    | 'route'
    | 'deeplink';

export interface Touch {
    kind: TouchKind;
    name: string;
}

export type TestState = 'active' | 'skip' | 'fixme' | 'fail' | 'only';

export interface InventoryTest {
    /** TestCaseID, when the test has one. */
    id?: string;
    title: string;
    file: string;
    line: number;
    /** null when the fixtures don't tell (custom fixtures) and the folder doesn't either. */
    layer: Layer | null;
    kind: TestKind | null;
    runner: 'playwright' | 'other';
    /** The test's language: the application's own tests can be in any. */
    language: Language;
    fixtures: string[];
    state: TestState;
    touches: Touch[];
    /** HTTP status codes the test asserts (`expect(res.status).toBe(404)`). */
    statuses: number[];
    /** `"<operationId> <status>"` pairs from `annotation: { type: 'openapi', ... }`. */
    annotated: string[];
}

export interface Inventory {
    /** Files with at least one test. */
    files: number;
    tests: InventoryTest[];
}

// ─── Files ──────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
    'node_modules', 'dist', 'build', 'out', 'coverage', 'playwright-report', 'test-results', 'blob-report', 'vendor', 'target',
    '__pycache__', 'venv', 'site-packages', 'bin', 'obj', 'Pods', 'DerivedData', '_build', 'deps',
]);
const TEST_FILE = /\.(?:spec|test|e2e|browser|mobile|prop)\.(?:c|m)?[jt]sx?$/;

const isTestFile = (path: string, name: string) => TEST_FILE.test(name) || languageOf(path) !== null;

/** Test files under `root`, relative and with forward slashes. Hidden folders and build output are skipped. */
export function findTestFiles(root: string, dir = root, out: string[] = []): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of names) {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let isDir: boolean;
        try {
            isDir = statSync(full).isDirectory();
        } catch {
            continue;
        }
        const rel = relative(root, full).split(sep).join('/');
        if (isDir) findTestFiles(root, full, out);
        else if (isTestFile(rel, name)) out.push(rel);
    }
    return out.sort();
}

// ─── Layer ──────────────────────────────────────────────────────────────────

/** The kind a file's folder or name says, for tests whose fixtures don't. */
export function kindFromPath(file: string): TestKind | null {
    const segments = file.toLowerCase().split('/');
    const name = segments.pop() ?? '';
    if (/\.prop\.[cm]?[jt]sx?$/.test(name) || segments.includes('properties') || segments.includes('property')) return 'property';
    if (/\.mobile(?:\.(?:spec|test))?\.[cm]?[jt]sx?$/.test(name) || segments.includes('mobile')) return 'mobile';
    if (/\.(?:e2e|browser)(?:\.(?:spec|test))?\.[cm]?[jt]sx?$/.test(name) || segments.some((s) => ['e2e', 'ui', 'browser', 'web', 'acceptance'].includes(s))) return 'e2e';
    if (segments.includes('integration') || segments.includes('it')) return 'integration';
    if (segments.includes('api') || segments.includes('contract')) return 'api';
    if (segments.includes('unit') || segments.includes('__tests__')) return 'unit';
    return null;
}

const UNIT_REASON = /needs no browser, device or service fixture/;
/** Propmaster's own helper fixtures: they say nothing about the layer. */
const HELPERS = new Set(['testData', 'authToken', 'authHeaders', 'authRole', 'authRequest']);
/** Services that aren't in organize's groups but make a test an integration test. */
const SERVICES = new Set(['inboxClient', 'mockServer']);

function kindOf(fixtures: string[] | null, file: string): TestKind | null {
    const fromPath = kindFromPath(file);
    if (fixtures === null) return fromPath;
    const services = fixtures.filter((f) => SERVICES.has(f));
    const c = classifyFixtures(fixtures.filter((f) => !HELPERS.has(f) && !SERVICES.has(f)));
    if (c.type) return c.type === 'api' && services.length ? 'integration' : c.type;
    // No service fixture at all: a unit test (or a property test), wherever it lives.
    if (UNIT_REASON.test(c.reason)) return services.length ? 'integration' : fromPath === 'property' ? 'property' : 'unit';
    return fromPath;
}

// ─── What a test touches ────────────────────────────────────────────────────

const LIT = String.raw`\s*(['"\`])([^'"\`\n]+?)\1`;

/** Client method → what its first string argument names. */
const CLIENT_ARGS: Record<string, Array<[RegExp, TouchKind]>> = {
    kafkaClient: [[/^(produce|consume)$/, 'topic']],
    amqpClient: [
        [/^(publish|listen|assertExchange)$/, 'exchange'],
        [/^(sendToQueue|consume|purge|checkQueue|assertQueue|bindQueue)$/, 'queue'],
    ],
    sqsClient: [
        [/^(send|receive|purge|checkQueue|createQueue)$/, 'queue'],
        [/^(publish|listen|createTopic)$/, 'topic'],
    ],
    mongoDbClient: [[/^(find|findOne|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|aggregate|countDocuments)$/, 'collection']],
    dynamoDbClient: [[/^(put|putMany|get|update|delete|query|scan|count|waitForItem|waitForQuery|createTable)$/, 'table']],
    searchClient: [[/^(index|indexMany|get|search|count|deleteByQuery|waitForDocument|waitForCount|createIndex)$/, 'index']],
    redisClient: [[/^(publish|subscribe)$/, 'channel']],
    databaseClient: [[/^insert$/, 'table']],
    cassandraClient: [[/^insert$/, 'table']],
    s3Client: [[/^createBucket$/, 'bucket']],
    realtimeClient: [[/^(connect|subscribe)$/, 'stream']],
    grpcClient: [[/^(call|invoke|serverStream|clientStream|bidiStream)$/, 'grpc']],
};

const SQL_CLIENT = /\b(databaseClient|cassandraClient)\s*\.\s*(query|execute|waitForRows|waitForRow|batch)\s*(?:<[^>()]*>)?\s*\(/;
const SQL_TABLE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+[`"[]?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi;
/** A literal that is a statement, not a step title ("Update at the current version"): upper-case keywords, or lower-case SQL shapes. */
const SQL_STATEMENT =
    /^\s*(?:(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|DROP|ALTER|TRUNCATE|MERGE|REPLACE|UPSERT|BEGIN\s+BATCH)\b|select\s[\s\S]*\bfrom\s|insert\s+into\s|update\s+\S+\s+set\s|delete\s+from\s|(?:create|drop|alter|truncate)\s+table\s)/;
const SQL_NOT_TABLE = new Set(['select', 'set', 'values', 'where', 'unnest', 'lateral', 'only', 'dual', 'if', 'exists', 'not']);
const HTTP = /\b(?:request|authRequest|apiContext|page\.request)\s*\.\s*(get|post|put|patch|delete|head|fetch)\s*\(\s*(['"`])([^'"`\n]+?)\2/g;
const GRAPHQL = /\b(query|mutation|subscription)\s+([A-Za-z_]\w*)\s*[({]/g;
const GRPC_LITERAL = /(['"`])([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+\/[A-Za-z_]\w*)\1/g;
const NEO4J_LABEL = /\(\s*[A-Za-z_]\w*\s*:\s*([A-Z][\w]*)/g;
const GOTO = new RegExp(String.raw`\bpage\s*\.\s*goto\s*\(${LIT}`, 'g');
const DEEPLINK = new RegExp(String.raw`\bappiumDriver\s*\.\s*url\s*\(${LIT}`, 'g');
const CHECK_RESPONSE = /checkResponse\s*\([^,()]+,\s*(['"`])([\w$.-]+)\1/g;
const OPENAPI_ANNOTATION = /type:\s*['"`]openapi['"`]\s*,\s*description:\s*['"`]([^'"`\s]+)\s+([0-9A-Za-z]+)['"`]/g;
const STATUS = /\bstatus(?:Code)?\s*\)?\s*\)?\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*(\d{3})\s*\)|toHaveStatus(?:Code)?\s*\(\s*(\d{3})\s*\)|\bstatus(?:Code)?\s*===?\s*(\d{3})\b/g;
/** `client.listUsers(`, `(client as any).listUsers(` — candidate operationIds when there is no spec. */
const CLIENT_CALL = /\b(?:client|openApiClient\.client)\s*(?:as\s+\w+\s*)?\)?\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const ANY_CALL = /\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
/** openapi-client-axios and axios methods: never operations. */
const NOT_OPERATIONS = new Set([
    'then', 'catch', 'finally', 'toString', 'map', 'filter', 'find', 'forEach', 'push', 'json', 'text', 'init', 'initSync', 'getClient',
    'getAxiosInstance', 'getOperations', 'getOperationIds', 'getOperation', 'getRequestConfigForOperation', 'getAxiosConfigForOperation', 'getBaseURL', 'withServer',
    'request', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options',
]);

/**
 * `const topic = 'orders'` and `const topic = testData.unique('orders')` in a
 * source: name → value, so `kafkaClient.produce(topic, ...)` counts as orders.
 * A per-test unique name keeps its base name, the thing the test exercises.
 */
export function constantsOf(src: string): Map<string, string> {
    const out = new Map<string, string>();
    const re = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(?:(?:testData|f)\s*\.\s*unique\s*\(\s*)?(['"`])([^'"`\n$]+?)\2/g;
    for (const m of src.matchAll(re)) if (!out.has(m[1])) out.set(m[1], m[3]);
    return out;
}

function clientArgTouches(body: string, out: Touch[], constants: ReadonlyMap<string, string>): void {
    const re = new RegExp(String.raw`\b(${Object.keys(CLIENT_ARGS).join('|')})\s*\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(\s*(?:(['"\`])([^'"\`\n]+?)\3|([A-Za-z_$][\w$]*)\s*[,)])`, 'g');
    for (const m of body.matchAll(re)) {
        const name = m[4] ?? constants.get(m[5]);
        if (!name) continue;
        const rule = CLIENT_ARGS[m[1]].find(([method]) => method.test(m[2]));
        if (rule) out.push({ kind: rule[1], name });
    }
}

function sqlTouches(body: string, out: Touch[]): void {
    if (!SQL_CLIENT.test(body)) return;
    // Every string literal in a test that talks SQL: the statements are often built in a variable first.
    for (const lit of body.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
        if (!SQL_STATEMENT.test(lit[2])) continue;
        for (const m of lit[2].matchAll(SQL_TABLE)) {
            if (!SQL_NOT_TABLE.has(m[1].toLowerCase())) out.push({ kind: 'table', name: m[1] });
        }
    }
}

/**
 * What one test body touches. `operationIds` is the spec's set when there is
 * one: any `.name(` call matching an operationId counts. Without a spec only
 * calls on `client` / `api` count.
 */
export function touchesOf(body: string, fixtures: readonly string[], operationIds?: ReadonlySet<string>, constants: ReadonlyMap<string, string> = constantsOf(body)): Touch[] {
    const out: Touch[] = [];
    const uses = (f: string) => fixtures.includes(f);

    if (uses('openApiClient')) {
        if (operationIds?.size) {
            for (const m of body.matchAll(ANY_CALL)) if (operationIds.has(m[1])) out.push({ kind: 'operation', name: m[1] });
        } else {
            for (const m of body.matchAll(CLIENT_CALL)) if (!NOT_OPERATIONS.has(m[1])) out.push({ kind: 'operation', name: m[1] });
        }
        for (const m of body.matchAll(CHECK_RESPONSE)) out.push({ kind: 'operation', name: m[2] });
    }
    for (const m of body.matchAll(HTTP)) out.push({ kind: 'http', name: `${m[1] === 'fetch' ? 'GET' : m[1].toUpperCase()} ${m[3]}` });
    if (uses('graphqlClient')) for (const m of body.matchAll(GRAPHQL)) out.push({ kind: 'graphql', name: `${m[1]} ${m[2]}` });
    if (uses('grpcClient')) for (const m of body.matchAll(GRPC_LITERAL)) out.push({ kind: 'grpc', name: m[2] });
    if (uses('neo4jClient')) for (const m of body.matchAll(NEO4J_LABEL)) out.push({ kind: 'label', name: m[1] });
    clientArgTouches(body, out, constants);
    sqlTouches(body, out);
    for (const m of body.matchAll(GOTO)) out.push({ kind: 'route', name: m[2] });
    for (const m of body.matchAll(DEEPLINK)) out.push({ kind: 'deeplink', name: m[2] });

    const seen = new Set<string>();
    return out.map(normalize).filter((t): t is Touch => t !== null).filter((t) => {
        const key = `${t.kind} ${t.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** `${keyspace}.orders` → orders; a name that is all interpolation (`${table}`) says nothing. */
function normalize(t: Touch): Touch | null {
    const name = t.name.replace(/^(?:\$\{[^}]*\}\.)+/, '').trim();
    if (!name || /^\$\{[^}]*\}$/.test(name)) return null;
    return name === t.name ? t : { ...t, name };
}

export function statusesOf(body: string): number[] {
    const out = new Set<number>();
    for (const m of body.matchAll(STATUS)) out.add(Number(m[1] ?? m[2] ?? m[3]));
    return [...out].sort((a, b) => a - b);
}

function annotationsOf(text: string): string[] {
    return [...text.matchAll(OPENAPI_ANNOTATION)].map((m) => `${m[1]} ${m[2]}`);
}

const STATE_OF: Record<string, TestState> = { skip: 'skip', fixme: 'fixme', fail: 'fail', only: 'only' };

function stateOf(src: string, index: number): TestState {
    const m = /^test\.(\w+)/.exec(src.slice(index, index + 20));
    return (m && STATE_OF[m[1]]) || 'active';
}

// ─── Any language ───────────────────────────────────────────────────────────

/**
 * HTTP calls in any language's test client: `client.get("/orders")` (pytest,
 * supertest, Laravel `->get`), `get("/orders")` (MockMvc, Rails), `.GetAsync("/orders")`
 * (.NET, also `PostAsJsonAsync($"/orders/{id}")`), `http.NewRequest("GET", "/orders", nil)` (Go). Paths only, so they can be matched to the spec.
 */
const ANY_HTTP =
    /(?<![\w$])(get|post|put|patch|delete|head)(?:AsJson|FromJson|String|ByteArray|Stream)?(?:Async)?(?:<[^<>()]*(?:<[^<>()]*>)?[^<>()]*>)?[ \t]*(?:\(\s*|[ \t])(?:[frbu]|\$@?|@\$?)?(["'`])(\/[^"'`\s]*)\2/gi;
/** `new HttpRequestMessage(HttpMethod.Post, "/orders")` (.NET), `HttpMethod.POST, "/orders"`. */
const HTTP_METHOD_ARG = /HttpMethod\.(\w+)\s*,\s*(?:\$@?|@\$?)?"(\/[^"\s]*)"/g;
const GO_HTTP = /NewRequest(?:WithContext)?\(\s*(?:\w+,\s*)?(?:"(\w+)"|http\.Method(\w+))\s*,\s*"(\/[^"]*)"/g;

/** Status names → codes, for assertions that use names (`isNotFound()`, `HttpStatusCode.NotFound`, `:not_found`, `StatusNotFound`). */
const STATUS_NAMES: Record<string, number> = {
    ok: 200, created: 201, accepted: 202, nocontent: 204, movedpermanently: 301, found: 302, notmodified: 304,
    badrequest: 400, unauthorized: 401, forbidden: 403, notfound: 404, methodnotallowed: 405, conflict: 409, gone: 410,
    unprocessableentity: 422, unprocessablecontent: 422, toomanyrequests: 429, internalservererror: 500, badgateway: 502, serviceunavailable: 503,
};
const STATUS_LINE = /status|\.expect\s*\(\s*[1-5]\d\d\b|assert_response|have_http_status|\.Code\b/i;

/** Status codes asserted in any language: numbers and names on lines about a status. */
export function anyStatusesOf(body: string): number[] {
    const out = new Set<number>();
    for (const line of body.split(/\r?\n/)) {
        if (!STATUS_LINE.test(line)) continue;
        for (const m of line.matchAll(/\b([1-5]\d\d)\b/g)) out.add(Number(m[1]));
        for (const m of line.matchAll(/[A-Za-z_]+/g)) {
            const word = m[0].toLowerCase().replace(/_/g, '').replace(/^(?:is|httpstatuscode|httpstatus|status|http)(?=[a-z])/, '');
            if (STATUS_NAMES[word] && word !== 'found') out.add(STATUS_NAMES[word]);
        }
    }
    return [...out].sort((a, b) => a - b);
}

/** What a test in any language touches: HTTP paths and SQL tables. */
export function anyTouchesOf(body: string): Touch[] {
    const out: Touch[] = [];
    for (const m of body.matchAll(ANY_HTTP)) out.push({ kind: 'http', name: `${m[1].toUpperCase()} ${m[3].split(/[?#]/)[0]}` });
    for (const m of body.matchAll(GO_HTTP)) out.push({ kind: 'http', name: `${(m[1] ?? m[2]).toUpperCase()} ${m[3].split(/[?#]/)[0]}` });
    for (const m of body.matchAll(HTTP_METHOD_ARG)) out.push({ kind: 'http', name: `${m[1].toUpperCase()} ${m[2].split(/[?#]/)[0]}` });
    for (const lit of body.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
        if (!SQL_STATEMENT.test(lit[2])) continue;
        for (const m of lit[2].matchAll(SQL_TABLE)) if (!SQL_NOT_TABLE.has(m[1].toLowerCase())) out.push({ kind: 'table', name: m[1] });
    }
    const seen = new Set<string>();
    return out.filter((t) => !seen.has(`${t.kind} ${t.name}`) && !!seen.add(`${t.kind} ${t.name}`));
}

/** Each test's body: from its declaration to the next one (good enough for what it touches). */
function bodies<T extends { index: number }>(src: string, found: T[]): Array<T & { body: string }> {
    return found.map((t, i) => ({ ...t, body: src.slice(t.index, found[i + 1]?.index ?? src.length) }));
}

const JS_LANGUAGE = (file: string): Language => (/\.[cm]?tsx?$/.test(file) ? 'typescript' : 'javascript');

/** Tests from a JavaScript/TypeScript file another runner owns (Vitest, Jest, node:test, Mocha), counted by `it(` / `test(` calls. */
function otherRunnerTests(src: string, file: string): InventoryTest[] {
    const kind = kindFromPath(file);
    const fileLayer = layerFromFile(file, src, JS_LANGUAGE(file));
    const layerKind: TestKind = kind === 'property' ? 'property' : kind && kind !== 'unit' ? kind : fileLayer ?? 'unit';
    const found = [...src.matchAll(/(?<![\w$.])(?:it|test)(?:\.(skip|todo|only|concurrent|each\([^)]*\)))?\s*\(\s*(['"`])((?:\\.|(?!\2).)*?)\2/g)].map((m) => ({
        index: m.index ?? 0,
        title: m[3],
        modifier: m[1] ?? '',
    }));
    return bodies(src, found).map((t) => ({
        title: t.title,
        file,
        line: lineOf(src, t.index),
        layer: LAYER_OF[layerKind],
        kind: layerKind,
        runner: 'other' as const,
        language: JS_LANGUAGE(file),
        fixtures: [],
        state: t.modifier === 'skip' || t.modifier === 'todo' ? ('skip' as const) : t.modifier === 'only' ? ('only' as const) : ('active' as const),
        touches: anyTouchesOf(t.body),
        statuses: anyStatusesOf(t.body),
        annotated: [],
    }));
}

/** Tests in Python, Go, Java/Kotlin, C#, Ruby, PHP, Rust, Swift or Elixir. */
function otherLanguageTests(src: string, file: string, language: Language): InventoryTest[] {
    // Folder names like api/, web/ or ui/ are modules in an application, not layers: only the explicit ones count.
    const segments = file.toLowerCase().split('/').slice(0, -1);
    const fromPath: TestKind | null = segments.some((s) => /^(e2e|end-?to-?end|acceptance|ui-?tests?|ui_tests?)$/.test(s))
        ? 'e2e'
        : segments.some((s) => /^(integration|integration[-_]?tests?|it|functional)$/.test(s))
          ? 'integration'
          : null;
    const fileLayer = layerFromFile(file, src, language);
    return bodies(src, findOtherTests(src, language)).map((t) => {
        const kind: TestKind =
            fromPath ?? (fileLayer === 'e2e' ? 'e2e' : fileLayer === 'integration' ? 'integration' : layerFromMarkers(t.markers) ?? 'unit');
        return {
            title: t.title,
            file,
            line: lineOf(src, t.index),
            layer: LAYER_OF[kind],
            kind,
            runner: 'other' as const,
            language,
            fixtures: [],
            state: t.skipped ? ('skip' as const) : ('active' as const),
            touches: anyTouchesOf(t.body),
            statuses: anyStatusesOf(t.body),
            annotated: [],
        };
    });
}

/** The tests in one file. Pure: the source and its path in, the tests out. */
export function analyzeTestFile(src: string, file: string, operationIds?: ReadonlySet<string>): InventoryTest[] {
    const language = languageOf(file);
    if (language) return otherLanguageTests(src, file, language);
    const analysis = analyzeSource(src);
    if (!analysis.playwright) return otherRunnerTests(src, file);

    const found = findTests(src);
    const fileConstants = constantsOf(src);
    return found.map((t, i) => {
        const summary = analysis.tests[i];
        const own = fixturesOf(t.body);
        const fixtures = summary?.fixtures.length ? summary.fixtures : own ?? [];
        const kind = kindOf(own === null ? null : fixtures, file);
        const text = `${t.options ?? ''}\n${t.body}`;
        return {
            ...(testIdOf(t.title) ? { id: testIdOf(t.title) } : {}),
            title: t.title,
            file,
            line: lineOf(src, t.index),
            layer: kind ? LAYER_OF[kind] : null,
            kind,
            runner: 'playwright' as const,
            language: JS_LANGUAGE(file),
            fixtures,
            state: stateOf(src, t.index),
            touches: touchesOf(t.body, fixtures, operationIds, new Map([...fileConstants, ...constantsOf(t.body)])),
            statuses: statusesOf(t.body),
            annotated: annotationsOf(text),
        };
    });
}

/** Every test in the project. */
export function buildInventory(root: string, options: { operationIds?: ReadonlySet<string>; files?: string[] } = {}): Inventory {
    const files = options.files ?? findTestFiles(root);
    const tests: InventoryTest[] = [];
    let withTests = 0;
    for (const file of files) {
        let src: string;
        try {
            src = readFileSync(join(root, file), 'utf8');
        } catch {
            continue;
        }
        const found = analyzeTestFile(src, file, options.operationIds);
        if (found.length) withTests++;
        tests.push(...found);
    }
    return { files: withTests, tests };
}
