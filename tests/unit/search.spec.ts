/**
 * Unit tests for the search fixture: index names and the per-test prefix,
 * auth headers, request bodies, response parsing, engine errors, the undo of
 * writes (against a stub server), PW_SEARCH_* variables and the container
 * spec. The engines themselves are covered by tests/examples/search.spec.ts.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
    createSearchClient,
    engineError,
    indexPath,
    searchBody,
    searchHeaders,
    searchTestPrefix,
    toIndexName,
    toSearchResult,
} from '../../src/fixtures/search.fixture';
import { CleanupRegistry } from '../../src/test-data/registry';
import { ConfigLoader } from '../../src/config/loader';
import { ContainerManager, DEFAULT_IMAGES, searchSpec } from '../../src/containers/container-manager';
import { FixtureInitError, FixtureOperationError } from '../../src/errors';
import type { FixtureTypes } from '../../src/fixtures';

type AssertHasKey<T, K extends keyof T> = K;
type _search = AssertHasKey<FixtureTypes, 'searchClient'>;

test.describe('search — names', () => {
    test('index names are lower case without characters the engines refuse', () => {
        expect(toIndexName('Orders')).toBe('orders');
        expect(toIndexName('a/b c,d*e#f:g')).toBe('a-b-c-d-e-f-g');
        expect(toIndexName('_internal')).toBe('internal');
    });

    test('the per-test prefix is the root plus the run ID', () => {
        expect(searchTestPrefix(undefined, 't0-abc')).toBe('propmaster-tests-t0-abc-');
        expect(searchTestPrefix('ci-run-7', 't1-def')).toBe('ci-run-7-t1-def-');
        expect(searchTestPrefix('CI_', 't1-def')).toBe('ci_-t1-def-');
        expect(searchTestPrefix('', 't1-def')).toBe('t1-def-');
    });

    test('indexName() puts a name under the prefix; no url says what to set', () => {
        const client = createSearchClient({ url: 'http://127.0.0.1:1' }, { runId: 't9-0000' });
        expect(client.prefix).toBe('propmaster-tests-t9-0000-');
        expect(client.indexName('Products')).toBe('propmaster-tests-t9-0000-products');
        expect(() => createSearchClient({})).toThrow(FixtureInitError);
        expect(() => createSearchClient({})).toThrow(/PW_SEARCH_URL/);
    });

    test('index paths keep lists and patterns', () => {
        expect(indexPath('a,b')).toBe('a,b');
        expect(indexPath('logs-*')).toBe('logs-*');
        expect(indexPath('a b')).toBe('a%20b');
    });
});

test.describe('search — requests and responses', () => {
    test('an API key wins over basic auth; extra headers are kept', () => {
        expect(searchHeaders({ username: 'elastic', password: 'pw' })).toEqual({ authorization: `Basic ${Buffer.from('elastic:pw').toString('base64')}` });
        expect(searchHeaders({ username: 'u', password: 'p', apiKey: 'abc==' })).toEqual({ authorization: 'ApiKey abc==' });
        expect(searchHeaders({ headers: { 'x-tenant': 't1' } })).toEqual({ 'x-tenant': 't1' });
        expect(searchHeaders({})).toEqual({});
    });

    test('the search body: match_all by default, exact totals, options and extra fields', () => {
        expect(searchBody(undefined)).toEqual({ query: { match_all: {} }, track_total_hits: true });
        expect(searchBody({ term: { a: 1 } }, { size: 5, from: 10, sort: ['_score'], aggs: { x: {} }, source: ['a'], body: { min_score: 1 } })).toEqual({
            query: { term: { a: 1 } },
            track_total_hits: true,
            size: 5,
            from: 10,
            sort: ['_score'],
            aggs: { x: {} },
            _source: ['a'],
            min_score: 1,
        });
    });

    test('a search response becomes hits, documents and a total', () => {
        const result = toSearchResult<{ a: number }>({
            took: 3,
            hits: { total: { value: 7, relation: 'eq' }, hits: [{ _index: 'i', _id: '1', _score: 1.5, _source: { a: 1 }, highlight: { a: ['<em>1</em>'] } }] },
            aggregations: { n: { value: 1 } },
        });
        expect(result).toMatchObject({ total: 7, took: 3, documents: [{ a: 1 }], aggregations: { n: { value: 1 } } });
        expect(result.hits[0]).toEqual({ index: 'i', id: '1', score: 1.5, source: { a: 1 }, highlight: { a: ['<em>1</em>'] } });
        expect(toSearchResult({ hits: { total: 2, hits: [] } }).total).toBe(2);
    });

    test('engine errors read as status, type and reason', () => {
        expect(engineError(404, { error: { root_cause: [{ type: 'index_not_found_exception', reason: 'no such index [x]' }], type: 'index_not_found_exception' }, status: 404 }))
            .toBe('404 index_not_found_exception: no such index [x]');
        expect(engineError(400, { error: { type: 'parsing_exception', reason: 'unknown query' } })).toBe('400 parsing_exception: unknown query');
        expect(engineError(401, { error: 'Unauthorized' })).toBe('401 Unauthorized');
        expect(engineError(502, 'Bad Gateway')).toBe('502 Bad Gateway');
        expect(engineError(500, undefined)).toBe('500');
    });
});

/** A stub engine: records requests and answers from `reply`. */
async function stubServer(reply: (method: string, url: string, body: string) => { status?: number; json?: unknown }) {
    const requests: { method: string; url: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            requests.push({ method: req.method!, url: req.url!, body, headers: req.headers });
            const r = reply(req.method!, req.url!, body);
            res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
            res.end(r.json === undefined ? '' : JSON.stringify(r.json));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test.describe('search — undo of writes', () => {
    test('an overwritten shared document is put back, a new one deleted, after the test', async () => {
        const stub = await stubServer((method, url) => {
            if (method === 'HEAD') return { status: 200 };
            if (url.startsWith('/shared/_mget')) return { json: { docs: [{ _id: 'settings', found: true, _source: { plan: 'free' } }] } };
            if (url.startsWith('/shared/_doc/settings')) return { json: { _index: 'shared', _id: 'settings', result: 'updated', _version: 2 } };
            if (url.startsWith('/shared/_doc')) return { json: { _index: 'shared', _id: 'gen-1', result: 'created', _version: 1 } };
            if (url.startsWith('/_bulk')) return { json: { errors: false, items: [{ index: { status: 200 } }, { delete: { status: 200 } }] } };
            return { status: 404, json: { error: 'unexpected' } };
        });
        const registry = new CleanupRegistry();
        const client = createSearchClient({ url: stub.url, username: 'u', password: 'p' }, { registry, runId: 't0-1' });

        await client.index('shared', { plan: 'pro' }, { id: 'settings' });
        await client.index('shared', { extra: true });
        await client.index('shared', { kept: true }, { keep: true });
        expect(registry.pending).toEqual(['search shared: 1 document(s)', 'search shared: 1 document(s)']);
        expect(stub.requests.find((r) => r.url.startsWith('/shared/_doc/settings'))!.url).toContain('refresh=true');
        expect(stub.requests[0].headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);

        stub.requests.length = 0;
        await registry.flush();
        const undo = stub.requests.map((r) => `${r.method} ${r.url.split('?')[0]} ${r.body.trim().replace(/\n/g, ' | ')}`);
        expect(undo).toEqual([
            'POST /_bulk {"delete":{"_index":"shared","_id":"gen-1"}}',
            'POST /_bulk {"index":{"_index":"shared","_id":"settings"}} | {"plan":"free"}',
        ]);
        await stub.close();
    });

    test('a write that creates a shared index deletes the index; writes under the prefix delete the prefix', async () => {
        const stub = await stubServer((method, url) => {
            if (method === 'HEAD') return { status: 404 };
            if (url.startsWith('/_cat/indices')) return { json: [{ index: 'propmaster-tests-t0-1-a' }, { index: 'propmaster-tests-t0-1-b' }] };
            if (method === 'DELETE') return { json: { acknowledged: true } };
            return { json: { _index: 'x', _id: '1', result: 'created', _version: 1 } };
        });
        const registry = new CleanupRegistry();
        const client = createSearchClient({ url: stub.url }, { registry, runId: 't0-1' });

        await client.index('new-shared', { n: 1 });
        await client.index(client.indexName('a'), { n: 1 });
        await client.index(client.indexName('b'), { n: 2 });
        expect(registry.pending).toEqual(['search index new-shared', 'search indices propmaster-tests-t0-1-*']);

        stub.requests.length = 0;
        await registry.flush();
        expect(stub.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
            'GET /_cat/indices/propmaster-tests-t0-1-*?format=json&h=index&expand_wildcards=all',
            'DELETE /propmaster-tests-t0-1-a,propmaster-tests-t0-1-b?ignore_unavailable=true',
            'DELETE /new-shared?ignore_unavailable=true',
        ]);
        await stub.close();
    });

    test('with autoCleanup off nothing is recorded, and errors name the operation and reason', async () => {
        const stub = await stubServer(() => ({ status: 400, json: { error: { type: 'parsing_exception', reason: 'bad query' } } }));
        const registry = new CleanupRegistry(false);
        const client = createSearchClient({ url: stub.url }, { registry });
        await expect(client.index('shared', { n: 1 })).rejects.toThrow(FixtureOperationError);
        await expect(client.search('shared', { bad: {} })).rejects.toThrow(/search failed: .*reason="400 parsing_exception: bad query"/);
        expect(registry.pending).toEqual([]);
        await stub.close();
    });

    test('an unreachable cluster says which URL and why', async () => {
        const stub = await stubServer(() => ({}));
        await stub.close(); // a port nothing listens on
        const client = createSearchClient({ url: stub.url });
        await expect(client.count('x')).rejects.toThrow(new RegExp(`count failed: url="${stub.url.replace(/\./g, '\\.')}".*fetch failed: .*ECONNREFUSED`));
    });
});

test.describe('search — configuration', () => {
    let dir: string;
    const saved = { ...process.env };

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propmaster-search-'));
        fs.writeFileSync(path.join(dir, 'environments.json'), JSON.stringify({ environments: { local: { search: { url: 'http://from-file:9200', indexPrefix: 'p-' } } } }));
        for (const k of Object.keys(process.env)) if (k.startsWith('PW_')) delete process.env[k];
    });
    test.afterEach(() => {
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('PW_SEARCH_* variables override environments.json', () => {
        Object.assign(process.env, {
            PW_SEARCH_URL: 'http://localhost:9201',
            PW_SEARCH_USERNAME: 'admin',
            PW_SEARCH_PASSWORD: 'pw',
            PW_SEARCH_API_KEY: 'key',
            PW_SEARCH_INDEX_PREFIX: 'ci-',
            PW_SEARCH_TIMEOUT: '2500',
            PW_SEARCH_CONTAINER: 'opensearch',
        });
        expect(new ConfigLoader(dir).load('local').search).toEqual({
            url: 'http://localhost:9201',
            username: 'admin',
            password: 'pw',
            apiKey: 'key',
            indexPrefix: 'ci-',
            timeout: 2500,
            container: { image: 'opensearch' },
        });
    });

    test('environments.json alone is enough', () => {
        expect(new ConfigLoader(dir).load('local').search).toEqual({ url: 'http://from-file:9200', indexPrefix: 'p-' });
    });
});

test.describe('search — containers', () => {
    test('Elasticsearch by default, single node with security off', () => {
        const spec = searchSpec({});
        expect(spec).toMatchObject({ kind: 'elasticsearch', image: DEFAULT_IMAGES.elasticsearch, port: 9200 });
        expect(DEFAULT_IMAGES.elasticsearch).toMatch(/^elasticsearch:\d+\.\d+\.\d+$/);
        expect(spec.env).toMatchObject({ 'discovery.type': 'single-node', 'xpack.security.enabled': 'false' });
        expect(spec.healthCheck).toContain('_cluster/health');
    });

    test('an OpenSearch image, or the bare name, starts OpenSearch', () => {
        expect(searchSpec({ image: 'opensearch' })).toMatchObject({ kind: 'opensearch', image: DEFAULT_IMAGES.opensearch });
        const custom = searchSpec({ image: 'opensearchproject/opensearch:2.19.7' });
        expect(custom).toMatchObject({ kind: 'opensearch', image: 'opensearchproject/opensearch:2.19.7' });
        expect(custom.env).toMatchObject({ DISABLE_SECURITY_PLUGIN: 'true' });
        expect(custom.env).not.toHaveProperty('xpack.security.enabled');
        expect(searchSpec({ image: 'elasticsearch' }).image).toBe(DEFAULT_IMAGES.elasticsearch);
        expect(searchSpec({ image: 'docker.elastic.co/elasticsearch/elasticsearch:8.19.25' }).kind).toBe('elasticsearch');
    });

    test('the manager returns the config unchanged when container is off', async () => {
        const m = new ContainerManager();
        const config = { url: 'http://es:9200', container: false };
        expect(await m.search(config)).toBe(config);
        await m.stopAll();
    });
});
