/**
 * Search Step Class
 *
 * Reusable steps for Elasticsearch / OpenSearch (`SearchSteps`). Each method
 * runs inside `test.step()`, so it shows up as one step in reports and traces.
 */

import { test, expect } from '../index.js';
import type { IndexOptions, IndexResult, SearchClient, SearchHit, SearchOptions, SearchQuery, SearchResult, SearchWaitOptions } from '../fixtures/search.fixture.js';

export type { SearchClient, SearchHit, SearchResult } from '../fixtures/search.fixture.js';

export class SearchSteps {
    constructor(private searchClient: SearchClient) {}

    /** Indexes a document (searchable at once, undone after the test). */
    async index<T extends Record<string, unknown>>(description: string, index: string, doc: T, options?: IndexOptions): Promise<IndexResult> {
        let result!: IndexResult;
        await test.step(`Step: ${description}`, async () => {
            result = await this.searchClient.index(index, doc, options);
        });
        return result;
    }

    /** Waits until a document matches the query and returns it. */
    async expectDocument<T = Record<string, unknown>>(description: string, index: string, query?: SearchQuery, options?: SearchWaitOptions & SearchOptions): Promise<SearchHit<T>> {
        let hit!: SearchHit<T>;
        await test.step(`Step: ${description}`, async () => {
            hit = await this.searchClient.waitForDocument<T>(index, query, options);
        });
        return hit;
    }

    /** Waits for a matching document and checks its source contains `expected` (toMatchObject). */
    async expectDocumentMatching<T = Record<string, unknown>>(description: string, index: string, query: SearchQuery, expected: Record<string, unknown>, options?: SearchWaitOptions): Promise<SearchHit<T>> {
        let hit!: SearchHit<T>;
        await test.step(`Step: ${description}`, async () => {
            hit = await this.searchClient.waitForDocument<T>(index, query, options);
            expect(hit.source as Record<string, unknown>, `source of ${index}/${hit.id}`).toMatchObject(expected);
        });
        return hit;
    }

    /** Waits until exactly `count` documents match (e.g. 0 after a delete). */
    async expectCount(description: string, index: string, query: SearchQuery | undefined, count: number, options?: SearchWaitOptions): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.searchClient.waitForCount(index, query, count, options);
        });
    }

    /** Searches and checks the IDs of the hits, in order (e.g. a relevance ranking). */
    async expectRanking(description: string, index: string, query: SearchQuery, ids: string[], options?: SearchOptions): Promise<SearchResult<Record<string, unknown>>> {
        let result!: SearchResult<Record<string, unknown>>;
        await test.step(`Step: ${description}`, async () => {
            result = await this.searchClient.search(index, query, { size: ids.length, ...options });
            expect(result.hits.map((h) => h.id), `hits for ${JSON.stringify(query)} in ${index}`).toEqual(ids);
        });
        return result;
    }
}
