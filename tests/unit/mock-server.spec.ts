/**
 * Unit tests for the mock-server fixture (src/fixtures/mock-server.fixture.ts):
 * translation to WireMock patterns and responses, recorded-request parsing,
 * similarity ranking, and the client's stub/verify logic against an in-memory
 * admin. The WireMock admin API itself runs for real in
 * tests/examples/mock-server.spec.ts.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigLoader } from '../../src/config/loader';
import { wiremockSpec } from '../../src/containers/container-manager';
import {
    createMockServer,
    describeMatch,
    similarity,
    toJavaRegex,
    toRecordedRequest,
    toWireMockPattern,
    toWireMockResponse,
    type WireMockAdmin,
} from '../../src/fixtures/mock-server.fixture';

test.describe('mock server — WireMock translation', () => {
    test('request patterns: method, path, query, headers, JSON body, substring', () => {
        expect(
            toWireMockPattern({
                method: 'post',
                path: '/v1/charges',
                query: { expand: 'customer', email: /@example\.test$/i },
                headers: { Authorization: /^Bearer / },
                body: { amount: 500 },
                bodyContains: 'eur',
            }),
        ).toEqual({
            method: 'POST',
            urlPath: '/v1/charges',
            queryParameters: { expand: { equalTo: 'customer' }, email: { matches: '(?i).*(?:@example\\.test$).*' } },
            headers: { Authorization: { matches: '.*(?:^Bearer ).*' } },
            bodyPatterns: [{ equalToJson: { amount: 500 }, ignoreExtraElements: true, ignoreArrayOrder: true }, { contains: 'eur' }],
        });
        expect(toWireMockPattern({})).toEqual({ method: 'ANY' });
        expect(() => toWireMockPattern({ path: '/a', pathPattern: /a/ })).toThrow(/either path or pathPattern/);
    });

    test('RegExps keep JavaScript "match anywhere" meaning; strings stay whole-value WireMock regexes', () => {
        expect(toJavaRegex(/^\/v1\/refunds/)).toBe('.*(?:^\\/v1\\/refunds).*');
        expect(toJavaRegex(/x/s)).toBe('(?s).*(?:x).*');
        expect(toJavaRegex('/v1/.+')).toBe('/v1/.+');
        expect(toWireMockPattern({ pathPattern: '/orders/\\d+' }).urlPathPattern).toBe('/orders/\\d+');
    });

    test('responses: JSON with content type, raw body, headers, delay, fault', () => {
        expect(toWireMockResponse({ status: 201, json: { id: 1 }, delayMs: 50 })).toEqual({
            status: 201,
            jsonBody: { id: 1 },
            headers: { 'Content-Type': 'application/json' },
            fixedDelayMilliseconds: 50,
        });
        expect(toWireMockResponse({ json: {}, headers: { 'content-type': 'application/problem+json' } }).headers).toEqual({ 'content-type': 'application/problem+json' });
        expect(toWireMockResponse({ body: 'ok' })).toEqual({ status: 200, body: 'ok' });
        expect(toWireMockResponse({ status: 500, fault: 'EMPTY_RESPONSE' })).toEqual({ fault: 'EMPTY_RESPONSE' });
    });

    test('recorded requests: path, query, lower-cased headers, parsed JSON', () => {
        const r = toRecordedRequest(
            { method: 'POST', url: '/v1/charges?expand=customer&x=1', headers: { 'Content-Type': 'application/json', 'X-Multi': ['a', 'b'] }, body: '{"amount":5}', loggedDate: 1000 },
            true,
        );
        expect(r).toMatchObject({ path: '/v1/charges', query: { expand: 'customer', x: '1' }, json: { amount: 5 }, matched: true });
        expect(r.headers).toEqual({ 'content-type': 'application/json', 'x-multi': 'a, b' });
        expect(r.date.getTime()).toBe(1000);
        expect(toRecordedRequest({ method: 'GET', url: '/', body: 'not json', loggedDate: 0 }, false).json).toBeUndefined();
    });

    test('describeMatch reads like the request', () => {
        expect(describeMatch({ method: 'post', path: '/v1/charges', body: { id: 'o1' } })).toBe('POST /v1/charges, body containing {"id":"o1"}');
        expect(describeMatch({ pathPattern: /^\/v1/ })).toBe('ANY ~^\\/v1');
    });

    test('similarity ranks the test’s own near-miss above other calls', () => {
        const mine = toRecordedRequest({ method: 'POST', url: '/v1/charge', body: '{"orderId":"o-123"}', loggedDate: 0 }, false);
        const other = toRecordedRequest({ method: 'POST', url: '/v1/charges', body: '{"orderId":"o-999"}', loggedDate: 0 }, true);
        const match = { method: 'POST', path: '/v1/charges', body: { orderId: 'o-123' } };
        expect(similarity(mine, match)).toBeGreaterThan(similarity(other, match));
    });
});

test.describe('mock server — client', () => {
    /** In-memory stand-in for WireMock's admin API. */
    function fakeAdmin(logged: { method: string; url: string; body?: string; loggedDate: number }[] = []) {
        const mappings: Record<string, unknown>[] = [];
        let n = 0;
        const admin = {
            mappings,
            removed: [] as string[],
            async addMapping(m: Record<string, unknown>) {
                mappings.push(m);
                return `stub-${++n}`;
            },
            async removeMapping(id: string) {
                admin.removed.push(id);
            },
            async findRequests(pattern: { urlPath?: string; method?: string }) {
                return logged.filter((r) => (!pattern.urlPath || r.url.split('?')[0] === pattern.urlPath) && (pattern.method === 'ANY' || r.method === pattern.method));
            },
            async unmatchedUrls() {
                return new Set<string>();
            },
        };
        return admin;
    }

    test('stubs carry the test tag; stubSequence chains scenario states', async () => {
        const admin = fakeAdmin();
        const server = createMockServer(admin as unknown as WireMockAdmin, 'http://mock:8080/', 'test-1', new Date(0));
        expect(server.url).toBe('http://mock:8080');
        await server.stub({ path: '/a' }, { status: 204 });
        await server.stubSequence({ path: '/b' }, [{ status: 503 }, { status: 503 }, { status: 200 }]);
        expect(admin.mappings[0]).toMatchObject({ metadata: { propmaster: { test: 'test-1' } }, response: { status: 204 } });
        const seq = admin.mappings.slice(1).map((m) => [m.requiredScenarioState, m.newScenarioState]);
        expect(seq).toEqual([
            ['Started', 'step-1'],
            ['step-1', 'step-2'],
            ['step-2', undefined],
        ]);
        expect(new Set(admin.mappings.slice(1).map((m) => m.scenarioName)).size).toBe(1);
        await expect(server.stubSequence({ path: '/c' }, [])).rejects.toThrow(/at least one response/);
    });

    test('requests and verify only see calls since the test started', async () => {
        const admin = fakeAdmin([
            { method: 'POST', url: '/v1/charges', body: '{"orderId":"old"}', loggedDate: 500 },
            { method: 'POST', url: '/v1/charges', body: '{"orderId":"new"}', loggedDate: 2000 },
            { method: 'POST', url: '/v1/charge', body: '{"orderId":"typo"}', loggedDate: 3000 },
        ]);
        const server = createMockServer(admin as unknown as WireMockAdmin, 'http://mock', 't', new Date(1000));
        expect((await server.requests({ method: 'POST', path: '/v1/charges' })).map((r) => r.json)).toEqual([{ orderId: 'new' }]);
        expect(await server.verify({ method: 'POST', path: '/v1/charges' }, { times: 1 })).toHaveLength(1);
        await expect(server.verify({ method: 'POST', path: '/v1/charges' }, { times: 2 })).rejects.toThrow(/exactly 2 × POST \/v1\/charges.*received=1/);
        await expect(server.verify({ method: 'POST', path: '/v1/refunds' })).rejects.toThrow(/closest requests since the test started: POST \/v1\/charge/);
        await expect(server.verify({ method: 'POST', path: '/v1/refunds' }, { times: 0 })).resolves.toEqual([]);
    });
});

test.describe('mock server — config and container', () => {
    const saved = { ...process.env };
    let dir: string;
    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-config-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: {} } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('PW_MOCK_* variables map to the mock config', () => {
        Object.assign(process.env, { PW_MOCK_URL: 'http://mock:8080', PW_MOCK_ADMIN_URL: 'http://mock-admin:8080', PW_MOCK_CONTAINER: 'true' });
        expect(new ConfigLoader(dir).load('local').mock).toEqual({ url: 'http://mock:8080', adminUrl: 'http://mock-admin:8080', container: true });
    });

    test('WireMock container: pinned image, admin health check', () => {
        const spec = wiremockSpec({});
        expect(spec.image).toBe('wiremock/wiremock:3.13.2');
        expect(spec.port).toBe(8080);
        expect(spec.healthCheck).toContain('/__admin/health');
    });
});
