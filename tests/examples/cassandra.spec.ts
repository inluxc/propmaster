/**
 * Cassandra / ScyllaDB Fixture — Example Tests
 *
 * Shows parameterized CQL with `cassandraClient`: rows as plain objects,
 * inserts undone after the test, waiting for rows the application writes,
 * lightweight transactions, and keyspaces of the test's own. Plus the
 * CassandraSteps class.
 *
 * Prerequisites:
 *   - ScyllaDB or Cassandra: PW_CASSANDRA_CONTACT_POINTS (default localhost),
 *     PW_CASSANDRA_CONTAINER=true, or `cassandra` in environments.json
 *   - PW_CASSANDRA_KEYSPACE=propmaster_examples with
 *     PW_CASSANDRA_CREATE_KEYSPACE=true (the keyspace TC-CAS-005 writes into)
 *   - `docker compose -f compose.test.yaml up -d --wait scylla` runs ScyllaDB locally
 */

import { test, expect } from '../../src';
import { CassandraSteps } from '../../src/steps';

interface Order {
    customer_id: string;
    ordered_at: Date;
    status: string;
    total: string;
    qty: number;
    tags: string[] | null;
    [key: string]: unknown;
}

const ORDERS = (keyspace: string) => `
    CREATE TABLE IF NOT EXISTS ${keyspace}.orders (
        customer_id text, ordered_at timestamp, id uuid, status text, total decimal, qty bigint, tags set<text>,
        PRIMARY KEY ((customer_id), ordered_at)
    ) WITH CLUSTERING ORDER BY (ordered_at DESC)`;

test.describe('Cassandra Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-CAS-001] insert and query rows as plain objects', { tag: ['@TC-CAS-001'] }, async ({ cassandraClient, testData }) => {
        const customerId = testData.unique('customer');
        let keyspace = '';

        await test.step('Step 1: Create a keyspace and table of the test\'s own', async () => {
            keyspace = await cassandraClient.createKeyspace();
            await cassandraClient.execute(ORDERS(keyspace));
            expect(await cassandraClient.primaryKey(`${keyspace}.orders`)).toEqual({ partitionKeys: ['customer_id'], clusteringKeys: ['ordered_at'] });
        });

        await test.step('Step 2: Insert two orders with a uuid, a decimal, a bigint and a set', async () => {
            await cassandraClient.insert(`${keyspace}.orders`, [
                { customer_id: customerId, ordered_at: new Date('2026-01-01T10:00:00Z'), id: '6ab09bec-e68e-48d9-a5f8-97e6fb4c9b47', status: 'open', total: '12.30', qty: 2, tags: ['gift'] },
                { customer_id: customerId, ordered_at: new Date('2026-01-02T10:00:00Z'), status: 'shipped', total: '5.00', qty: 1 },
            ]);
        });

        await test.step('Step 3: Verify the rows come back newest first, with plain values', async () => {
            const orders = await cassandraClient.query<Order>(`SELECT * FROM ${keyspace}.orders WHERE customer_id = ?`, [customerId]);
            expect(orders.map((o) => o.status)).toEqual(['shipped', 'open']);
            expect(orders[1]).toMatchObject({ id: '6ab09bec-e68e-48d9-a5f8-97e6fb4c9b47', total: '12.30', qty: 2, tags: ['gift'] });
            expect(orders[1].ordered_at).toEqual(new Date('2026-01-01T10:00:00Z'));
        });

        await test.step('Step 4: Verify named parameters and a range on the clustering key', async () => {
            const recent = await cassandraClient.query<Order>(
                `SELECT status FROM ${keyspace}.orders WHERE customer_id = :customer AND ordered_at > :since`,
                { customer: customerId, since: new Date('2026-01-01T12:00:00Z') },
            );
            expect(recent).toEqual([{ status: 'shipped' }]);
        });
    });

    test('[TC-CAS-002] wait for a row the application writes and then updates', { tag: ['@TC-CAS-002'] }, async ({ cassandraClient, testData }) => {
        const cassandra = new CassandraSteps(cassandraClient);
        const customerId = testData.unique('customer');
        const at = new Date('2026-02-01T09:00:00Z');
        let keyspace = '';

        await test.step('Step 1: Create the table', async () => {
            keyspace = await cassandraClient.createKeyspace();
            await cassandraClient.execute(ORDERS(keyspace));
        });

        await test.step('Step 2: Start a job that writes the order after a second and ships it a second later', async () => {
            // Stands in for the application: it writes on its own schedule.
            const insert = `INSERT INTO ${keyspace}.orders (customer_id, ordered_at, status, total) VALUES (?, ?, 'open', 10)`;
            const ship = `UPDATE ${keyspace}.orders SET status = 'shipped' WHERE customer_id = ? AND ordered_at = ?`;
            setTimeout(() => void cassandraClient.execute(insert, [customerId, at]), 1000);
            setTimeout(() => void cassandraClient.execute(ship, [customerId, at]), 2000);
        });

        const select = `SELECT * FROM ${keyspace}.orders WHERE customer_id = ?`;
        await cassandra.expectRow('Verify the order appears', select, [customerId], { status: 'open' });
        await cassandra.expectRow('Verify the order is shipped', select, [customerId], { status: 'shipped', total: '10' }, { timeout: 10_000 });
        await cassandra.expectRows('Verify there is exactly one order', select, [customerId], { count: 1 });
    });

    test('[TC-CAS-003] lightweight transactions refuse duplicates and stale versions', { tag: ['@TC-CAS-003'] }, async ({ cassandraClient, testData }) => {
        const cassandra = new CassandraSteps(cassandraClient);
        const id = testData.unique('acct');
        let table = '';

        await test.step('Step 1: Create an accounts table and an account at version 1', async () => {
            const keyspace = await cassandraClient.createKeyspace();
            table = `${keyspace}.accounts`;
            await cassandraClient.execute(`CREATE TABLE ${table} (id text PRIMARY KEY, balance int, version int)`);
            const { applied } = await cassandraClient.insert(table, { id, balance: 100, version: 1 }, { ifNotExists: true });
            expect(applied).toBe(1);
        });

        await test.step('Step 2: Verify a second insert with the same ID is not applied', async () => {
            const { applied } = await cassandraClient.insert(table, { id, balance: 0, version: 1 }, { ifNotExists: true });
            expect(applied).toBe(0);
        });

        await cassandra.execute('Update at the current version', `UPDATE ${table} SET balance = ?, version = ? WHERE id = ? IF version = ?`, [80, 2, id, 1]);
        await cassandra.expectNotApplied('Verify an update at the old version is refused', `UPDATE ${table} SET balance = ?, version = ? WHERE id = ? IF version = ?`, [0, 2, id, 1]);

        await test.step('Step 3: Verify the balance is the one from the accepted update', async () => {
            const [account] = await cassandraClient.query(`SELECT balance, version FROM ${table} WHERE id = ?`, [id], { consistency: 'serial' });
            expect(account).toEqual({ balance: 80, version: 2 });
        });
    });

    test('[TC-CAS-004] a batch and a TTL', { tag: ['@TC-CAS-004'] }, async ({ cassandraClient, testData }) => {
        const userId = testData.unique('user');
        let keyspace = '';

        await test.step('Step 1: Create a sessions table', async () => {
            keyspace = await cassandraClient.createKeyspace();
            await cassandraClient.execute(`CREATE TABLE ${keyspace}.sessions (user_id text, session_id text, PRIMARY KEY (user_id, session_id))`);
        });

        await test.step('Step 2: Write two sessions in one batch and one with a 1-second TTL', async () => {
            await cassandraClient.batch([
                { cql: `INSERT INTO ${keyspace}.sessions (user_id, session_id) VALUES (?, ?)`, params: [userId, 'a'] },
                { cql: `INSERT INTO ${keyspace}.sessions (user_id, session_id) VALUES (?, ?)`, params: [userId, 'b'] },
            ]);
            await cassandraClient.insert(`${keyspace}.sessions`, { user_id: userId, session_id: 'short' }, { ttl: 1 });
        });

        await test.step('Step 3: Verify the TTL session expires and the others stay', async () => {
            const sessionIds = async () => (await cassandraClient.query<{ session_id: string }>(`SELECT session_id FROM ${keyspace}.sessions WHERE user_id = ?`, [userId])).map((r) => r.session_id);
            expect(await sessionIds()).toEqual(['a', 'b', 'short']);
            await expect.poll(sessionIds, { timeout: 10_000 }).toEqual(['a', 'b']);
        });
    });

    test('[TC-CAS-005] inserts into a shared keyspace are undone after the test', { tag: ['@TC-CAS-005'] }, async ({ cassandraClient, dataCleanup, testData }) => {
        // The configured keyspace stands in for the application's: it outlives the test.
        const tenant = testData.unique('tenant');

        await test.step('Step 1: Make sure the table and a seeded row exist (kept)', async () => {
            expect(cassandraClient.keyspace).toBeDefined();
            await cassandraClient.execute('CREATE TABLE IF NOT EXISTS settings (tenant text PRIMARY KEY, plan text)');
            await cassandraClient.insert('settings', { tenant, plan: 'free' }, { keep: true });
        });

        await test.step('Step 2: Overwrite the seeded row and add another', async () => {
            await cassandraClient.insert('settings', [{ tenant, plan: 'pro' }, { tenant: `${tenant}-b`, plan: 'trial' }]);
            expect(dataCleanup.pending).toEqual([
                `cassandra restore ${cassandraClient.keyspace}.settings {"tenant":"${tenant}"}`,
                `cassandra ${cassandraClient.keyspace}.settings {"tenant":"${tenant}-b"}`,
            ]);
        });

        await test.step('Step 3: Run the cleanup now and verify the table is as it was', async () => {
            // Runs by itself after every test; called here to show the result.
            await dataCleanup.flush();
            expect(await cassandraClient.query('SELECT plan FROM settings WHERE tenant = ?', [tenant])).toEqual([{ plan: 'free' }]);
            expect(await cassandraClient.query('SELECT plan FROM settings WHERE tenant = ?', [`${tenant}-b`])).toEqual([]);
        });

        await test.step('Step 4: Remove the seeded row', async () => {
            await cassandraClient.execute('DELETE FROM settings WHERE tenant = ?', [tenant]);
        });
    });
});
