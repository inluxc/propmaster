/**
 * Search Fixture (Elasticsearch / OpenSearch) — Example Tests
 *
 * Shows how to index, search, count and wait for documents with
 * `searchClient`, plus the SearchSteps class. Tests work in indices under
 * their own prefix (`searchClient.indexName()`), which are deleted after each
 * test; writes to any other index are undone. The same tests run against
 * Elasticsearch and OpenSearch.
 *
 * Prerequisites:
 *   - A cluster: PW_SEARCH_URL (e.g. http://localhost:9200),
 *     PW_SEARCH_CONTAINER=true, or `search` in environments.json
 *   - `docker compose -f compose.test.yaml up -d --wait elasticsearch` (port 9200)
 *     or `... opensearch` (port 9201) runs one locally
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from '../../src';
import { SearchSteps } from '../../src/steps';

const productMappings = {
    properties: {
        sku: { type: 'keyword' },
        title: { type: 'text' },
        category: { type: 'keyword' },
        price: { type: 'double' },
    },
};

const products = [
    { sku: 'p-1', title: 'Trail running shoes', category: 'shoes', price: 120 },
    { sku: 'p-2', title: 'Running socks', category: 'socks', price: 12 },
    { sku: 'p-3', title: 'Leather dress shoes', category: 'shoes', price: 180 },
    { sku: 'p-4', title: 'Running shoes for the road, lightweight running', category: 'shoes', price: 95 },
];

test.describe('Search Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-SRCH-001] index documents and check the relevance ranking', { tag: ['@TC-SRCH-001'] }, async ({ searchClient }) => {
        const search = new SearchSteps(searchClient);
        const index = searchClient.indexName('products');

        await test.step('Step 1: Create the index with mappings and add the catalogue', async () => {
            await searchClient.createIndex(index, { mappings: productMappings });
            await searchClient.indexMany(index, products, { id: (p) => p.sku as string });
        });

        await search.expectRanking('Verify every word of "running shoes" must match, the shorter title first', index,
            { match: { title: { query: 'running shoes', operator: 'and' } } }, ['p-1', 'p-4']);

        await test.step('Step 2: Verify a filtered search with a sort', async () => {
            const result = await searchClient.search<{ sku: string; price: number }>(index,
                { bool: { filter: [{ term: { category: 'shoes' } }, { range: { price: { lte: 150 } } }] } },
                { sort: [{ price: 'asc' }] });
            expect(result.total).toBe(2);
            expect(result.documents.map((p) => p.sku)).toEqual(['p-4', 'p-1']);
        });
    });

    test('[TC-SRCH-002] wait for a document the application indexes later', { tag: ['@TC-SRCH-002'] }, async ({ searchClient }) => {
        const search = new SearchSteps(searchClient);
        const index = searchClient.indexName('orders');
        const orderId = randomUUID();

        await test.step('Step 1: Start a job that indexes the order after a second, without a refresh', async () => {
            await searchClient.createIndex(index);
            // Stands in for the application: an ordinary write, searchable only after the next refresh.
            setTimeout(() => void searchClient.index(index, { orderId, status: 'paid' }, { refresh: false }), 1000);
        });

        await search.expectDocumentMatching('Verify the order becomes searchable with its status', index,
            { term: { 'orderId.keyword': orderId } }, { orderId, status: 'paid' });
    });

    test('[TC-SRCH-003] waiting for a document that never comes shows what the index holds', { tag: ['@TC-SRCH-003'] }, async ({ searchClient }) => {
        const index = searchClient.indexName('orders');

        await test.step('Step 1: Index a different order', async () => {
            await searchClient.index(index, { orderId: 'o-1', status: 'paid' }, { id: 'o-1' });
        });

        await test.step('Step 2: Verify the wait times out and names the document that is there', async () => {
            await expect(searchClient.waitForDocument(index, { term: { 'orderId.keyword': 'o-2' } }, { timeout: 600 }))
                .rejects.toThrow(/no document matched within 600 ms: the index has 1 document\(s\), e\.g\. o-1 \{.*orderId.*o-1/);
        });

        await test.step('Step 3: Verify waiting on an index that does not exist says so', async () => {
            await expect(searchClient.waitForDocument(searchClient.indexName('missing'), undefined, { timeout: 300 }))
                .rejects.toThrow(/the index doesn't exist/);
        });
    });

    test('[TC-SRCH-004] count, delete by query and wait for the count', { tag: ['@TC-SRCH-004'] }, async ({ searchClient }) => {
        const search = new SearchSteps(searchClient);
        const index = searchClient.indexName('products');

        await test.step('Step 1: Index the catalogue', async () => {
            await searchClient.createIndex(index, { mappings: productMappings });
            await searchClient.indexMany(index, products);
        });

        await test.step('Step 2: Verify the counts', async () => {
            expect(await searchClient.count(index)).toBe(4);
            expect(await searchClient.count(index, { term: { category: 'shoes' } })).toBe(3);
        });

        await test.step('Step 3: Delete the shoes', async () => {
            expect(await searchClient.deleteByQuery(index, { term: { category: 'shoes' } })).toBe(3);
        });

        await search.expectCount('Verify no shoes are left', index, { term: { category: 'shoes' } }, 0);
        await search.expectCount('Verify the socks are still there', index, undefined, 1);
    });

    test('[TC-SRCH-005] aggregations', { tag: ['@TC-SRCH-005'] }, async ({ searchClient }) => {
        const index = searchClient.indexName('products');

        await test.step('Step 1: Index the catalogue', async () => {
            await searchClient.createIndex(index, { mappings: productMappings });
            await searchClient.indexMany(index, products);
        });

        await test.step('Step 2: Verify the per-category counts and average price', async () => {
            const result = await searchClient.search(index, undefined, {
                size: 0,
                aggs: { byCategory: { terms: { field: 'category' }, aggs: { avgPrice: { avg: { field: 'price' } } } } },
            });
            expect(result.hits).toEqual([]);
            const buckets = result.aggregations!.byCategory.buckets.map((b: any) => ({ key: b.key, count: b.doc_count, avg: b.avgPrice.value }));
            expect(buckets).toEqual([
                { key: 'shoes', count: 3, avg: (120 + 180 + 95) / 3 },
                { key: 'socks', count: 1, avg: 12 },
            ]);
        });
    });

    test('[TC-SRCH-006] get documents by ID and overwrite one', { tag: ['@TC-SRCH-006'] }, async ({ searchClient }) => {
        const index = searchClient.indexName('users');

        await test.step('Step 1: Index a user with a known ID', async () => {
            const created = await searchClient.index(index, { name: 'Alice', plan: 'free' }, { id: 'u-1' });
            expect(created).toMatchObject({ index, id: 'u-1', result: 'created', version: 1 });
        });

        await test.step('Step 2: Overwrite it and read it back', async () => {
            const updated = await searchClient.index(index, { name: 'Alice', plan: 'pro' }, { id: 'u-1' });
            expect(updated).toMatchObject({ result: 'updated', version: 2 });
            expect(await searchClient.get(index, 'u-1')).toEqual({ name: 'Alice', plan: 'pro' });
        });

        await test.step('Step 3: Verify a missing document and a missing index give null', async () => {
            expect(await searchClient.get(index, 'u-2')).toBeNull();
            expect(await searchClient.get(searchClient.indexName('nothing'), 'u-1')).toBeNull();
        });
    });

    test('[TC-SRCH-007] engine info, raw requests and readable errors', { tag: ['@TC-SRCH-007'] }, async ({ searchClient }) => {
        await test.step('Step 1: Verify the engine reports its distribution and version', async () => {
            const info = await searchClient.info();
            expect(['elasticsearch', 'opensearch']).toContain(info.distribution);
            expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
        });

        await test.step('Step 2: Run an analyzer through a raw request', async () => {
            const res = await searchClient.request<{ tokens: { token: string }[] }>('POST', '/_analyze', { analyzer: 'standard', text: 'Running Shoes' });
            expect(res.tokens.map((t) => t.token)).toEqual(['running', 'shoes']);
        });

        await test.step('Step 3: Verify a bad query fails with the engine\'s reason', async () => {
            const index = searchClient.indexName('products');
            await searchClient.createIndex(index, { mappings: productMappings });
            await expect(searchClient.search(index, { no_such_query: {} })).rejects.toThrow(/400 parsing_exception/);
        });
    });

    test('[TC-SRCH-008] a failed bulk document is reported, the others are written', { tag: ['@TC-SRCH-008'] }, async ({ searchClient }) => {
        const index = searchClient.indexName('products');

        await test.step('Step 1: Index three documents, one with a price that is not a number', async () => {
            await searchClient.createIndex(index, { mappings: productMappings });
            await expect(searchClient.indexMany(index, [products[0], { ...products[1], price: 'cheap' }, products[2]]))
                .rejects.toThrow(/1 of 3 document\(s\) failed, first #1: 400 (document_parsing_exception|mapper_parsing_exception)/);
        });

        await test.step('Step 2: Verify the other two are there', async () => {
            expect(await searchClient.count(index)).toBe(2);
        });
    });
});

test.describe('Search Fixture Examples — cleanup', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');
    test.describe.configure({ mode: 'serial' });

    // Outside any test prefix: an index the application would own. Unique per worker, removed in TC-SRCH-010.
    const shared = `propmaster-examples-${randomUUID().slice(0, 8)}`;
    const created = `${shared}-new`;
    let testPrefix = '';

    test('[TC-SRCH-009] write to the test prefix and to shared indices', { tag: ['@TC-SRCH-009'] }, async ({ searchClient }) => {
        await test.step('Step 1: Seed a shared index with a document that must survive the next test', async () => {
            await searchClient.createIndex(shared, { keep: true });
            await searchClient.index(shared, { plan: 'free' }, { id: 'settings', keep: true });
        });

        await test.step('Step 2: Write through the client', async () => {
            await searchClient.index(searchClient.indexName('a'), { n: 1 });
            await searchClient.createIndex(searchClient.indexName('b'));
            await searchClient.index(shared, { plan: 'pro' }, { id: 'settings' });
            await searchClient.index(shared, { extra: true }, { id: 'added' });
            await searchClient.index(created, { n: 1 });
            testPrefix = searchClient.prefix;
        });

        await test.step('Step 3: Verify the writes during the test', async () => {
            expect(await searchClient.get(shared, 'settings')).toEqual({ plan: 'pro' });
            expect(await searchClient.count(shared)).toBe(2);
            expect(await searchClient.indexExists(created)).toBe(true);
        });
    });

    test('[TC-SRCH-010] the prefix indices are gone and the shared index is as it was', { tag: ['@TC-SRCH-010'] }, async ({ searchClient }) => {
        await test.step('Step 1: Verify no index is left under the previous test\'s prefix', async () => {
            const left = await searchClient.request<{ index: string }[]>('GET', `/_cat/indices/${testPrefix}*`, undefined, { query: { format: 'json', h: 'index' } });
            expect(left).toEqual([]);
        });

        await test.step('Step 2: Verify the shared document was put back and the added one removed', async () => {
            expect(await searchClient.get(shared, 'settings')).toEqual({ plan: 'free' });
            expect(await searchClient.get(shared, 'added')).toBeNull();
            expect(await searchClient.count(shared)).toBe(1);
        });

        await test.step('Step 3: Verify the index the write created was deleted', async () => {
            expect(await searchClient.indexExists(created)).toBe(false);
            await searchClient.deleteIndex(shared);
        });
    });
});
