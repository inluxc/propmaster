/**
 * Database Connection Fixture for the Playwright Framework Template.
 *
 * Provides a DatabaseClient with query() and execute() methods,
 * supporting PostgreSQL (pg), MySQL (mysql2), MSSQL (mssql), and SQLite (better-sqlite3).
 *
 * Lifecycle:
 *   Setup: Read config → Create connection pool → Verify connectivity (ping)
 *   Teardown: Drain pool → Close all connections
 *
 * Errors:
 *   - FixtureInitError on connection failure (includes host, port, timeout)
 *   - FixtureOperationError on query failure (includes SQL statement)
 */

import { FixtureInitError, FixtureOperationError } from '../errors.js';
import { loadOptional } from './optional-package.js';
import type { ContainerManager } from '../containers/container-manager.js';
import { DatabaseFixtureConfig } from '../config/schema.js';
import type { CleanupRegistry, KeepOption } from '../test-data/registry.js';
import { trackDatabase } from '../test-data/tracking.js';

/**
 * Client interface exposed to tests for database operations.
 */
export interface DatabaseClient {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    /** Runs a statement. Not tracked for cleanup: use insert() or testData.cleanup() for data the test creates. */
    execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;
    /**
     * Inserts one row or many, and deletes them again when the test ends (pass or fail).
     * Rows are matched for the delete on `options.key`, else `id` when every row has one,
     * else every inserted column. `{ keep: true }` leaves them in place.
     */
    insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[], options?: InsertOptions): Promise<{ affectedRows: number }>;
    close(): Promise<void>;
}

export interface InsertOptions extends KeepOption {
    /** Column(s) identifying an inserted row for the cleanup DELETE (default: `id`, else every inserted column). */
    key?: string | string[];
}

/** A database connection before cleanup tracking adds insert(). */
export type DatabaseConnection = Omit<DatabaseClient, 'insert'>;

const DEFAULT_CONNECTION_TIMEOUT = 10000;
const DEFAULT_QUERY_TIMEOUT = 30000;

/**
 * Creates a PostgreSQL database client using the `pg` library.
 */
async function createPostgresClient(config: DatabaseFixtureConfig): Promise<DatabaseConnection> {
    const { Pool } = await loadOptional<typeof import('pg')>('pg', 'databaseClient (postgresql)');

    const connectionTimeout = config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
    const queryTimeout = config.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;

    const pool = new Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.username,
        password: config.password,
        connectionTimeoutMillis: connectionTimeout,
        statement_timeout: queryTimeout,
    });

    // Verify connectivity with a ping query
    try {
        const client = await pool.connect();
        try {
            await client.query('SELECT 1');
        } finally {
            client.release();
        }
    } catch (error) {
        await pool.end().catch(() => { });
        throw new FixtureInitError('database', 'connect', {
            host: config.host,
            port: config.port,
            timeout: connectionTimeout,
            reason: error instanceof Error ? error.message : String(error),
        }, error instanceof Error ? error : undefined);
    }

    return {
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
            try {
                const result = await pool.query(sql, params);
                return result.rows as T[];
            } catch (error) {
                throw new FixtureOperationError('database', 'query', {
                    sql,
                    reason: error instanceof Error ? error.message : String(error),
                    timeout: queryTimeout,
                }, error instanceof Error ? error : undefined);
            }
        },

        async execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }> {
            try {
                const result = await pool.query(sql, params);
                return { affectedRows: result.rowCount ?? 0 };
            } catch (error) {
                throw new FixtureOperationError('database', 'query', {
                    sql,
                    reason: error instanceof Error ? error.message : String(error),
                    timeout: queryTimeout,
                }, error instanceof Error ? error : undefined);
            }
        },

        async close(): Promise<void> {
            await pool.end();
        },
    };
}

/**
 * Creates a MySQL database client using the `mysql2` library.
 */
async function createMysqlClient(config: DatabaseFixtureConfig): Promise<DatabaseConnection> {
    const mysql = await loadOptional<typeof import('mysql2/promise')>('mysql2/promise', 'databaseClient (mysql)', ['mysql2']);

    const connectionTimeout = config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
    const queryTimeout = config.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;

    let pool: ReturnType<typeof mysql.createPool>;

    try {
        pool = mysql.createPool({
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.username,
            password: config.password,
            connectTimeout: connectionTimeout,
            waitForConnections: true,
            connectionLimit: 10,
        });

        // Verify connectivity with a ping query
        const connection = await pool.getConnection();
        try {
            await connection.query('SELECT 1');
        } finally {
            connection.release();
        }
    } catch (error) {
        if (pool!) {
            await pool!.end().catch(() => { });
        }
        throw new FixtureInitError('database', 'connect', {
            host: config.host,
            port: config.port,
            timeout: connectionTimeout,
            reason: error instanceof Error ? error.message : String(error),
        }, error instanceof Error ? error : undefined);
    }

    return {
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
            try {
                const normalized = normalizePositionalParams(sql, params);
                const connection = await pool.getConnection();
                try {
                    await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${queryTimeout}`);
                    const [rows] = await connection.query(normalized.sql, normalized.params);
                    return rows as T[];
                } finally {
                    connection.release();
                }
            } catch (error) {
                if (error instanceof FixtureOperationError) throw error;
                throw new FixtureOperationError('database', 'query', {
                    sql,
                    reason: error instanceof Error ? error.message : String(error),
                    timeout: queryTimeout,
                }, error instanceof Error ? error : undefined);
            }
        },

        async execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }> {
            try {
                const normalized = normalizePositionalParams(sql, params);
                const connection = await pool.getConnection();
                try {
                    await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${queryTimeout}`);
                    const [result] = await connection.query(normalized.sql, normalized.params);
                    const affectedRows = (result as { affectedRows?: number }).affectedRows ?? 0;
                    return { affectedRows };
                } finally {
                    connection.release();
                }
            } catch (error) {
                if (error instanceof FixtureOperationError) throw error;
                throw new FixtureOperationError('database', 'query', {
                    sql,
                    reason: error instanceof Error ? error.message : String(error),
                    timeout: queryTimeout,
                }, error instanceof Error ? error : undefined);
            }
        },

        async close(): Promise<void> {
            await pool.end();
        },
    };
}

/**
 * Converts PostgreSQL-style positional parameters ($1, $2, ...) to question-mark style (?)
 * used by MySQL and SQLite. Optionally normalizes parameter values (e.g., booleans to integers)
 * for drivers that don't support boolean binding.
 */
function normalizePositionalParams(
    sql: string,
    params?: unknown[],
    options?: { convertBooleans?: boolean },
): { sql: string; params: unknown[] } {
    // Replace $1, $2, ... with ?
    const normalizedSql = sql.replace(/\$(\d+)/g, '?');

    let normalizedParams = params ?? [];

    if (options?.convertBooleans) {
        normalizedParams = normalizedParams.map((p) => {
            if (typeof p === 'boolean') return p ? 1 : 0;
            return p;
        });
    }

    return { sql: normalizedSql, params: normalizedParams };
}

/**
 * Creates a SQLite database client using the `better-sqlite3` library.
 */
async function createSqliteClient(config: DatabaseFixtureConfig): Promise<DatabaseConnection> {
    // CommonJS `export =` module: a dynamic import exposes it as `default`.
    const BetterSqlite3 = await loadOptional<{ default: typeof import('better-sqlite3') }>('better-sqlite3', 'databaseClient (sqlite)');

    const queryTimeout = config.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;

    let db: InstanceType<typeof BetterSqlite3.default>;

    try {
        db = new BetterSqlite3.default(config.database);
        // Set a busy timeout equivalent to connection timeout
        db.pragma(`busy_timeout = ${config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT}`);
        // Verify connectivity
        db.prepare('SELECT 1').get();
    } catch (error) {
        throw new FixtureInitError('database', 'connect', {
            host: config.host ?? 'local',
            port: config.port ?? 0,
            timeout: config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
            reason: error instanceof Error ? error.message : String(error),
        }, error instanceof Error ? error : undefined);
    }

    return {
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
            try {
                db.pragma(`busy_timeout = ${queryTimeout}`);
                const normalized = normalizePositionalParams(sql, params, { convertBooleans: true });
                const stmt = db.prepare(normalized.sql);
                const rows = normalized.params.length > 0 ? stmt.all(...normalized.params) : stmt.all();
                return rows as T[];
            } catch (error) {
                throw new FixtureOperationError('database', 'query', {
                    sql,
                    reason: error instanceof Error ? error.message : String(error),
                    timeout: queryTimeout,
                }, error instanceof Error ? error : undefined);
            }
        },

        async execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }> {
            try {
                db.pragma(`busy_timeout = ${queryTimeout}`);
                const normalized = normalizePositionalParams(sql, params, { convertBooleans: true });
                const stmt = db.prepare(normalized.sql);
                const result = normalized.params.length > 0 ? stmt.run(...normalized.params) : stmt.run();
                return { affectedRows: result.changes };
            } catch (error) {
                throw new FixtureOperationError('database', 'query', {
                    sql,
                    reason: error instanceof Error ? error.message : String(error),
                    timeout: queryTimeout,
                }, error instanceof Error ? error : undefined);
            }
        },

        async close(): Promise<void> {
            db.close();
        },
    };
}

/**
 * Creates a MSSQL database client using the `mssql` library.
 */
async function createMssqlClient(config: DatabaseFixtureConfig): Promise<DatabaseConnection> {
    const mssqlModule = await loadOptional<typeof import('mssql')>('mssql', 'databaseClient (mssql)');
    // Handle ESM/CJS interop — ConnectionPool may be on default export or top-level
    const mssql = ((mssqlModule as unknown as { default?: typeof mssqlModule }).default ?? mssqlModule) as typeof mssqlModule;

    const connectionTimeout = config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
    const queryTimeout = config.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;

    const mssqlConfig = {
        server: config.host ?? 'localhost',
        port: config.port ?? 1433,
        database: config.database,
        user: config.username,
        password: config.password,
        connectionTimeout,
        requestTimeout: queryTimeout,
        options: {
            encrypt: config.encrypt ?? true,
            trustServerCertificate: config.trustServerCertificate ?? false,
        },
        pool: {
            max: 10,
            min: 0,
            idleTimeoutMillis: 30000,
        },
    };

    let pool: InstanceType<typeof mssql.ConnectionPool>;

    try {
        pool = await new mssql.ConnectionPool(mssqlConfig).connect();
        // Verify connectivity with a ping query
        await pool.request().query('SELECT 1 AS ping');
    } catch (error) {
        throw new FixtureInitError('database', 'connect', {
            host: config.host,
            port: config.port ?? 1433,
            timeout: connectionTimeout,
            reason: error instanceof Error ? error.message : String(error),
        }, error instanceof Error ? error : undefined);
    }

    return {
        async query<T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<T[]> {
            try {
                const request = pool.request();
                // Bind positional parameters as @p1, @p2, etc.
                if (params && params.length > 0) {
                    params.forEach((param, index) => {
                        request.input(`p${index + 1}`, param);
                    });
                    // Replace $1, $2, ... placeholders with @p1, @p2, ...
                    sqlText = sqlText.replace(/\$(\d+)/g, (_, num) => `@p${num}`);
                }
                const result = await request.query(sqlText);
                return result.recordset as T[];
            } catch (error) {
                throw new FixtureOperationError('database', 'query', {
                    sql: sqlText,
                    reason: error instanceof Error ? error.message : String(error),
                    timeout: queryTimeout,
                }, error instanceof Error ? error : undefined);
            }
        },

        async execute(sqlText: string, params?: unknown[]): Promise<{ affectedRows: number }> {
            try {
                const request = pool.request();
                if (params && params.length > 0) {
                    params.forEach((param, index) => {
                        request.input(`p${index + 1}`, param);
                    });
                    sqlText = sqlText.replace(/\$(\d+)/g, (_, num) => `@p${num}`);
                }
                const result = await request.query(sqlText);
                return { affectedRows: result.rowsAffected[0] ?? 0 };
            } catch (error) {
                throw new FixtureOperationError('database', 'query', {
                    sql: sqlText,
                    reason: error instanceof Error ? error.message : String(error),
                    timeout: queryTimeout,
                }, error instanceof Error ? error : undefined);
            }
        },

        async close(): Promise<void> {
            await pool.close();
        },
    };
}

/**
 * Creates a DatabaseClient based on the configured database type.
 */
export async function createDatabaseClient(config: DatabaseFixtureConfig): Promise<DatabaseConnection> {
    switch (config.type) {
        case 'postgresql':
            return createPostgresClient(config);
        case 'mysql':
            return createMysqlClient(config);
        case 'mssql':
            return createMssqlClient(config);
        case 'sqlite':
            return createSqliteClient(config);
        default:
            throw new FixtureInitError('database', 'connect', {
                reason: `Unsupported database type: ${(config as { type: string }).type}`,
            });
    }
}

/**
 * Playwright fixture definition for the database client.
 *
 * Usage in tests:
 *   test('query users', async ({ databaseClient }) => {
 *     const users = await databaseClient.query<User>('SELECT * FROM users');
 *     expect(users).toHaveLength(3);
 *   });
 */
export const databaseFixture = {
    databaseClient: async (
        { database, stagehandContainers, dataCleanup }: { database: DatabaseFixtureConfig | undefined; stagehandContainers: ContainerManager; dataCleanup: CleanupRegistry },
        use: (client: DatabaseClient) => Promise<void>,
    ) => {
        // Use config from project `use` block if provided, otherwise fall back to ConfigLoader
        let config: DatabaseFixtureConfig | undefined = database;

        if (!config) {
            const { ConfigLoader } = await import('../config/loader.js');
            const loader = new ConfigLoader();
            const frameworkConfig = loader.load();
            config = frameworkConfig.database;
        }

        if (!config) {
            throw new FixtureInitError('database', 'connect', {
                reason: 'Database configuration is missing. Provide database config in environments.json, environment variables, or project use block.',
            });
        }

        // With `container` set, start (or reuse) this worker's database container.
        config = await stagehandContainers.database(config);

        // Setup: create client and verify connectivity
        const connection = await createDatabaseClient(config);
        const client = trackDatabase(connection, dataCleanup);

        // Provide client to the test
        try {
            await use(client);
            // Undo the test's inserts (every client is still connected here)
            await dataCleanup.flush();
        } finally {
            // Teardown: close connections
            await connection.close();
        }
    },
};
