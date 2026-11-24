/**
 * ClickHouse Fixture — Example Tests
 *
 * Shows parameterized SQL with `clickHouseClient`: rows as plain objects
 * (64-bit integers as numbers), inserts deleted after the test, waiting for
 * rows the application writes, counts, and databases of the test's own.
 * Plus the ClickHouseSteps class.
 *
 * Prerequisites:
 *   - ClickHouse: PW_CLICKHOUSE_URL (default http://localhost:8123),
 *     PW_CLICKHOUSE_CONTAINER=true, or `clickhouse` in environments.json
 *   - `docker compose -f compose.test.yaml up -d --wait clickhouse` runs ClickHouse locally
 */

import { test, expect } from '../../src';
import { ClickHouseSteps } from '../../src/steps';

interface Event {
    id: string;
    user_id: string;
    kind: string;
    at: string;
    amount: number;
    tags: string[];
    [key: string]: unknown;
}

const EVENTS = (database: string) => `
    CREATE TABLE IF NOT EXISTS ${database}.events (
        id String, user_id String, kind LowCardinality(String), at DateTime64(3, 'UTC'), amount UInt64, tags Array(String)
    ) ENGINE = MergeTree ORDER BY (user_id, at)`;

test.describe('ClickHouse Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-CH-001] insert and query rows as plain objects', { tag: ['@TC-CH-001'] }, async ({ clickHouseClient, testData }) => {
        const userId = testData.unique('user');
        let database = '';

        await test.step('Step 1: Create a database and table of the test\'s own', async () => {
            database = await clickHouseClient.createDatabase();
            await clickHouseClient.execute(EVENTS(database));
            expect((await clickHouseClient.columns(`${database}.events`)).map((c) => c.name)).toEqual(['id', 'user_id', 'kind', 'at', 'amount', 'tags']);
        });

        await test.step('Step 2: Insert two events, one with a Date and a value beyond 2^53', async () => {
            const { inserted } = await clickHouseClient.insert(`${database}.events`, [
                { id: testData.unique('ev'), user_id: userId, kind: 'view', at: new Date('2026-01-01T10:00:00Z'), amount: 3, tags: ['home'] },
                { id: testData.unique('ev'), user_id: userId, kind: 'buy', at: '2026-01-02 10:00:00', amount: 2n ** 60n, tags: [] },
            ]);
            expect(inserted).toBe(2);
        });

        await test.step('Step 3: Verify the rows come back with plain values', async () => {
            const events = await clickHouseClient.query<Event>(
                `SELECT * FROM ${database}.events WHERE user_id = {user:String} ORDER BY at`,
                { user: userId },
            );
            expect(events.map((e) => e.kind)).toEqual(['view', 'buy']);
            expect(events[0]).toMatchObject({ amount: 3, tags: ['home'], at: '2026-01-01 10:00:00.000' });
            expect(events[1].amount).toBe(2n ** 60n);
        });

        await test.step('Step 4: Verify aggregates are numbers, not quoted strings', async () => {
            const [stats] = await clickHouseClient.query<{ n: number; views: number }>(
                `SELECT count() AS n, countIf(kind = 'view') AS views FROM ${database}.events WHERE user_id = {user:String}`,
                { user: userId },
            );
            expect(stats).toEqual({ n: 2, views: 1 });
        });
    });

    test('[TC-CH-002] inserted rows are deleted after the test', { tag: ['@TC-CH-002'] }, async ({ clickHouseClient, testData }) => {
        const id = testData.unique('ev');

        await test.step('Step 1: Create the shared table if it is missing (kept)', async () => {
            await clickHouseClient.execute(EVENTS(clickHouseClient.database));
        });

        await test.step('Step 2: Register a check that runs after the row is deleted', async () => {
            // Undo actions run newest first: registered before the insert, this one runs after its delete.
            testData.cleanup('check the row is gone', async () => {
                expect(await clickHouseClient.count('events', { id })).toBe(0);
            });
        });

        await test.step('Step 3: Insert a row into the shared table', async () => {
            await clickHouseClient.insert('events', { id, user_id: 'shared', kind: 'view', at: new Date(), amount: 1, tags: [] });
            expect(await clickHouseClient.count('events', { id })).toBe(1);
        });
    });

    test('[TC-CH-003] wait for rows the application writes', { tag: ['@TC-CH-003'] }, async ({ clickHouseClient, testData }) => {
        const userId = testData.unique('user');
        let database = '';

        await test.step('Step 1: Create a table of the test\'s own', async () => {
            database = await clickHouseClient.createDatabase();
            await clickHouseClient.execute(EVENTS(database));
        });

        await test.step('Step 2: Write rows later, as an asynchronous pipeline would', async () => {
            setTimeout(() => {
                void clickHouseClient.insert(`${database}.events`, [1, 2, 3].map((n) => ({
                    id: `${userId}-${n}`, user_id: userId, kind: 'view', at: new Date(), amount: n, tags: [],
                })));
            }, 500);
        });

        await test.step('Step 3: Wait until all three rows are there', async () => {
            const rows = await clickHouseClient.waitForRows<Event>(
                `SELECT * FROM ${database}.events WHERE user_id = {user:String}`,
                { user: userId },
                { count: 3, timeout: 10_000 },
            );
            expect(rows.map((r) => r.amount).sort()).toEqual([1, 2, 3]);
        });

        await test.step('Step 4: Verify a wait that times out says what it found', async () => {
            await expect(clickHouseClient.waitForRows(
                `SELECT * FROM ${database}.events WHERE user_id = {user:String}`,
                { user: userId },
                { count: 4, timeout: 500 },
            )).rejects.toThrow(/waited 500 ms for 4 row\(s\), found 3/);
        });
    });

    test('[TC-CH-004] errors name the statement and ClickHouse\'s reason', { tag: ['@TC-CH-004'] }, async ({ clickHouseClient }) => {
        await test.step('Step 1: Query a table that does not exist', async () => {
            await expect(clickHouseClient.query('SELECT * FROM no_such_table_here')).rejects.toThrow(/UNKNOWN_TABLE|does not exist/);
        });

        await test.step('Step 2: Bind a value of the wrong type', async () => {
            await expect(clickHouseClient.query('SELECT {n:UInt8} AS n', { n: 'not a number' })).rejects.toThrow(/clickhouse/i);
        });
    });

    test('[TC-CH-005] ClickHouseSteps: insert, expect a row and a count', { tag: ['@TC-CH-005'] }, async ({ clickHouseClient, testData }) => {
        const steps = new ClickHouseSteps(clickHouseClient);
        const userId = testData.unique('user');
        let database = '';

        await test.step('Step 1: Create a table of the test\'s own', async () => {
            database = await clickHouseClient.createDatabase();
            await clickHouseClient.execute(EVENTS(database));
        });

        await test.step('Step 2: Insert, then expect the row, the count and no other user\'s rows', async () => {
            await steps.insert('Insert a purchase', `${database}.events`, { id: testData.unique('ev'), user_id: userId, kind: 'buy', at: new Date(), amount: 42, tags: ['promo'] });
            const row = await steps.expectRow<Event>('Purchase is stored', `SELECT * FROM ${database}.events WHERE user_id = {user:String}`, { user: userId }, { kind: 'buy', amount: 42 });
            expect(row.tags).toEqual(['promo']);
            await steps.expectCount('One event for the user', `${database}.events`, 1, { user_id: userId });
            await steps.expectNoRows('No events for another user', `SELECT * FROM ${database}.events WHERE user_id = {user:String}`, { user: `${userId}-other` });
        });
    });
});
