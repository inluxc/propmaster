/**
 * DynamoDB Step Class
 *
 * Reusable steps for DynamoDB: write an item, expect the item the
 * application wrote, check a query's results, check a conditional write is
 * refused. Each method runs inside `test.step()`, so it shows up as one step
 * in reports and traces.
 */

import { test, expect } from '../index.js';
import { FixtureOperationError } from '../errors.js';
import type {
    DynamoConditions,
    DynamoDbClient,
    DynamoExpression,
    DynamoItem,
    DynamoKey,
    DynamoPutOptions,
    DynamoQueryOptions,
    DynamoWaitForItemOptions,
    DynamoWaitForQueryOptions,
} from '../fixtures/dynamodb.fixture.js';

export type { DynamoDbClient, DynamoItem, DynamoKey } from '../fixtures/dynamodb.fixture.js';

export class DynamoDbSteps {
    constructor(private dynamoDbClient: DynamoDbClient) {}

    /** Writes an item (undone after the test). */
    async put(description: string, table: string, item: DynamoItem, options?: DynamoPutOptions): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.dynamoDbClient.put(table, item, options);
        });
    }

    /**
     * Waits for the item with this key and checks it contains `expected`
     * (toMatchObject). Keeps waiting while the item is there but doesn't match
     * yet, so it also covers "the status changes to shipped".
     */
    async expectItem<T extends DynamoItem = DynamoItem>(
        description: string,
        table: string,
        key: DynamoKey,
        expected?: Record<string, unknown>,
        options?: Omit<DynamoWaitForItemOptions<T>, 'until'>,
    ): Promise<T> {
        let item!: T;
        await test.step(`Step: ${description}`, async () => {
            const matches = (candidate: T) => {
                try {
                    expect(candidate).toMatchObject(expected ?? {});
                    return true;
                } catch {
                    return false;
                }
            };
            try {
                item = await this.dynamoDbClient.waitForItem<T>(table, key, { ...options, until: matches });
            } catch (error) {
                // Show the difference, not just "didn't pass the check".
                const current = await this.dynamoDbClient.get<T>(table, key);
                if (current && expected) expect(current, `item ${JSON.stringify(key)} in ${table}`).toMatchObject(expected);
                throw error;
            }
        });
        return item;
    }

    /** Checks there is no item with this key. */
    async expectNoItem(description: string, table: string, key: DynamoKey): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const item = await this.dynamoDbClient.get(table, key);
            expect(item, `item ${JSON.stringify(key)} in ${table}`).toBeNull();
        });
    }

    /** Waits until a query returns `count` items (default 1) and returns them. */
    async expectQuery<T extends DynamoItem = DynamoItem>(
        description: string,
        table: string,
        keyCondition: DynamoConditions | DynamoExpression,
        options?: DynamoWaitForQueryOptions,
    ): Promise<T[]> {
        let items!: T[];
        await test.step(`Step: ${description}`, async () => {
            items = await this.dynamoDbClient.waitForQuery<T>(table, keyCondition, options);
            if (options?.count !== undefined) expect(items, `items matching the query on ${table}`).toHaveLength(options.count);
        });
        return items;
    }

    /** Checks a query returns exactly this many items, right now. */
    async expectCount(
        description: string,
        table: string,
        keyCondition: DynamoConditions | DynamoExpression,
        count: number,
        options?: Omit<DynamoQueryOptions, 'limit' | 'descending'>,
    ): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            expect(await this.dynamoDbClient.count(table, keyCondition, options), `items matching the query on ${table}`).toBe(count);
        });
    }

    /** Checks that a conditional write is refused because its condition fails (e.g. a duplicate or a stale version). */
    async expectConditionFailed(description: string, write: () => Promise<unknown>): Promise<FixtureOperationError> {
        let error!: FixtureOperationError;
        await test.step(`Step: ${description}`, async () => {
            const outcome = await write().then(() => undefined, (e: unknown) => e);
            if (outcome === undefined) throw new Error('expected the write to be refused by its condition, but it succeeded');
            expect(outcome).toBeInstanceOf(FixtureOperationError);
            expect((outcome as Error).message).toContain('ConditionalCheckFailedException');
            error = outcome as FixtureOperationError;
        });
        return error;
    }
}
