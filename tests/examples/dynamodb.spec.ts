/**
 * DynamoDB Fixture — Example Tests
 *
 * Shows how to write, read, query and wait for DynamoDB items with
 * `dynamoDbClient` using plain objects, plus the DynamoDbSteps class. Most
 * tests make a table of their own with `createTable()` (deleted afterwards);
 * TC-DDB-005 writes into a long-lived table, the way a test writes into the
 * application's, and shows those writes being undone.
 *
 * Prerequisites:
 *   - An AWS emulator or test account: PW_AWS_ENDPOINT (Moto, LocalStack or
 *     DynamoDB Local, e.g. http://localhost:4566), PW_AWS_CONTAINER=true, or
 *     `aws` in environments.json
 *   - `docker compose -f compose.test.yaml up -d --wait moto` runs Moto locally
 */

import { test, expect } from '../../src';
import { DynamoDbSteps } from '../../src/steps';
import type { DynamoTableDefinition } from '../../src';

interface Order {
    customerId: string;
    orderedAt: number;
    status: string;
    total: number;
    [key: string]: unknown;
}

const ORDERS: DynamoTableDefinition = {
    key: { customerId: 'S', orderedAt: 'N' },
    indexes: { byStatus: { status: 'S', orderedAt: 'N' } },
};

test.describe('DynamoDB Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-DDB-001] write, read, update and delete items as plain objects', { tag: ['@TC-DDB-001'] }, async ({ dynamoDbClient, testData }) => {
        const table = dynamoDbClient.tableName('orders');
        const customerId = testData.unique('customer');

        await test.step('Step 1: Create a table of the test\'s own', async () => {
            await dynamoDbClient.createTable(table, ORDERS);
            expect(await dynamoDbClient.tableKey(table)).toEqual({ partitionKey: 'customerId', sortKey: 'orderedAt' });
        });

        await test.step('Step 2: Write an item with a map, a list and a set', async () => {
            await dynamoDbClient.put(table, {
                customerId,
                orderedAt: 1,
                status: 'open',
                total: 42.5,
                address: { city: 'Porto', zip: '4000-001' },
                lines: [{ sku: 'A-1', qty: 2 }],
                tags: new Set(['gift']),
            });
        });

        await test.step('Step 3: Verify it reads back with the same types', async () => {
            const order = await dynamoDbClient.get<Order>(table, { customerId, orderedAt: 1 });
            expect(order).toMatchObject({ status: 'open', total: 42.5, address: { city: 'Porto' }, lines: [{ sku: 'A-1', qty: 2 }] });
            expect(order!.tags).toEqual(new Set(['gift']));
        });

        await test.step('Step 4: Update two fields, remove one, and get the new item back', async () => {
            const updated = await dynamoDbClient.update<Order>(table, { customerId, orderedAt: 1 }, { status: 'shipped', carrier: 'DHL' }, { remove: ['tags'] });
            expect(updated).toMatchObject({ status: 'shipped', carrier: 'DHL', total: 42.5 });
            expect(updated).not.toHaveProperty('tags');
        });

        await test.step('Step 5: Delete it and verify it is gone', async () => {
            const removed = await dynamoDbClient.delete<Order>(table, { customerId, orderedAt: 1 });
            expect(removed?.status).toBe('shipped');
            expect(await dynamoDbClient.get(table, { customerId, orderedAt: 1 })).toBeNull();
            expect(await dynamoDbClient.delete(table, { customerId, orderedAt: 1 })).toBeNull();
        });
    });

    test('[TC-DDB-002] query by key, sort-key range, index and filter', { tag: ['@TC-DDB-002'] }, async ({ dynamoDbClient, testData }) => {
        const table = dynamoDbClient.tableName('orders');
        const customerId = testData.unique('customer');

        await test.step('Step 1: Create the table and write five orders', async () => {
            await dynamoDbClient.createTable(table, ORDERS);
            await dynamoDbClient.putMany(table, [1, 2, 3, 4, 5].map((n) => ({
                customerId,
                orderedAt: 1_700_000_000 + n,
                status: n % 2 ? 'open' : 'shipped',
                total: n * 10,
            })));
        });

        await test.step('Step 2: Verify a query returns them in sort-key order, or newest first', async () => {
            const all = await dynamoDbClient.query<Order>(table, { customerId });
            expect(all.map((o) => o.total)).toEqual([10, 20, 30, 40, 50]);
            const latestTwo = await dynamoDbClient.query<Order>(table, { customerId }, { descending: true, limit: 2 });
            expect(latestTwo.map((o) => o.total)).toEqual([50, 40]);
        });

        await test.step('Step 3: Verify a sort-key range and a filter', async () => {
            const range = await dynamoDbClient.query<Order>(table, { customerId, orderedAt: { between: [1_700_000_002, 1_700_000_004] } });
            expect(range.map((o) => o.total)).toEqual([20, 30, 40]);
            const bigOpen = await dynamoDbClient.query<Order>(table, { customerId }, { filter: { status: 'open', total: { '>': 10 } } });
            expect(bigOpen.map((o) => o.total)).toEqual([30, 50]);
        });

        await test.step('Step 4: Verify the status index and a count', async () => {
            const shipped = await dynamoDbClient.query<Order>(table, { status: 'shipped' }, { index: 'byStatus' });
            expect(shipped.map((o) => o.total)).toEqual([20, 40]);
            expect(await dynamoDbClient.count(table, { customerId }, { filter: { status: 'open' } })).toBe(3);
            expect(await dynamoDbClient.scan(table, { filter: { total: { in: [10, 50] } } })).toHaveLength(2);
        });
    });

    test('[TC-DDB-003] wait for an item the application writes and updates later', { tag: ['@TC-DDB-003'] }, async ({ dynamoDbClient, testData }) => {
        const dynamo = new DynamoDbSteps(dynamoDbClient);
        const table = dynamoDbClient.tableName('orders');
        const key = { customerId: testData.unique('customer'), orderedAt: 1 };

        await test.step('Step 1: Create the table', async () => {
            await dynamoDbClient.createTable(table, ORDERS);
        });

        await test.step('Step 2: Start a job that writes the order after a second and ships it a second later', async () => {
            // Stands in for the application: it writes on its own schedule.
            setTimeout(() => void dynamoDbClient.put(table, { ...key, status: 'open', total: 10 }), 1000);
            setTimeout(() => void dynamoDbClient.update(table, key, { status: 'shipped' }), 2000);
        });

        await dynamo.expectItem('Verify the order appears', table, key, { status: 'open' });
        await dynamo.expectItem('Verify the order is shipped', table, key, { status: 'shipped', total: 10 }, { timeout: 10_000 });
        await dynamo.expectQuery('Verify the status index has it', table, { status: 'shipped' }, { index: 'byStatus', count: 1 });
    });

    test('[TC-DDB-004] conditional writes refuse duplicates and stale versions', { tag: ['@TC-DDB-004'] }, async ({ dynamoDbClient, testData }) => {
        const dynamo = new DynamoDbSteps(dynamoDbClient);
        const table = dynamoDbClient.tableName('accounts');
        const id = testData.unique('acct');

        await test.step('Step 1: Create the table and an account at version 1', async () => {
            await dynamoDbClient.createTable(table, { key: { id: 'S' } });
            await dynamoDbClient.put(table, { id, balance: 100, version: 1 }, { ifNotExists: true });
        });

        await dynamo.expectConditionFailed('Verify a second create with the same ID is refused', () =>
            dynamoDbClient.put(table, { id, balance: 0, version: 1 }, { ifNotExists: true }));

        await test.step('Step 2: Update at the current version', async () => {
            const updated = await dynamoDbClient.update(table, { id }, { balance: 80, version: 2 }, { condition: { version: 1 } });
            expect(updated).toMatchObject({ balance: 80, version: 2 });
        });

        await dynamo.expectConditionFailed('Verify an update at the old version is refused', () =>
            dynamoDbClient.update(table, { id }, { balance: 0, version: 2 }, { condition: { version: 1 } }));

        await test.step('Step 3: Verify the balance is the one from the accepted update', async () => {
            expect(await dynamoDbClient.get(table, { id })).toMatchObject({ balance: 80, version: 2 });
        });
    });

    test('[TC-DDB-005] writes to a shared table are undone after the test', { tag: ['@TC-DDB-005'] }, async ({ dynamoDbClient, dataCleanup, testData }) => {
        // Stands in for the application's table: it outlives the test.
        const table = 'propmaster-examples-settings';
        const tenant = testData.unique('tenant');

        await test.step('Step 1: Make sure the table and a seeded item exist (kept)', async () => {
            await dynamoDbClient.createTable(table, { key: { tenant: 'S' } }, { keep: true });
            await dynamoDbClient.put(table, { tenant, plan: 'free' }, { keep: true });
        });

        await test.step('Step 2: Change the seeded item and add another', async () => {
            await dynamoDbClient.update(table, { tenant }, { plan: 'pro' });
            await dynamoDbClient.put(table, { tenant: `${tenant}-b`, plan: 'trial' });
            expect(dataCleanup.pending).toEqual([
                `dynamodb restore ${table} {"tenant":"${tenant}"}`,
                `dynamodb ${table} {"tenant":"${tenant}-b"}`,
            ]);
        });

        await test.step('Step 3: Run the cleanup now and verify the table is as it was', async () => {
            // Runs by itself after every test; called here to show the result.
            await dataCleanup.flush();
            expect(await dynamoDbClient.get(table, { tenant })).toEqual({ tenant, plan: 'free' });
            expect(await dynamoDbClient.get(table, { tenant: `${tenant}-b` })).toBeNull();
        });

        await test.step('Step 4: Remove the seeded item', async () => {
            await dynamoDbClient.delete(table, { tenant });
        });
    });
});
