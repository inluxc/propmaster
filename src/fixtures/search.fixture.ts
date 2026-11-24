/**
 * Search fixture: Elasticsearch and OpenSearch.
 *
 * `searchClient` indexes, searches, counts and deletes documents through the
 * REST API both engines share, so one client works with either:
 *
 * - Every test gets its own index prefix (`searchClient.prefix`, from
 *   `indexName(name)`). Hand those names to the application so the indices a
 *   test causes are its own; every index under the prefix is deleted when the
 *   test ends.
 * - `index()` and `indexMany()` into any other index are undone too: a new
 *   document is deleted, an overwritten one gets its previous version back,
 *   and an index the write created is deleted.
 * - Indexing is eventually consistent. Writes refresh by default, so a test's
 *   own documents are searchable at once; for documents the application
 *   writes, `waitForDocument()` and `waitForCount()` poll until they show up,
 *   and fail with what the index holds instead.
 *
 * Uses Node's built-in fetch, so it needs no extra package (the official
 * clients each refuse to talk to the other engine).
 */

import { errorReason } from '../network-error.js';
import type { SearchFixtureConfig } from '../config/schema.js';
import type { ContainerManager } from '../containers/container-manager.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import type { CleanupRegistry, KeepOption } from '../test-data/registry.js';
import { newRunId } from '../test-data/factory.js';

export const DEFAULT_SEARCH_TIMEOUT = 10_000;
export const DEFAULT_INDEX_PREFIX = 'propmaster-tests-';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A Query DSL clause, e.g. `{ match: { title: 'shoes' } }` or `{ term: { orderId } }`. */
export type SearchQuery = Record<string, unknown>;

export type Refresh = boolean | 'wait_for';

export interface IndexOptions extends KeepOption {
    /** Document ID (default: one the engine generates). */
    id?: string;
    /** Make the write searchable before returning (default: true). `'wait_for'` waits for the next scheduled refresh. */
    refresh?: Refresh;
}

export interface IndexManyOptions extends KeepOption {
    /** Takes the ID from each document (default: generated IDs). */
    id?: (doc: Record<string, unknown>, index: number) => string;
    /** Default: true. */
    refresh?: Refresh;
}

export interface IndexResult {
    index: string;
    id: string;
    /** `created` or `updated`. */
    result: string;
    version: number;
}

export interface SearchOptions {
    /** Hits to return (default: the engine's, 10). */
    size?: number;
    from?: number;
    /** e.g. `[{ createdAt: 'desc' }]` or `['_score']`. */
    sort?: unknown[];
    /** Aggregations, returned in `aggregations`. */
    aggs?: Record<string, unknown>;
    /** `_source` filtering: false, a field list, or `{ includes, excludes }`. */
    source?: boolean | string[] | Record<string, unknown>;
    /** Any other top-level search body fields (`highlight`, `search_after`, `min_score`, ...). */
    body?: Record<string, unknown>;
}

export interface SearchHit<T> {
    index: string;
    id: string;
    score: number | null;
    source: T;
    /** Present when the search asked for highlighting. */
    highlight?: Record<string, string[]>;
    sort?: unknown[];
}

export interface SearchResult<T> {
    /** Every match, not just the returned page (exact: `track_total_hits` is on). */
    total: number;
    hits: SearchHit<T>[];
    /** The `source` of each hit, in order. */
    documents: T[];
    aggregations?: Record<string, any>;
    took: number;
    /** The response as the engine sent it. */
    raw: Record<string, any>;
}

export interface SearchWaitOptions {
    /** Milliseconds to wait (default: the config's `timeout`, else 10000). */
    timeout?: number;
    /** Milliseconds between polls (default: 250). */
    interval?: number;
}

export interface CreateIndexOptions extends KeepOption {
    mappings?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    aliases?: Record<string, unknown>;
}

export interface SearchEngineInfo {
    distribution: 'elasticsearch' | 'opensearch';
    version: string;
    clusterName: string;
}

export interface SearchRequestOptions {
    /** Query-string parameters. */
    query?: Record<string, string | number | boolean | undefined>;
    /** Content type for a string body (default: application/json; use `application/x-ndjson` for `_bulk`). */
    contentType?: string;
}

/** Client exposed to tests as `searchClient`. */
export interface SearchClient {
    /** This test's index prefix, e.g. `propmaster-tests-t0-9f2a1c0b-`. Every index under it is deleted after the test. */
    readonly prefix: string;
    /** `prefix + name`, lower-cased with characters an index name can't hold replaced by `-`. */
    indexName(name: string): string;
    /** Engine, version and cluster name. */
    info(): Promise<SearchEngineInfo>;
    /** Creates an index with mappings/settings. Deleted after the test unless `{ keep: true }` or it already existed. */
    createIndex(index: string, options?: CreateIndexOptions): Promise<void>;
    indexExists(index: string): Promise<boolean>;
    /** Deletes an index (not undone). Missing indices are ignored. */
    deleteIndex(index: string): Promise<void>;
    /** Writes one document. Undone after the test (deleted, or the previous version put back) unless `{ keep: true }`. */
    index<T extends Record<string, unknown>>(index: string, doc: T, options?: IndexOptions): Promise<IndexResult>;
    /** Writes documents in one `_bulk` request; throws listing the ones that failed. Undone like `index()`. */
    indexMany<T extends Record<string, unknown>>(index: string, docs: T[], options?: IndexManyOptions): Promise<IndexResult[]>;
    /** A document's source, or null when it (or the index) doesn't exist. */
    get<T = Record<string, unknown>>(index: string, id: string): Promise<T | null>;
    /** Searches with a Query DSL clause (default: match_all). `index` may be a list or pattern (`a,b`, `logs-*`). */
    search<T = Record<string, unknown>>(index: string, query?: SearchQuery, options?: SearchOptions): Promise<SearchResult<T>>;
    /** Number of documents matching the query (default: all). */
    count(index: string, query?: SearchQuery): Promise<number>;
    /** Deletes the matching documents (not undone); returns how many. */
    deleteByQuery(index: string, query: SearchQuery, options?: { refresh?: boolean }): Promise<number>;
    /** Makes recent writes to an index searchable now. */
    refresh(index: string): Promise<void>;
    /** Polls until a document matches, then returns the first hit. Throws on timeout with what the index holds. */
    waitForDocument<T = Record<string, unknown>>(index: string, query?: SearchQuery, options?: SearchWaitOptions & SearchOptions): Promise<SearchHit<T>>;
    /** Polls until exactly `expected` documents match. Throws on timeout with the last count. */
    waitForCount(index: string, query: SearchQuery | undefined, expected: number, options?: SearchWaitOptions): Promise<void>;
    /** Any other REST call; returns the parsed JSON (or text). Throws on a non-2xx status. */
    request<T = any>(method: string, path: string, body?: unknown, options?: SearchRequestOptions): Promise<T>;
    close(): void;
}

export interface CreateSearchClientOptions {
    /** Undo stack for writes and indices; without one nothing is cleaned up. */
    registry?: CleanupRegistry;
    /** Run ID in the per-test prefix (default: a new one). */
    runId?: string;
}

// ─── Helpers (pure) ─────────────────────────────────────────────────────────

/** An index name the engines accept: lower case, no `\ / * ? " < > | , #`, spaces or `:`, not starting with `-`, `_` or `+`. */
export function toIndexName(name: string): string {
    return name.toLowerCase().replace(/[\\/*?"<>|,#:\s]+/g, '-').replace(/^[-_+]+/, '');
}

/** The per-test prefix: the root (default `propmaster-tests-`) plus the run ID and a `-`. */
export function searchTestPrefix(root: string | undefined, runId: string): string {
    const base = toIndexName(root ?? DEFAULT_INDEX_PREFIX);
    return `${base === '' || base.endsWith('-') ? base : `${base}-`}${toIndexName(runId)}-`;
}

/** `Authorization` and extra headers for a config. An API key wins over basic auth. */
export function searchHeaders(config: SearchFixtureConfig): Record<string, string> {
    const headers: Record<string, string> = { ...config.headers };
    if (config.apiKey) headers.authorization = `ApiKey ${config.apiKey}`;
    else if (config.username !== undefined || config.password !== undefined) {
        headers.authorization = `Basic ${Buffer.from(`${config.username ?? ''}:${config.password ?? ''}`).toString('base64')}`;
    }
    return headers;
}

/** An index (or list/pattern) in a URL path: encoded, but commas and `*` kept. */
export function indexPath(index: string): string {
    return encodeURIComponent(index).replace(/%2C/gi, ',').replace(/%2A/gi, '*');
}

/** `{ type: reason }` from an engine error body, or the status text. */
export function engineError(status: number, body: unknown): string {
    const error = (body as { error?: unknown } | undefined)?.error;
    if (typeof error === 'string') return `${status} ${error}`;
    if (error && typeof error === 'object') {
        const e = error as { type?: string; reason?: string; root_cause?: { type?: string; reason?: string }[] };
        const cause = e.root_cause?.[0];
        const type = cause?.type ?? e.type;
        const reason = cause?.reason ?? e.reason;
        return `${status} ${[type, reason].filter(Boolean).join(': ')}`;
    }
    if (typeof body === 'string' && body) return `${status} ${body.slice(0, 300)}`;
    return `${status}`;
}

/** The search body for a query and options. */
export function searchBody(query: SearchQuery | undefined, options: SearchOptions = {}): Record<string, unknown> {
    const body: Record<string, unknown> = { query: query ?? { match_all: {} }, track_total_hits: true };
    if (options.size !== undefined) body.size = options.size;
    if (options.from !== undefined) body.from = options.from;
    if (options.sort) body.sort = options.sort;
    if (options.aggs) body.aggs = options.aggs;
    if (options.source !== undefined) body._source = options.source;
    return { ...body, ...options.body };
}

/** A search response as a SearchResult. */
export function toSearchResult<T>(raw: Record<string, any>): SearchResult<T> {
    const hits: SearchHit<T>[] = (raw.hits?.hits ?? []).map((h: any) => ({
        index: h._index,
        id: h._id,
        score: h._score ?? null,
        source: h._source,
        ...(h.highlight ? { highlight: h.highlight } : {}),
        ...(h.sort ? { sort: h.sort } : {}),
    }));
    const total = raw.hits?.total;
    return {
        total: typeof total === 'number' ? total : (total?.value ?? hits.length),
        hits,
        documents: hits.map((h) => h.source),
        ...(raw.aggregations ? { aggregations: raw.aggregations } : {}),
        took: raw.took ?? 0,
        raw,
    };
}

const short = (value: unknown, max = 200) => {
    const s = JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
};

function reasonOf(error: unknown): string {
    if (error instanceof Error && error.name === 'TimeoutError') return 'request timed out';
    return errorReason(error);
}

class EngineError extends Error {
    constructor(public readonly status: number, public readonly body: unknown) {
        super(engineError(status, body));
        this.name = 'EngineError';
    }
}

const isMissing = (error: unknown) => error instanceof EngineError && error.status === 404;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Client ─────────────────────────────────────────────────────────────────

/** Builds the client. */
export function createSearchClient(config: SearchFixtureConfig, options: CreateSearchClientOptions = {}): SearchClient {
    if (!config.url) {
        throw new FixtureInitError('search', 'connect', {
            reason: 'search configuration has no url: set PW_SEARCH_URL (e.g. http://localhost:9200), PW_SEARCH_CONTAINER=true, or search.url in environments.json or the project use block.',
        });
    }
    const { registry } = options;
    const base = config.url.replace(/\/+$/, '');
    const headers = searchHeaders(config);
    const prefix = searchTestPrefix(config.indexPrefix, options.runId ?? newRunId());
    const timeoutDefault = config.timeout ?? DEFAULT_SEARCH_TIMEOUT;
    const track = (o?: KeepOption) => registry !== undefined && registry.autoCleanup && !o?.keep;

    const fail = (operation: FixtureOperationError['operation'], details: Record<string, unknown>, error: unknown): never => {
        if (error instanceof FixtureOperationError) throw error;
        throw new FixtureOperationError('search', operation, { url: base, ...details, reason: reasonOf(error) }, error instanceof Error ? error : undefined);
    };

    const http = async <T = any>(method: string, path: string, body?: unknown, o: SearchRequestOptions = {}): Promise<T> => {
        const qs = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        const url = `${base}${path.startsWith('/') ? path : `/${path}`}${qs.length ? `${path.includes('?') ? '&' : '?'}${qs.join('&')}` : ''}`;
        const init: RequestInit = { method, headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutDefault) };
        if (body !== undefined) {
            (init.headers as Record<string, string>)['content-type'] = typeof body === 'string' ? (o.contentType ?? 'application/json') : 'application/json';
            init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        const res = await fetch(url, init);
        const text = await res.text();
        let parsed: unknown = text;
        if (text && (res.headers.get('content-type') ?? '').includes('json')) {
            try {
                parsed = JSON.parse(text);
            } catch {
                // keep the text
            }
        }
        if (!res.ok) throw new EngineError(res.status, parsed);
        return parsed as T;
    };

    // The first write under the prefix registers one cleanup for every index under it.
    let prefixTracked = false;
    const touch = (index: string) => {
        if (prefixTracked || !index.startsWith(prefix) || !track()) return;
        prefixTracked = true;
        registry!.add(`search indices ${prefix}*`, () => deletePrefix());
    };

    const deletePrefix = async () => {
        const rows = await http<{ index: string }[]>('GET', `/_cat/indices/${indexPath(`${prefix}*`)}`, undefined, { query: { format: 'json', h: 'index', expand_wildcards: 'all' } });
        const names = rows.map((r) => r.index).filter((n) => n.startsWith(prefix));
        // By name: wildcard deletes are refused by default (action.destructive_requires_name).
        for (let i = 0; i < names.length; i += 50) {
            await http('DELETE', `/${names.slice(i, i + 50).map(indexPath).join(',')}`, undefined, { query: { ignore_unavailable: true } });
        }
    };

    /** Records how to undo writes of these IDs to an index outside the prefix: their previous sources, read now. */
    const snapshot = async (index: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> => {
        const previous = new Map<string, Record<string, unknown>>();
        if (!ids.length) return previous;
        try {
            const res = await http<{ docs: { _id: string; found?: boolean; _source?: Record<string, unknown> }[] }>('POST', `/${indexPath(index)}/_mget`, { ids });
            for (const d of res.docs) if (d.found && d._source) previous.set(d._id, d._source);
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
        return previous;
    };

    /**
     * Undo for writes to an index outside the prefix: an index the write
     * created is deleted; otherwise each document is deleted or put back.
     */
    const recordUndo = (index: string, written: IndexResult[], previous: Map<string, Record<string, unknown>>, existed: boolean) => {
        if (!existed) {
            registry!.add(`search index ${index}`, () => client.deleteIndex(index));
            return;
        }
        if (!written.length) return;
        registry!.add(`search ${index}: ${written.length} document(s)`, async () => {
            const lines: string[] = [];
            for (const { id } of written) {
                const before = previous.get(id);
                lines.push(JSON.stringify(before ? { index: { _index: index, _id: id } } : { delete: { _index: index, _id: id } }));
                if (before) lines.push(JSON.stringify(before));
            }
            const res = await http<{ errors: boolean; items: Record<string, { status: number; error?: unknown }>[] }>('POST', '/_bulk', `${lines.join('\n')}\n`, { contentType: 'application/x-ndjson', query: { refresh: true } });
            const failed = res.items.map((item) => Object.values(item)[0]).filter((r) => r.error && r.status !== 404);
            if (failed.length) throw new Error(`${failed.length} undo(s) failed: ${short(failed[0].error)}`);
        });
    };

    const outside = (index: string) => !index.startsWith(prefix);

    const client: SearchClient = {
        prefix,

        indexName(name) {
            return `${prefix}${toIndexName(name)}`;
        },

        async info() {
            try {
                const res = await http<{ cluster_name: string; version: { number: string; distribution?: string } }>('GET', '/');
                return {
                    distribution: res.version.distribution === 'opensearch' ? 'opensearch' : 'elasticsearch',
                    version: res.version.number,
                    clusterName: res.cluster_name,
                };
            } catch (error) {
                return fail('request', { path: '/' }, error);
            }
        },

        async indexExists(index) {
            try {
                await http('HEAD', `/${indexPath(index)}`);
                return true;
            } catch (error) {
                if (isMissing(error)) return false;
                return fail('request', { index }, error);
            }
        },

        async createIndex(index, o = {}) {
            const existed = await client.indexExists(index);
            if (existed) return;
            const body: Record<string, unknown> = {};
            if (o.mappings) body.mappings = o.mappings;
            if (o.settings) body.settings = o.settings;
            if (o.aliases) body.aliases = o.aliases;
            try {
                await http('PUT', `/${indexPath(index)}`, body);
            } catch (error) {
                // Created meanwhile by a parallel test or the application: fine.
                if (!(error instanceof EngineError && /resource_already_exists/.test(error.message))) return fail('createIndex', { index }, error);
                return;
            }
            touch(index);
            if (outside(index) && track(o)) registry!.add(`search index ${index}`, () => client.deleteIndex(index));
        },

        async deleteIndex(index) {
            try {
                await http('DELETE', `/${indexPath(index)}`, undefined, { query: { ignore_unavailable: true } });
            } catch (error) {
                if (!isMissing(error)) fail('deleteIndex', { index }, error);
            }
        },

        async index(index, doc, o = {}) {
            const tracked = outside(index) && track(o);
            try {
                const existed = tracked ? await client.indexExists(index) : true;
                const previous = existed && tracked && o.id ? await snapshot(index, [o.id]) : new Map();
                const path = o.id ? `/${indexPath(index)}/_doc/${encodeURIComponent(o.id)}` : `/${indexPath(index)}/_doc`;
                const res = await http<{ _index: string; _id: string; result: string; _version: number }>(o.id ? 'PUT' : 'POST', path, doc, { query: { refresh: o.refresh ?? true } });
                const result = { index: res._index, id: res._id, result: res.result, version: res._version };
                touch(index);
                if (tracked) recordUndo(index, [result], previous, existed);
                return result;
            } catch (error) {
                return fail('index', { index, id: o.id }, error);
            }
        },

        async indexMany(index, docs, o = {}) {
            if (!docs.length) return [];
            const tracked = outside(index) && track(o);
            const ids = o.id ? docs.map((d, i) => o.id!(d, i)) : undefined;
            try {
                const existed = tracked ? await client.indexExists(index) : true;
                const previous = existed && tracked && ids ? await snapshot(index, ids) : new Map();
                const lines = docs.flatMap((doc, i) => [JSON.stringify({ index: { _index: index, ...(ids ? { _id: ids[i] } : {}) } }), JSON.stringify(doc)]);
                const res = await http<{ errors: boolean; items: { index: { _index: string; _id: string; result?: string; _version?: number; status: number; error?: unknown } }[] }>(
                    'POST', '/_bulk', `${lines.join('\n')}\n`, { contentType: 'application/x-ndjson', query: { refresh: o.refresh ?? true } },
                );
                const items = res.items.map((item) => item.index);
                const written = items.filter((r) => !r.error).map((r) => ({ index: r._index, id: r._id, result: r.result ?? 'created', version: r._version ?? 1 }));
                touch(index);
                if (tracked) recordUndo(index, written, previous, existed);
                const failed = items.map((r, i) => ({ r, i })).filter(({ r }) => r.error);
                if (failed.length) {
                    throw new Error(`${failed.length} of ${docs.length} document(s) failed, first #${failed[0].i}: ${engineError(failed[0].r.status, { error: failed[0].r.error })}`);
                }
                return written;
            } catch (error) {
                return fail('index', { index, documents: docs.length }, error);
            }
        },

        async get(index, id) {
            try {
                const res = await http<{ found: boolean; _source?: unknown }>('GET', `/${indexPath(index)}/_doc/${encodeURIComponent(id)}`);
                return res.found ? (res._source as never) : null;
            } catch (error) {
                if (isMissing(error)) return null;
                return fail('get', { index, id }, error);
            }
        },

        async search(index, query, o) {
            try {
                return toSearchResult(await http('POST', `/${indexPath(index)}/_search`, searchBody(query, o)));
            } catch (error) {
                return fail('search', { index, query }, error);
            }
        },

        async count(index, query) {
            try {
                const res = await http<{ count: number }>('POST', `/${indexPath(index)}/_count`, { query: query ?? { match_all: {} } });
                return res.count;
            } catch (error) {
                return fail('count', { index, query }, error);
            }
        },

        async deleteByQuery(index, query, o = {}) {
            try {
                const res = await http<{ deleted: number }>('POST', `/${indexPath(index)}/_delete_by_query`, { query }, { query: { refresh: o.refresh ?? true, conflicts: 'proceed' } });
                return res.deleted;
            } catch (error) {
                return fail('deleteByQuery', { index, query }, error);
            }
        },

        async refresh(index) {
            try {
                await http('POST', `/${indexPath(index)}/_refresh`);
            } catch (error) {
                fail('refresh', { index }, error);
            }
        },

        async waitForDocument(index, query, o = {}) {
            const timeout = o.timeout ?? timeoutDefault;
            const deadline = Date.now() + timeout;
            for (;;) {
                let missing = false;
                try {
                    const res = toSearchResult<never>(await http('POST', `/${indexPath(index)}/_search`, searchBody(query, { size: 1, ...o })));
                    if (res.hits.length) return res.hits[0];
                } catch (error) {
                    if (!(error instanceof EngineError && /index_not_found/.test(error.message))) fail('waitForDocument', { index, query }, error);
                    missing = true;
                }
                if (Date.now() >= deadline) {
                    return fail('waitForDocument', { index, query }, new Error(`no document matched within ${timeout} ms: ${missing ? "the index doesn't exist" : await describeIndex(index)}`));
                }
                await sleep(Math.min(o.interval ?? 250, Math.max(0, deadline - Date.now())));
            }
        },

        async waitForCount(index, query, expected, o = {}) {
            const timeout = o.timeout ?? timeoutDefault;
            const deadline = Date.now() + timeout;
            let last: number | string = 'none';
            for (;;) {
                try {
                    last = (await http<{ count: number }>('POST', `/${indexPath(index)}/_count`, { query: query ?? { match_all: {} } })).count;
                    if (last === expected) return;
                } catch (error) {
                    if (!(error instanceof EngineError && /index_not_found/.test(error.message))) fail('waitForDocument', { index, query }, error);
                    last = "the index doesn't exist";
                    if (expected === 0) return;
                }
                if (Date.now() >= deadline) {
                    return fail('waitForDocument', { index, query, expected }, new Error(`expected ${expected} matching document(s) within ${timeout} ms, last count: ${last}`));
                }
                await sleep(Math.min(o.interval ?? 250, Math.max(0, deadline - Date.now())));
            }
        },

        async request(method, path, body, o) {
            try {
                return await http(method.toUpperCase(), path, body, o);
            } catch (error) {
                return fail('request', { method, path }, error);
            }
        },

        close() {
            // fetch keeps no connection state to release
        },
    };

    /** "3 document(s), e.g. {...}" for a timeout message. */
    const describeIndex = async (index: string): Promise<string> => {
        try {
            const res = toSearchResult(await http('POST', `/${indexPath(index)}/_search`, { size: 3, track_total_hits: true, query: { match_all: {} } }));
            if (!res.total) return 'the index is empty';
            return `the index has ${res.total} document(s), e.g. ${res.hits.map((h) => `${h.id} ${short(h.source, 150)}`).join('; ')}`;
        } catch (error) {
            return `couldn't read the index (${reasonOf(error)})`;
        }
    };

    return client;
}

/** The search config: the project option, else ConfigLoader (environments.json, .env, PW_SEARCH_*). */
export async function resolveSearchConfig(search: SearchFixtureConfig | undefined): Promise<SearchFixtureConfig> {
    if (search) return search;
    const { ConfigLoader } = await import('../config/loader.js');
    try {
        return new ConfigLoader().load().search ?? {};
    } catch {
        return {};
    }
}

/**
 * Fixture definition for test.extend(). The undo actions run before the
 * test ends, while the cluster is still reachable.
 */
export const searchFixture = {
    searchClient: async (
        { search, stagehandContainers, dataCleanup }: { search: SearchFixtureConfig | undefined; stagehandContainers: ContainerManager; dataCleanup: CleanupRegistry },
        use: (client: SearchClient) => Promise<void>,
        testInfo: { workerIndex: number },
    ) => {
        const config = await stagehandContainers.search(await resolveSearchConfig(search));
        const client = createSearchClient(config, { registry: dataCleanup, runId: newRunId(testInfo.workerIndex) });
        try {
            await use(client);
            await dataCleanup.flush();
        } finally {
            client.close();
        }
    },
};
