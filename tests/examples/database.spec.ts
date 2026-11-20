/**
 * Database Fixture — Example Test
 *
 * Demonstrates how to use the Database client fixture to run queries and
 * execute statements against PostgreSQL, MySQL, MSSQL, or SQLite databases.
 * Uses the DatabaseSteps class for reusable step sequences.
 *
 * Prerequisites:
 *   - Database configured in environments.json or via PW_DB_* environment variables
 *   - The target database server running and accessible
 *
 * @requirements 7.3, 1.6
 */

import { test, expect } from '../../src';
import { DatabaseSteps } from '../../src/steps';

test.describe('Database Fixture Examples', () => {
    test.skip(!process.env.CI, 'Skipped: requires CI infrastructure');

    test('[TC-DB-001] query rows from a table', { tag: ['@TC-DB-001'] }, async ({ databaseClient }) => {
        const db = new DatabaseSteps(databaseClient);

        const users = await db.query<{ id: number; name: string; email: string }>(
            'Execute parameterized SELECT query for active users',
            'SELECT id, name, email FROM users WHERE active = $1',
            [true],
        );

        await db.verifyRowProperties('Verify returned rows have expected properties', users, ['id', 'name', 'email']);
    });

    test('[TC-DB-002] execute an insert statement', { tag: ['@TC-DB-002'] }, async ({ databaseClient }) => {
        const db = new DatabaseSteps(databaseClient);

        await db.executeExpectAffected(
            'Insert a new user record',
            'INSERT INTO users (name, email, active) VALUES ($1, $2, $3)',
            ['Test User', 'test@example.com', true],
            1,
        );
    });

    test('[TC-DB-003] execute an update statement', { tag: ['@TC-DB-003'] }, async ({ databaseClient }) => {
        const db = new DatabaseSteps(databaseClient);

        const result = await db.execute(
            'Update user active status by email',
            'UPDATE users SET active = $1 WHERE email = $2',
            [false, 'test@example.com'],
        );

        await test.step('Step 1: Verify affected rows is non-negative', async () => {
            expect(result.affectedRows).toBeGreaterThanOrEqual(0);
        });
    });

    test('[TC-DB-004] query with no results returns empty array', { tag: ['@TC-DB-004'] }, async ({ databaseClient }) => {
        const db = new DatabaseSteps(databaseClient);

        await db.queryExpectEmpty(
            'Query with non-existent ID returns empty',
            'SELECT * FROM users WHERE id = $1',
            [-1],
        );
    });

    test('[TC-DB-005] factory rows are deleted after the test', { tag: ['@TC-DB-005'] }, async ({ databaseClient, testData }) => {
        const user = testData.define('user', (f) => ({ name: `User ${f.seq}`, email: f.email('db'), active: true }));
        const rows = testData.buildMany(user, 3);

        await test.step('Step 1: Insert three users built by the factory', async () => {
            const result = await databaseClient.insert('users', rows);
            expect(result.affectedRows).toBe(3);
        });

        await test.step('Step 2: Verify the rows exist', async () => {
            const found = await databaseClient.query('SELECT email FROM users WHERE email IN ($1, $2, $3)', rows.map((r) => r.email));
            expect(found).toHaveLength(3);
        });

        await test.step('Step 3: Run the cleanups now (normally at teardown) and verify the rows are gone', async () => {
            await testData.flushCleanups();
            const found = await databaseClient.query('SELECT email FROM users WHERE email IN ($1, $2, $3)', rows.map((r) => r.email));
            expect(found).toEqual([]);
        });
    });
});
