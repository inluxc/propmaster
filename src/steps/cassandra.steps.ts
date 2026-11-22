/**
 * Cassandra / ScyllaDB Step Class
 *
 * Reusable steps for CQL: insert rows, expect the rows the application
 * wrote, check a lightweight transaction is refused. Each method runs inside
 * `test.step()`, so it shows up as one step in reports and traces.
 */

import { test, expect } from '../index.js';
import type {
    CassandraClient,
    CassandraInsertOptions,
    CassandraRow,
    CassandraWaitOptions,
    CqlOptions,
    CqlParams,
} from '../fixtures/cassandra.fixture.js';

export type { CassandraClient, CassandraRow, CqlParams } from '../fixtures/cassandra.fixture.js';

export class CassandraSteps {
    constructor(private cassandraClient: CassandraClient) {}

    /** Inserts rows (undone after the test). */
    async insert(description: string, table: string, rows: CassandraRow | CassandraRow[], options?: CassandraInsertOptions): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.cassandraClient.insert(table, rows, options);
        });
    }

    /** Runs a statement and checks it was applied. */
    async execute(description: string, cql: string, params?: CqlParams, options?: CqlOptions): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const { applied } = await this.cassandraClient.execute(cql, params, options);
            expect(applied, `applied: ${cql}`).toBe(true);
        });
    }

    /**
     * Waits until the query returns a row containing `expected`
     * (toMatchObject), and returns it. Keeps waiting while the row is there
     * but doesn't match yet, so it also covers "the status becomes shipped".
     */
    async expectRow<T extends CassandraRow = CassandraRow>(
        description: string,
        cql: string,
        params?: CqlParams,
        expected?: Record<string, unknown>,
        options?: { timeout?: number },
    ): Promise<T> {
        let row!: T;
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
                row = await this.cassandraClient.waitForRow<T>(cql, params, { ...options, until: matches });
            } catch (error) {
                // Show the difference, not just "didn't pass the check".
                const [current] = await this.cassandraClient.query<T>(cql, params);
                if (current && expected) expect(current, `first row of: ${cql}`).toMatchObject(expected);
                throw error;
            }
        });
        return row;
    }

    /** Waits until the query returns `count` rows (default 1); with `count`, checks there are exactly that many. */
    async expectRows<T extends CassandraRow = CassandraRow>(description: string, cql: string, params?: CqlParams, options?: CassandraWaitOptions<T>): Promise<T[]> {
        let rows!: T[];
        await test.step(`Step: ${description}`, async () => {
            rows = await this.cassandraClient.waitForRows<T>(cql, params, options);
            if (options?.count !== undefined) expect(rows, `rows of: ${cql}`).toHaveLength(options.count);
        });
        return rows;
    }

    /** Checks the query returns no rows, right now. */
    async expectNoRows(description: string, cql: string, params?: CqlParams): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            expect(await this.cassandraClient.query(cql, params), `rows of: ${cql}`).toEqual([]);
        });
    }

    /** Checks that a lightweight transaction (`IF NOT EXISTS`, `IF col = ?`) is not applied. */
    async expectNotApplied(description: string, cql: string, params?: CqlParams, options?: CqlOptions): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            const { applied } = await this.cassandraClient.execute(cql, params, options);
            expect(applied, `applied: ${cql}`).toBe(false);
        });
    }
}
