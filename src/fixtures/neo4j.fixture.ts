/**
 * Neo4j graph database fixture for the Playwright Framework Template.
 *
 * Provides a Neo4j client with read (`run`), write (`write`) and transactional
 * (`executeInTransaction`) Cypher execution. Results are returned as plain
 * objects (`record.toObject()`) with Neo4j Integers converted to JS numbers,
 * so tests can assert on them directly.
 *
 * Uses the official neo4j-driver.
 *
 * Error handling:
 *   - FixtureInitError when the driver cannot reach or authenticate with the server
 *   - FixtureOperationError when a Cypher statement fails (includes the statement)
 */

import type { Driver, ManagedTransaction, QueryResult, RecordShape } from 'neo4j-driver';
import { loadOptional } from './optional-package.js';

type Neo4jModule = typeof import('neo4j-driver');

/**
 * neo4j-driver is an optional peer dependency, loaded when the first driver is
 * created. Driver values (Integers, nodes, ...) only exist after that, so
 * toPlain() can rely on it being set.
 */
let neo4j: Neo4jModule | undefined;
import type { Neo4jFixtureConfig } from '../config/schema.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import type { CleanupRegistry, KeepOption } from '../test-data/registry.js';
import { trackNeo4j } from '../test-data/tracking.js';

/** Cypher parameters — always pass values here, never interpolate them into the statement. */
export type CypherParams = Record<string, unknown>;

/**
 * Update counters returned by write operations.
 */
export interface Neo4jWriteResult {
    nodesCreated: number;
    relationshipsCreated: number;
    propertiesSet: number;
    nodesDeleted: number;
    relationshipsDeleted: number;
}

/**
 * Transaction handle passed to `executeInTransaction` callbacks.
 * All statements run inside one write transaction, committed when the callback
 * resolves and rolled back when it throws.
 */
export interface Neo4jTransaction {
    run<T = Record<string, unknown>>(cypher: string, params?: CypherParams): Promise<T[]>;
}

/**
 * Neo4j client interface exposed to tests.
 */
export interface Neo4jClient {
    /** Runs a read query and returns each record as a plain object. */
    run<T = Record<string, unknown>>(cypher: string, params?: CypherParams): Promise<T[]>;
    /** Runs a write query and returns its update counters. With a `runId` parameter, nodes carrying that runId are detach-deleted when the test ends, unless `{ keep: true }`. */
    write(cypher: string, params?: CypherParams, options?: KeepOption): Promise<Neo4jWriteResult>;
    /** Runs `fn` inside a single write transaction and returns its result. */
    executeInTransaction<R>(fn: (tx: Neo4jTransaction) => Promise<R>): Promise<R>;
    /** Closes the underlying driver. Called automatically on teardown. */
    close(): Promise<void>;
}

const DEFAULT_CONNECTION_TIMEOUT = 10000;

/**
 * Recursively converts Neo4j driver values into plain JS values:
 * Integers become numbers, nodes/relationships/paths become plain objects.
 */
export function toPlain(value: unknown): unknown {
    if (value === null || value === undefined || !neo4j) return value;
    const { isInt, isNode, isRelationship, isPath } = neo4j;
    if (isInt(value)) return value.toNumber();
    if (Array.isArray(value)) return value.map(toPlain);
    if (isNode(value)) {
        return {
            elementId: value.elementId,
            labels: [...value.labels],
            properties: toPlain(value.properties),
        };
    }
    if (isRelationship(value)) {
        return {
            elementId: value.elementId,
            type: value.type,
            startNodeElementId: value.startNodeElementId,
            endNodeElementId: value.endNodeElementId,
            properties: toPlain(value.properties),
        };
    }
    if (isPath(value)) {
        return {
            start: toPlain(value.start),
            end: toPlain(value.end),
            segments: value.segments.map((s) => ({
                start: toPlain(s.start),
                relationship: toPlain(s.relationship),
                end: toPlain(s.end),
            })),
        };
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = toPlain(v);
        }
        return out;
    }
    // Temporal / spatial types and other driver values are returned unchanged.
    return value;
}

function recordsToObjects<T>(result: QueryResult<RecordShape>): T[] {
    return result.records.map((record) => toPlain(record.toObject()) as T);
}

function wrapError(operation: 'run' | 'write' | 'transaction', cypher: string | undefined, error: unknown): FixtureOperationError {
    return new FixtureOperationError(
        'neo4j',
        operation,
        {
            ...(cypher !== undefined ? { cypher } : {}),
            reason: error instanceof Error ? error.message : String(error),
        },
        error instanceof Error ? error : undefined,
    );
}

/**
 * Creates a driver and verifies the server is reachable and the credentials work.
 */
export async function createNeo4jDriver(config: Neo4jFixtureConfig): Promise<Driver> {
    const connectionTimeout = config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
    let driver: Driver | undefined;
    neo4j ??= await loadOptional<Neo4jModule>('neo4j-driver', 'neo4jClient');
    const { driver: createDriver, auth } = neo4j;

    try {
        driver = createDriver(config.uri, auth.basic(config.username, config.password), {
            connectionTimeout,
            connectionAcquisitionTimeout: connectionTimeout,
        });
        await driver.verifyConnectivity({ database: config.database });
        return driver;
    } catch (error) {
        if (driver) {
            await driver.close().catch(() => { });
        }
        throw new FixtureInitError(
            'neo4j',
            'connect',
            {
                uri: config.uri,
                database: config.database ?? '(default)',
                timeout: connectionTimeout,
                reason: error instanceof Error ? error.message : String(error),
            },
            error instanceof Error ? error : undefined,
        );
    }
}

/**
 * Builds the Neo4jClient interface around a connected driver.
 */
function buildNeo4jClient(driver: Driver, config: Neo4jFixtureConfig): Neo4jClient {
    const database = config.database;

    const wrapTx = (tx: ManagedTransaction): Neo4jTransaction => ({
        async run<T>(cypher: string, params?: CypherParams): Promise<T[]> {
            try {
                return recordsToObjects<T>(await tx.run(cypher, params ?? {}));
            } catch (error) {
                throw wrapError('transaction', cypher, error);
            }
        },
    });

    return {
        async run<T = Record<string, unknown>>(cypher: string, params?: CypherParams): Promise<T[]> {
            try {
                const result = await driver.executeQuery(cypher, params ?? {}, {
                    database,
                    routing: neo4j!.routing.READ,
                });
                return recordsToObjects<T>(result);
            } catch (error) {
                throw wrapError('run', cypher, error);
            }
        },

        async write(cypher: string, params?: CypherParams): Promise<Neo4jWriteResult> {
            try {
                const { summary } = await driver.executeQuery(cypher, params ?? {}, {
                    database,
                    routing: neo4j!.routing.WRITE,
                });
                const updates = summary.counters.updates();
                return {
                    nodesCreated: updates.nodesCreated,
                    relationshipsCreated: updates.relationshipsCreated,
                    propertiesSet: updates.propertiesSet,
                    nodesDeleted: updates.nodesDeleted,
                    relationshipsDeleted: updates.relationshipsDeleted,
                };
            } catch (error) {
                throw wrapError('write', cypher, error);
            }
        },

        async executeInTransaction<R>(fn: (tx: Neo4jTransaction) => Promise<R>): Promise<R> {
            const session = driver.session({ database });
            try {
                return await session.executeWrite((tx) => fn(wrapTx(tx)));
            } catch (error) {
                if (error instanceof FixtureOperationError) throw error;
                throw wrapError('transaction', undefined, error);
            } finally {
                await session.close();
            }
        },

        async close(): Promise<void> {
            await driver.close();
        },
    };
}

/**
 * Neo4j fixture definition for Playwright's test.extend() pattern.
 *
 * Setup: Creates the driver and verifies connectivity.
 * Teardown: Closes the driver.
 */
export const neo4jFixture = {
    neo4jClient: async (
        { neo4jConfig, dataCleanup }: { neo4jConfig: Neo4jFixtureConfig; dataCleanup: CleanupRegistry },
        use: (client: Neo4jClient) => Promise<void>,
    ) => {
        const driver = await createNeo4jDriver(neo4jConfig);
        const neo4jClient = buildNeo4jClient(driver, neo4jConfig);

        try {
            await use(trackNeo4j(neo4jClient, dataCleanup));
            // Undo the test's runId-tagged writes (every client is still connected here)
            await dataCleanup.flush();
        } finally {
            try {
                await driver.close();
            } catch {
                // Don't fail the test on teardown errors
            }
        }
    },
};
