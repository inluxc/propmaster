/**
 * Tracking wrappers: each client fixture wraps its client so inserts made in
 * a test record their own undo in the test's CleanupRegistry.
 *
 * What is tracked, and how it is undone:
 *   databaseClient.insert(table, rows)  → DELETE the rows (by `key`, `id`, or every inserted column)
 *   mongoDbClient.insertOne/insertMany  → deleteMany by the inserted _ids
 *   redisClient.set(key, ...)           → DEL the key, or restore the value it had before
 *   neo4jClient.write(cypher, { runId }) → MATCH (n {runId}) DETACH DELETE n
 *
 * Raw SQL through `databaseClient.execute()` isn't tracked (its effect can't
 * be undone reliably); use `insert()` or `testData.cleanup()`. Every tracked
 * call takes `{ keep: true }` to leave its data in place.
 */

import { FixtureOperationError } from '../errors.js';
import type { CleanupRegistry, KeepOption } from './registry.js';
import type { DatabaseClient, DatabaseConnection, InsertOptions } from '../fixtures/database.fixture.js';
import type { MongoDbClient, InsertManyResult, InsertOneResult } from '../fixtures/mongodb.fixture.js';
import type { RedisClient } from '../fixtures/redis.fixture.js';
import type { CypherParams, Neo4jClient, Neo4jTransaction } from '../fixtures/neo4j.fixture.js';

export type { KeepOption } from './registry.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/;

function assertIdentifier(name: string, what: string): void {
    if (!IDENTIFIER.test(name)) {
        throw new FixtureOperationError('database', 'insert', {
            [what]: name,
            reason: `"${name}" isn't a plain ${what} name (letters, digits, _ and $, optionally schema-qualified); use execute() for anything else`,
        });
    }
}

/** Builds the parameterized multi-row INSERT for `rows` (placeholders `$1, $2, ...`, valid for every dialect). */
export function buildInsert(table: string, rows: Record<string, unknown>[]): { sql: string; params: unknown[]; columns: string[] } {
    assertIdentifier(table, 'table');
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    if (!columns.length) {
        throw new FixtureOperationError('database', 'insert', { table, reason: 'rows have no columns' });
    }
    columns.forEach((c) => assertIdentifier(c, 'column'));
    const params: unknown[] = [];
    const tuples = rows.map((row) => `(${columns.map((c) => (params.push(row[c] ?? null), `$${params.length}`)).join(', ')})`);
    return { sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params, columns };
}

/** The DELETE that removes one inserted row, matching on `keys` (NULLs with IS NULL). */
export function buildDelete(table: string, row: Record<string, unknown>, keys: string[]): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const where = keys.map((k) => {
        const v = row[k];
        if (v === null || v === undefined) return `${k} IS NULL`;
        params.push(v);
        return `${k} = $${params.length}`;
    });
    return { sql: `DELETE FROM ${table} WHERE ${where.join(' AND ')}`, params };
}

/** The columns that identify an inserted row: `key`, else `id` when every row has one, else every inserted column. */
export function keyColumns(rows: Record<string, unknown>[], columns: string[], key?: string | string[]): string[] {
    if (key) {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach((k) => assertIdentifier(k, 'column'));
        return keys;
    }
    if (rows.every((r) => r.id !== undefined && r.id !== null)) return ['id'];
    return columns;
}

/** Adds `insert()` to a database connection, recording a DELETE for each inserted row. */
export function trackDatabase(conn: DatabaseConnection, registry: CleanupRegistry): DatabaseClient {
    return {
        ...conn,
        async insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[], options: InsertOptions = {}) {
            const list = Array.isArray(rows) ? rows : [rows];
            if (!list.length) return { affectedRows: 0 };
            const { sql, params, columns } = buildInsert(table, list);
            const keys = keyColumns(list, columns, options.key);
            const result = await conn.execute(sql, params);
            if (!options.keep && registry.autoCleanup) {
                registry.add(`database ${table}: ${list.length} row(s)`, async () => {
                    for (const row of [...list].reverse()) {
                        const del = buildDelete(table, row, keys);
                        await conn.execute(del.sql, del.params);
                    }
                });
            }
            return result;
        },
    };
}

/** Records a deleteMany by _id for every document inserted through the client. */
export function trackMongo(client: MongoDbClient, registry: CleanupRegistry): MongoDbClient {
    const undo = (collection: string, ids: unknown[]) => {
        if (!ids.length || !registry.autoCleanup) return;
        registry.add(`mongodb ${collection}: ${ids.length} document(s)`, () => client.deleteMany(collection, { _id: { $in: ids } }));
    };
    return {
        ...client,
        async insertOne(collection: string, document: Record<string, unknown>, options?: KeepOption): Promise<InsertOneResult> {
            const result = await client.insertOne(collection, document);
            if (!options?.keep) undo(collection, [result.insertedId]);
            return result;
        },
        async insertMany(collection: string, documents: Record<string, unknown>[], options?: KeepOption): Promise<InsertManyResult> {
            const result = await client.insertMany(collection, documents);
            if (!options?.keep) undo(collection, Object.values(result.insertedIds));
            return result;
        },
    };
}

/** Records, for each key set through the client, a DEL (new key) or a restore of the previous value. */
export function trackRedis(client: RedisClient, registry: CleanupRegistry): RedisClient {
    return {
        ...client,
        async set(key: string, value: string, ttl?: number, options?: KeepOption): Promise<void> {
            const track = !options?.keep && registry.autoCleanup;
            const previous = track ? await client.get(key) : null;
            await client.set(key, value, ttl);
            if (!track) return;
            if (previous === null) registry.add(`redis ${key}: delete`, () => client.del(key));
            else registry.add(`redis ${key}: restore previous value`, () => client.set(key, previous));
        },
    };
}

/** The run IDs a Cypher write tags its data with (`runId` parameter). */
export function runIdOf(params?: CypherParams): string | undefined {
    const id = params?.runId;
    return typeof id === 'string' && id ? id : undefined;
}

/**
 * Records, for each distinct `runId` parameter a write uses, a DETACH DELETE
 * of every node carrying that runId. Writes without a `runId` aren't tracked.
 */
export function trackNeo4j(client: Neo4jClient, registry: CleanupRegistry): Neo4jClient {
    const seen = new Set<string>();
    const note = (params?: CypherParams, options?: KeepOption) => {
        const runId = runIdOf(params);
        if (!runId || options?.keep || !registry.autoCleanup || seen.has(runId)) return;
        seen.add(runId);
        registry.add(`neo4j nodes with runId ${runId}`, async () => {
            seen.delete(runId);
            await client.write('MATCH (n {runId: $runId}) DETACH DELETE n', { runId });
        });
    };
    return {
        ...client,
        async write(cypher: string, params?: CypherParams, options?: KeepOption) {
            const result = await client.write(cypher, params);
            note(params, options);
            return result;
        },
        async executeInTransaction<R>(fn: (tx: Neo4jTransaction) => Promise<R>): Promise<R> {
            const used: CypherParams[] = [];
            const result = await client.executeInTransaction((tx) =>
                fn({
                    ...tx,
                    run: (cypher, params) => {
                        if (params) used.push(params);
                        return tx.run(cypher, params);
                    },
                }),
            );
            used.forEach((p) => note(p)); // committed: now there is something to undo
            return result;
        },
    };
}
