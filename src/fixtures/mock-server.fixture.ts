/**
 * Mock-server fixture: stub the third-party APIs your backend calls (payment
 * providers, email APIs, partner services) and check the calls it made.
 *
 * Backed by WireMock (https://wiremock.org/) through its admin API, with
 * Node's built-in fetch, so it needs no package. Point the application under
 * test at WireMock's URL instead of the real provider.
 *
 * Isolation: stubs live on a shared server. Each test's stubs are tagged with
 * the test's ID and removed when it ends, and `requests()`/`verify()` only
 * see calls made since the test started. Two parallel tests that stub the
 * same request with different answers still clash; match on a value unique to
 * the test (an order ID, an email) or run those tests serially.
 */

import { errorReason } from '../network-error.js';
import type { MockServerConfig } from '../config/schema.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type Matcher = string | RegExp;

/** Which requests a stub answers, or which recorded requests to look for. */
export interface RequestMatch {
    /** HTTP method (default: any). */
    method?: string;
    /** Exact path, without the query string, e.g. `/v1/charges`. */
    path?: string;
    /**
     * Path pattern. A RegExp matches anywhere in the path, as in JavaScript;
     * a string is a WireMock regex that must match the whole path.
     */
    pathPattern?: Matcher;
    /** Query parameters: exact value, or a RegExp (matches anywhere in the value, flags `i`/`s` honoured). */
    query?: Record<string, Matcher>;
    /** Headers: exact value, or a RegExp. */
    headers?: Record<string, Matcher>;
    /** JSON the body must contain (extra fields and array order are ignored). */
    body?: unknown;
    /** A substring the raw body must contain. */
    bodyContains?: string;
}

export interface StubResponse {
    status?: number;
    /** JSON body; sets `Content-Type: application/json`. */
    json?: unknown;
    /** Raw body. */
    body?: string;
    headers?: Record<string, string>;
    /** Delay before responding, in ms. */
    delayMs?: number;
    /** Simulate a broken connection instead of responding. */
    fault?: 'CONNECTION_RESET_BY_PEER' | 'EMPTY_RESPONSE' | 'MALFORMED_RESPONSE_CHUNK' | 'RANDOM_DATA_THEN_CLOSE';
}

export interface Stub {
    id: string;
    /** Removes the stub now (it's removed at the end of the test anyway). */
    remove(): Promise<void>;
}

export interface RecordedRequest {
    method: string;
    /** Path and query string, e.g. `/v1/charges?expand=customer`. */
    url: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: string;
    /** The body parsed as JSON, or undefined when it isn't JSON. */
    json: unknown;
    date: Date;
    /** Whether a stub answered it. */
    matched: boolean;
}

/** Client exposed to tests as `mockServer`. */
export interface MockServer {
    /** Base URL to give the application under test, e.g. `http://localhost:8089`. */
    readonly url: string;
    /** Answers matching requests with `response` until the test ends. */
    stub(match: RequestMatch, response: StubResponse): Promise<Stub>;
    /** Answers matching requests with each response in turn, then keeps repeating the last one (e.g. fail twice, then succeed). */
    stubSequence(match: RequestMatch, responses: StubResponse[]): Promise<Stub>;
    /** Requests received since the test started, oldest first, optionally filtered. */
    requests(match?: RequestMatch): Promise<RecordedRequest[]>;
    /**
     * Checks how many matching requests arrived since the test started
     * (`times`, default: at least one). Fails with the closest requests that
     * didn't match.
     */
    verify(match: RequestMatch, options?: { times?: number; atLeast?: number }): Promise<RecordedRequest[]>;
}

// ─── WireMock request patterns (pure) ───────────────────────────────────────

/**
 * WireMock (Java) regexes must match the whole value; a JavaScript RegExp
 * matches anywhere. Wrap RegExps so they keep their JavaScript meaning
 * (anchors still work: `.*` can be empty). Strings are passed as-is.
 */
export function toJavaRegex(m: RegExp | string): string {
    if (typeof m === 'string') return m;
    const flags = `${m.flags.includes('i') ? 'i' : ''}${m.flags.includes('s') ? 's' : ''}`;
    return `${flags ? `(?${flags})` : ''}.*(?:${m.source}).*`;
}
const regexSource = (m: RegExp | string) => (m instanceof RegExp ? m.source : m);
const valuePattern = (m: Matcher) => (m instanceof RegExp ? { matches: toJavaRegex(m) } : { equalTo: m });

/** Translates a RequestMatch into a WireMock request pattern. */
export function toWireMockPattern(match: RequestMatch): Record<string, unknown> {
    const pattern: Record<string, unknown> = { method: match.method ? match.method.toUpperCase() : 'ANY' };
    if (match.path !== undefined && match.pathPattern !== undefined) {
        throw new Error('give either path or pathPattern, not both');
    }
    if (match.path !== undefined) pattern.urlPath = match.path;
    if (match.pathPattern !== undefined) pattern.urlPathPattern = toJavaRegex(match.pathPattern);
    if (match.query) pattern.queryParameters = Object.fromEntries(Object.entries(match.query).map(([k, v]) => [k, valuePattern(v)]));
    if (match.headers) pattern.headers = Object.fromEntries(Object.entries(match.headers).map(([k, v]) => [k, valuePattern(v)]));
    const bodyPatterns: Record<string, unknown>[] = [];
    if (match.body !== undefined) bodyPatterns.push({ equalToJson: match.body, ignoreExtraElements: true, ignoreArrayOrder: true });
    if (match.bodyContains !== undefined) bodyPatterns.push({ contains: match.bodyContains });
    if (bodyPatterns.length) pattern.bodyPatterns = bodyPatterns;
    return pattern;
}

/** Translates a StubResponse into a WireMock response definition. */
export function toWireMockResponse(response: StubResponse): Record<string, unknown> {
    if (response.fault) return { fault: response.fault };
    const out: Record<string, unknown> = { status: response.status ?? 200 };
    const headers = { ...(response.headers ?? {}) };
    if (response.json !== undefined) {
        out.jsonBody = response.json;
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (response.body !== undefined) {
        out.body = response.body;
    }
    if (Object.keys(headers).length) out.headers = headers;
    if (response.delayMs) out.fixedDelayMilliseconds = response.delayMs;
    return out;
}

type WireMockLoggedRequest = {
    method: string;
    url: string;
    headers?: Record<string, string | string[]>;
    body?: string;
    loggedDate: number;
};

function parseQuery(url: string): Record<string, string> {
    const q = url.indexOf('?');
    return q === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(q + 1)));
}

export function toRecordedRequest(r: WireMockLoggedRequest, matched: boolean): RecordedRequest {
    const body = r.body ?? '';
    let json: unknown;
    try {
        json = body ? JSON.parse(body) : undefined;
    } catch {
        json = undefined;
    }
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]));
    return {
        method: r.method,
        url: r.url,
        path: r.url.split('?')[0],
        query: parseQuery(r.url),
        headers,
        body,
        json,
        date: new Date(r.loggedDate),
        matched,
    };
}

export function describeMatch(match: RequestMatch): string {
    const parts = [
        `${(match.method ?? 'ANY').toUpperCase()} ${match.path ?? (match.pathPattern !== undefined ? `~${regexSource(match.pathPattern)}` : '(any path)')}`,
        match.query && `query ${JSON.stringify(Object.fromEntries(Object.entries(match.query).map(([k, v]) => [k, String(v)])))}`,
        match.headers && `headers ${Object.keys(match.headers).join(', ')}`,
        match.body !== undefined && `body containing ${JSON.stringify(match.body)}`,
        match.bodyContains !== undefined && `body containing "${match.bodyContains}"`,
    ].filter(Boolean);
    return parts.join(', ');
}

/** Leaf values of a JSON body (as strings), e.g. `{ a: 1, b: { c: 'x' } }` → ['1', 'x']. */
function leafValues(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (typeof value !== 'object') return [String(value)];
    return Object.values(value as Record<string, unknown>).flatMap(leafValues);
}

function commonPrefix(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

/**
 * How close a recorded request is to what was expected, for failure messages:
 * method, path closeness, query keys, and expected body values found in it.
 * On a shared server this puts the test's own near-miss ahead of other tests' calls.
 */
export function similarity(request: RecordedRequest, match: RequestMatch): number {
    let score = 0;
    if (!match.method || request.method.toUpperCase() === match.method.toUpperCase()) score += 1;
    if (match.path !== undefined) {
        score += request.path === match.path ? 3 : (2 * commonPrefix(request.path, match.path)) / Math.max(request.path.length, match.path.length, 1);
    }
    for (const key of Object.keys(match.query ?? {})) if (key in request.query) score += 0.5;
    const wanted = [...leafValues(match.body), ...(match.bodyContains !== undefined ? [match.bodyContains] : [])];
    if (wanted.length) score += (4 * wanted.filter((v) => request.body.includes(v)).length) / wanted.length;
    return score;
}

// ─── WireMock admin API ─────────────────────────────────────────────────────

/** WireMock's admin API (`/__admin`). */
export class WireMockAdmin {
    private readonly admin: string;

    constructor(adminUrl: string) {
        this.admin = `${adminUrl.replace(/\/+$/, '')}/__admin`;
    }

    private async call(method: string, path: string, body?: unknown): Promise<unknown> {
        const res = await fetch(`${this.admin}${path}`, {
            method,
            headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`${method} /__admin${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const text = await res.text();
        return text ? JSON.parse(text) : undefined;
    }

    /** Checks the server is up and returns its clock, so journal times can be compared without clock skew. */
    async health(): Promise<Date> {
        const data = (await this.call('GET', '/health')) as { timestamp?: string } | undefined;
        const serverTime = data?.timestamp ? new Date(data.timestamp) : undefined;
        return serverTime && !Number.isNaN(serverTime.getTime()) ? serverTime : new Date();
    }

    async addMapping(mapping: Record<string, unknown>): Promise<string> {
        return ((await this.call('POST', '/mappings', mapping)) as { id: string }).id;
    }

    async removeMapping(id: string): Promise<void> {
        await this.call('DELETE', `/mappings/${encodeURIComponent(id)}`);
    }

    async removeByMetadata(path: string, value: string): Promise<void> {
        await this.call('POST', '/mappings/remove-by-metadata', { matchesJsonPath: { expression: path, equalTo: value } });
    }

    async findRequests(pattern: Record<string, unknown>): Promise<WireMockLoggedRequest[]> {
        return ((await this.call('POST', '/requests/find', pattern)) as { requests: WireMockLoggedRequest[] }).requests;
    }

    async unmatchedUrls(): Promise<Set<string>> {
        const data = (await this.call('GET', '/requests/unmatched')) as { requests: WireMockLoggedRequest[] };
        return new Set(data.requests.map((r) => `${r.loggedDate}|${r.method}|${r.url}`));
    }
}

// ─── Client ─────────────────────────────────────────────────────────────────

const METADATA_KEY = 'propmaster';

/** Builds the test-facing client. `testTag` marks this test's stubs; `since` scopes the journal. */
export function createMockServer(admin: WireMockAdmin, baseUrl: string, testTag: string, since: Date): MockServer {
    let sequence = 0;
    const metadata = { [METADATA_KEY]: { test: testTag } };

    const addStub = async (mapping: Record<string, unknown>): Promise<string> => {
        try {
            return await admin.addMapping({ ...mapping, metadata });
        } catch (error) {
            throw new FixtureOperationError('mockServer', 'stub', { reason: errorReason(error) });
        }
    };

    async function requests(match: RequestMatch = {}): Promise<RecordedRequest[]> {
        const [found, unmatched] = await Promise.all([admin.findRequests(toWireMockPattern(match)), admin.unmatchedUrls()]);
        return found
            .filter((r) => r.loggedDate >= since.getTime())
            .sort((a, b) => a.loggedDate - b.loggedDate)
            .map((r) => toRecordedRequest(r, !unmatched.has(`${r.loggedDate}|${r.method}|${r.url}`)));
    }

    return {
        url: baseUrl.replace(/\/+$/, ''),

        async stub(match, response) {
            const id = await addStub({ request: toWireMockPattern(match), response: toWireMockResponse(response) });
            return { id, remove: () => admin.removeMapping(id) };
        },

        async stubSequence(match, responses) {
            if (!responses.length) throw new FixtureOperationError('mockServer', 'stub', { reason: 'stubSequence needs at least one response' });
            const scenario = `${testTag}-seq-${++sequence}`;
            const request = toWireMockPattern(match);
            const ids: string[] = [];
            for (let i = 0; i < responses.length; i++) {
                const last = i === responses.length - 1;
                ids.push(
                    await addStub({
                        scenarioName: scenario,
                        requiredScenarioState: i === 0 ? 'Started' : `step-${i}`,
                        ...(last ? {} : { newScenarioState: `step-${i + 1}` }),
                        request,
                        response: toWireMockResponse(responses[i]),
                    }),
                );
            }
            return { id: ids[0], remove: async () => void (await Promise.all(ids.map((id) => admin.removeMapping(id)))) };
        },

        requests,

        async verify(match, options = {}) {
            const found = await requests(match);
            const ok =
                options.times !== undefined ? found.length === options.times : found.length >= (options.atLeast ?? 1);
            if (ok) return found;

            const expected = options.times !== undefined ? `exactly ${options.times}` : `at least ${options.atLeast ?? 1}`;
            // The calls that did arrive, closest first, usually show why: a wrong path, method or body.
            const closest = (await requests().catch(() => []))
                .map((r) => ({ r, score: similarity(r, match) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 5)
                .map(({ r }) => `${r.method} ${r.url}${r.body ? ` ${r.body.slice(0, 120)}` : ''}`);
            throw new FixtureOperationError('mockServer', 'verify', {
                expected: `${expected} × ${describeMatch(match)}`,
                received: found.length,
                reason: closest.length ? `closest requests since the test started: ${closest.join(' | ')}` : 'no requests since the test started',
            });
        },
    };
}

/**
 * Playwright fixture: `mockServer`. Checks WireMock is up, gives the test a
 * client, and removes the test's stubs when it ends.
 */
export const mockServerFixture = {
    mockServer: async (
        { mockConfig }: { mockConfig: MockServerConfig },
        use: (server: MockServer) => Promise<void>,
        testInfo: { testId: string; repeatEachIndex: number; retry: number },
    ) => {
        const admin = new WireMockAdmin(mockConfig.adminUrl ?? mockConfig.url);
        let since: Date;
        try {
            // The server's own clock: requests logged from now on belong to this test.
            since = await admin.health();
        } catch (error) {
            throw new FixtureInitError(
                'mockServer',
                'connect',
                { url: mockConfig.adminUrl ?? mockConfig.url, reason: errorReason(error) },
                error instanceof Error ? error : undefined,
            );
        }

        const tag = `${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}`;
        await use(createMockServer(admin, mockConfig.url, tag, since));
        await admin.removeByMetadata(`$.${METADATA_KEY}.test`, tag).catch(() => {});
    },
};
