# Search Fixture (Elasticsearch, OpenSearch)

`searchClient` tests what a backend does with its search engine: that a write ends up in the index, that a query finds it, that results rank and filter the way they should. One client works with **Elasticsearch** and **OpenSearch**, through the REST API they share.

---

## What It Does

- Every test gets an index prefix of its own: `searchClient.prefix`, or an index name under it from `searchClient.indexName(name)`. Hand those names to the application and the indices a test causes are its own. Every index under the prefix is deleted when the test ends.
- `index()` and `indexMany()` into any other index are undone too. A new document is deleted. An overwritten one gets its previous version back. An index the write created is deleted.
- Writes refresh by default, so a test's own documents are searchable as soon as the call returns.
- Indexing is eventually consistent: a document the application writes shows up after the next refresh, usually within a second. `waitForDocument()` and `waitForCount()` poll until it does, instead of a fixed sleep. When it never shows up, the error says what the index holds instead.
- `search()` takes a Query DSL clause and returns hits, documents, the exact total and any aggregations. `count()`, `deleteByQuery()`, `get()` and `request()` (any other REST call) cover the rest.

It uses Node's built-in `fetch`, so there is nothing to install. (The official clients each refuse to talk to the other engine.)

---

## Setup

### Start a cluster

```bash
# Elasticsearch on 9200 or OpenSearch on 9201, from the repo's compose file (security off)
docker compose -f compose.test.yaml up -d --wait elasticsearch
PW_SEARCH_URL=http://localhost:9200 npx playwright test

# Or let the test run start one (needs Docker and testcontainers)
PW_SEARCH_CONTAINER=true npx playwright test          # Elasticsearch
PW_SEARCH_CONTAINER=opensearch npx playwright test    # OpenSearch

# Or a shared test cluster with security on
PW_SEARCH_URL=https://search.test.example.com:9200 PW_SEARCH_USERNAME=tests PW_SEARCH_PASSWORD=... npx playwright test
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PW_SEARCH_URL` | Cluster URL | — (required) |
| `PW_SEARCH_USERNAME`, `PW_SEARCH_PASSWORD` | Basic auth | — |
| `PW_SEARCH_API_KEY` | Elasticsearch API key (the base64 value), sent as `Authorization: ApiKey …`. Wins over basic auth | — |
| `PW_SEARCH_INDEX_PREFIX` | Root of the per-test index prefix | `propmaster-tests-` |
| `PW_SEARCH_TIMEOUT` | Default wait for `waitForDocument()`/`waitForCount()`, and the request timeout, in ms | `10000` |
| `PW_SEARCH_CONTAINER` | `true` starts Elasticsearch in a container; `opensearch`, `elasticsearch` or an image name picks the engine | off |

A cluster with a self-signed certificate: point `NODE_EXTRA_CA_CERTS` at its CA file. AWS SigV4 signing (Amazon OpenSearch Service with IAM auth) isn't supported; use fine-grained access control with a user, or `search.headers` for a gateway that takes its own auth header.

### Configuration via `environments.json`

```json
{
    "environments": {
        "local": {
            "search": { "url": "http://localhost:9200" }
        },
        "dev": {
            "search": { "url": "https://search.dev.example.com:9200", "username": "propmaster-tests", "indexPrefix": "ci-" }
        }
    }
}
```

The password or API key can come from a [secrets provider](./secrets): map it to `search.password` or `search.apiKey`.

### Configuration via `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';
import { ConfigLoader } from '@inluxc/propmaster';

const config = new ConfigLoader().load();

export default defineConfig({
    projects: [
        {
            name: 'integration',
            testDir: './tests/integration',
            use: { search: config.search, database: config.database },
        },
    ],
});
```

### Configuration Options

| Option | Type | Default | |
|---|---|---|---|
| `url` | `string` | — | Required |
| `username`, `password` | `string` | — | Basic auth |
| `apiKey` | `string` | — | Elasticsearch API key |
| `headers` | `Record<string, string>` | — | Sent with every request |
| `indexPrefix` | `string` | `propmaster-tests-` | Root of the per-test prefix |
| `timeout` | `number` | `10000` | ms |
| `container` | `boolean \| ContainerOptions` | off | See [Testcontainers](./testcontainers) |

---

## Usage

### Check that a write reaches the index

The application indexes in the background, so wait for the document instead of searching once:

```typescript
import { test, expect } from '@inluxc/propmaster';

test('[TC-SRCH-001] a new product becomes searchable', { tag: ['@TC-SRCH-001'] }, async ({ searchClient, openApiClient }) => {
    const sku = `sku-${Date.now()}`;

    await test.step('Step 1: Create the product through the API', async () => {
        const res = await (openApiClient.client as any).createProduct(null, { sku, title: 'Trail running shoes' });
        expect(res.status).toBe(201);
    });

    await test.step('Step 2: Verify it shows up in the products index', async () => {
        const hit = await searchClient.waitForDocument('products', { term: { sku } }, { timeout: 15_000 });
        expect(hit.source).toMatchObject({ title: 'Trail running shoes' });
    });
});
```

`products` is the application's own index, shared with other tests, so match on a value unique to this test (`sku` here).

### Check search behaviour with the test's own index

For relevance, filters and aggregations, seed an index of the test's own and query it. Point the application at it if it's the application's query you're testing:

```typescript
test('[TC-SRCH-002] "running shoes" needs both words', { tag: ['@TC-SRCH-002'] }, async ({ searchClient }) => {
    const index = searchClient.indexName('products');   // propmaster-tests-t0-9f2a1c0b-products, deleted afterwards

    await test.step('Step 1: Seed the index', async () => {
        await searchClient.createIndex(index, { mappings: { properties: { sku: { type: 'keyword' }, title: { type: 'text' } } } });
        await searchClient.indexMany(index, [
            { sku: 'p-1', title: 'Trail running shoes' },
            { sku: 'p-2', title: 'Running socks' },
            { sku: 'p-3', title: 'Running shoes for the road, lightweight running' },
        ], { id: (p) => p.sku as string });
    });

    await test.step('Step 2: Verify the hits and their order', async () => {
        const result = await searchClient.search(index, { match: { title: { query: 'running shoes', operator: 'and' } } });
        expect(result.total).toBe(2);
        expect(result.hits.map((h) => h.id)).toEqual(['p-1', 'p-3']);
    });
});
```

### Aggregations

```typescript
const result = await searchClient.search(index, undefined, {
    size: 0,
    aggs: { byCategory: { terms: { field: 'category' } } },
});
const buckets = result.aggregations!.byCategory.buckets;   // [{ key: 'shoes', doc_count: 3 }, ...]
```

### Check that a delete took effect

```typescript
await (openApiClient.client as any).deleteProduct({ sku });
await searchClient.waitForCount('products', { term: { sku } }, 0);
```

### With the Steps class

```typescript
import { SearchSteps } from '@inluxc/propmaster/steps';

const search = new SearchSteps(searchClient);
await search.index('Seed a product', index, { sku: 'p-1', title: 'Trail running shoes' }, { id: 'p-1' });
await search.expectDocumentMatching('Verify the order is indexed as paid', 'orders', { term: { orderId } }, { status: 'paid' });
await search.expectCount('Verify the product is gone', 'products', { term: { sku } }, 0);
await search.expectRanking('Verify the best match comes first', index, { match: { title: 'running shoes' } }, ['p-1', 'p-3']);
```

Each method is one `test.step()` in the report.

### API Reference

| Method | Returns | |
|---|---|---|
| `prefix` | `string` | This test's index prefix |
| `indexName(name)` | `string` | `prefix + name`, lower-cased, with characters an index name can't hold replaced by `-` |
| `index(index, doc, { id?, refresh?, keep? })` | `{ index, id, result, version }` | `refresh` defaults to `true`; `false` or `'wait_for'` for an ordinary write |
| `indexMany(index, docs, { id?, refresh?, keep? })` | `IndexResult[]` | One `_bulk` request. Throws listing the documents that failed; the others are written (and undone) |
| `get(index, id)` | `T \| null` | The document's source; null when it or the index doesn't exist |
| `search(index, query?, { size, from, sort, aggs, source, body })` | `{ total, hits, documents, aggregations, took, raw }` | `query` is a Query DSL clause (default `match_all`); `body` adds other top-level fields (`highlight`, `search_after`, ...). `index` may be a list or pattern |
| `count(index, query?)` | `number` | |
| `deleteByQuery(index, query, { refresh? })` | `number` deleted | Not undone |
| `waitForDocument(index, query?, { timeout, interval, ...searchOptions })` | `SearchHit` | Polls every 250 ms. An index that doesn't exist yet counts as no match |
| `waitForCount(index, query, expected, { timeout, interval })` | `void` | |
| `createIndex(index, { mappings, settings, aliases, keep })` | `void` | Does nothing if the index exists |
| `indexExists(index)` / `deleteIndex(index)` | `boolean` / `void` | `deleteIndex` isn't undone |
| `refresh(index)` | `void` | Makes recent writes searchable now |
| `info()` | `{ distribution, version, clusterName }` | `distribution` is `elasticsearch` or `opensearch` |
| `request(method, path, body?, { query, contentType })` | parsed JSON | Any other REST call, e.g. `_analyze` or index templates |

---

## Lifecycle

1. **Setup:** the client is created per test. Nothing is sent until the first call.
2. **Teardown:** in reverse order, writes to indices outside the prefix are undone (deleted or put back, with a refresh), indices the test created outside the prefix are deleted, and every index under the test's prefix is deleted by name. Pass `{ keep: true }` to `index`, `indexMany` or `createIndex` to leave one in place, or set `use: { autoCleanup: false }` on a project. `deleteByQuery`, `deleteIndex` and `request` are never undone.

---

## Error Handling

| Error | When |
|---|---|
| `FixtureInitError` (`search`, `connect`) | No `url` configured |
| `FixtureOperationError` (`search`, `index` / `search` / `count` / ...) | The engine rejected the call. The reason is its status, error type and message, e.g. `400 parsing_exception: unknown query [no_such_query]`; an unreachable cluster gives the URL and the network error |
| `FixtureOperationError` (`search`, `waitForDocument`) | Nothing matched (or the count never reached `expected`) before the timeout. The message gives the document count and a few documents, or says the index doesn't exist |
