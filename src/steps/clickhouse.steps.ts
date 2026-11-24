/**
 * ClickHouse Step Class
 *
 * Reusable steps for ClickHouse: insert rows, expect the rows the
 * application wrote, check a table's row count. Each method runs inside
 * `test.step()`, so it shows up as one step in reports and traces.
 */

import { test, expect } from '../index.js';
import type {
    ClickHouseClient,
    ClickHouseInsertOptions,
    ClickHouseParams,
    ClickHouseRow,
    ClickHouseWaitOptions,
} from '../fixtures/clickhouse.fixture.js';

export type { ClickHouseClient, ClickHouseRow, ClickHouseParams } from '../fixtures/clickhouse.fixture.js';

export class ClickHouseSteps {
    constructor(private clickHouseClient: ClickHouseClient) {}

    /** Inserts rows (deleted after the test). */
    async insert(description: string, table: string, rows: ClickHouseRow | ClickHouseRow[], options?: ClickHouseInsertOptions): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            await this.clickHouseClient.insert(table, rows, options);
        });
    }

    /**
     * Waits until the query returns a row containing `expected`
     * (toMatchObject), and returns it. Keeps waiting while the row is there
     * but doesn't match yet, so it also covers "the total reaches 3".
     */
    async expectRow<T extends ClickHouseRow = ClickHouseRow>(
        description: string,
        sql: string,
        params?: ClickHouseParams,
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
                row = await this.clickHouseClient.waitForRow<T>(sql, params, { ...options, until: matches });
            } catch (error) {
                // Show the difference, not just "didn't pass the check".
                const [current] = await this.clickHouseClient.query<T>(sql, params);
                if (current && expected) expect(current, `first row of: ${sql}`).toMatchObject(expected);
                throw error;
            }
        });
        return row;
    }

    /** Waits until the query returns `count` rows (default 1); with `count`, checks there are exactly that many. */
    async expectRows<T extends ClickHouseRow = ClickHouseRow>(description: string, sql: string, params?: ClickHouseParams, options?: ClickHouseWaitOptions<T>): Promise<T[]> {
        let rows!: T[];
        await test.step(`Step: ${description}`, async () => {
            rows = await this.clickHouseClient.waitForRows<T>(sql, params, options);
            if (options?.count !== undefined) expect(rows, `rows of: ${sql}`).toHaveLength(options.count);
        });
        return rows;
    }

    /** Checks the query returns no rows, right now. */
    async expectNoRows(description: string, sql: string, params?: ClickHouseParams): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            expect(await this.clickHouseClient.query(sql, params), `rows of: ${sql}`).toEqual([]);
        });
    }

    /** Checks how many rows a table has (optionally only those matching `where`). */
    async expectCount(description: string, table: string, expected: number, where?: ClickHouseRow): Promise<void> {
        await test.step(`Step: ${description}`, async () => {
            expect(await this.clickHouseClient.count(table, where), `rows in ${table}`).toBe(expected);
        });
    }
}
