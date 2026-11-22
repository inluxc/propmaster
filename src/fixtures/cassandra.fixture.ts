/**
 * Cassandra / ScyllaDB fixture.
 *
 * `cassandraClient` runs parameterized CQL against Cassandra or ScyllaDB, in
 * the same shape as `databaseClient`:
 *
 * - `query()` returns rows as plain objects: UUIDs, inet addresses, dates and
 *   decimals as strings, bigints and varints as numbers (bigint beyond 2^53).
 * - `execute()` runs anything else and reports whether a lightweight
 *   transaction (`IF NOT EXISTS`, `IF col = ?`) was applied.
 * - `insert()` writes rows and undoes them after the test: a new row is
 *   deleted, an overwritten one gets its previous values back.
 * - `waitForRows()` polls until the application has written what the test
 *   expects, and fails with what is there instead.
 * - `createKeyspace()` makes a keyspace of the test's own, dropped afterwards;
 *   `createKeyspace: true` in the config creates the configured one when it's
 *   missing (local runs, containers).
 *
 * Statements are always prepared with their parameters, never built from
 * strings. Uses cassandra-driver, an optional peer dependency loaded on first use.
 */

import type { Client as DriverClient, types as DriverTypes } from 'cassandra-driver';
import type { CassandraFixtureConfig } from '../config/schema.js';
import type { ContainerManager } from '../containers/container-manager.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import type { CleanupRegistry, KeepOption } from '../test-data/registry.js';
import { newRunId } from '../test-data/factory.js';
import { loadOptional } from './optional-package.js';

type Driver = typeof import('cassandra-driver');

export const DEFAULT_CASSANDRA_PORT = 9042;
export const DEFAULT_CASSANDRA_DATA_CENTER = 'datacenter1';
export const DEFAULT_CASSANDRA_TIMEOUT = 10_000;
// NetworkTopologyStrategy: keyspaces on ScyllaDB's tablets (on by default in current versions) refuse SimpleStrategy; Cassandra 4+ takes both.
export const DEFAULT_REPLICATION = { class: 'NetworkTopologyStrategy', replication_factor: 1 } as const;

/** Bound values: positional (`?`) as an array, or named (`:name`) as an object. */
export type CqlParams = unknown[] | Record<string, unknown>;

export type CassandraRow = Record<string, unknown>;

export interface CqlOptions {
    /** Consistency level for this statement, e.g. `quorum` (default: the config's). */
    consistency?: NonNullable<CassandraFixtureConfig['consistency']>;
    /** Rows per page while reading (default: the driver's, 5000). Every page is read. */
    fetchSize?: number;
    /** Driver values (`Uuid`, `Long`, `LocalDate`, ...) instead of plain ones. */
    raw?: boolean;
}

export interface CassandraInsertOptions extends KeepOption {
    /** Expire the rows after this many seconds (`USING TTL`). */
    ttl?: number;
    /** Only insert rows that don't exist yet (`IF NOT EXISTS`); `insert()` then reports which were applied. */
    ifNotExists?: boolean;
}

export interface CassandraWaitOptions<T> extends CqlOptions {
    /** Milliseconds to wait (default: the config's `timeout`, else 10000). */
    timeout?: number;
    /** How many rows to wait for (default: 1). */
    count?: number;
    /** Keep waiting until the rows also pass this check. */
    until?: (rows: T[]) => boolean;
}

export interface CassandraWaitForRowOptions<T> extends CqlOptions {
    timeout?: number;
    /** Keep waiting until the first row also passes this check (e.g. `(r) => r.status === 'shipped'`). */
    until?: (row: T) => boolean;
}

export interface CassandraKeyspaceOptions extends KeepOption {
    /** Replication (default: the config's `replication`, else NetworkTopologyStrategy with factor 1). */
    replication?: Record<string, string | number>;
}

/** A table's primary key. */
export interface CassandraPrimaryKey {
    partitionKeys: string[];
    clusteringKeys: string[];
}

export interface CassandraClient {
    /** Runs a SELECT (or any statement) and returns every row, as plain objects. */
    query<T extends CassandraRow = CassandraRow>(cql: string, params?: CqlParams, options?: CqlOptions): Promise<T[]>;
    /** Runs a statement. `applied` is false when a lightweight transaction's condition didn't hold. Not undone. */
    execute(cql: string, params?: CqlParams, options?: CqlOptions): Promise<{ applied: boolean }>;
    /** Runs statements in one logged batch (unlogged with `{ logged: false }`). Not undone. */
    batch(statements: Array<{ cql: string; params?: CqlParams }>, options?: Omit<CqlOptions, 'raw' | 'fetchSize'> & { logged?: boolean }): Promise<{ applied: boolean }>;
    /**
     * Inserts one row or many and undoes them after the test: a new row is
     * deleted, an existing one gets its previous values back. Every row needs
     * its whole primary key. Returns how many were applied.
     */
    insert(table: string, rows: CassandraRow | CassandraRow[], options?: CassandraInsertOptions): Promise<{ applied: number }>;
    /** Polls a query until it returns `count` rows (default 1) and they pass `until`. Throws on timeout with what was there. */
    waitForRows<T extends CassandraRow = CassandraRow>(cql: string, params?: CqlParams, options?: CassandraWaitOptions<T>): Promise<T[]>;
    /** Polls until the query returns a row (passing `until`), and returns it. */
    waitForRow<T extends CassandraRow = CassandraRow>(cql: string, params?: CqlParams, options?: CassandraWaitForRowOptions<T>): Promise<T>;
    /**
     * Creates a keyspace (default name: one of this test's own, e.g.
     * `propmaster_t0_9f2a1c0b`) and returns its name. Dropped after the test
     * unless `{ keep: true }` or it already existed.
     */
    createKeyspace(name?: string, options?: CassandraKeyspaceOptions): Promise<string>;
    /** Makes a keyspace the default for unqualified table names. */
    useKeyspace(name: string): Promise<void>;
    /** Drops a keyspace (not undone). */
    dropKeyspace(name: string): Promise<void>;
    /** The partition and clustering key columns of a table (`table` or `keyspace.table`). */
    primaryKey(table: string): Promise<CassandraPrimaryKey>;
    /** The keyspace unqualified names resolve against, if any. */
    readonly keyspace: string | undefined;
    /** The driver client, for anything else (prepared statement options, metadata, paging). */
    readonly driver: DriverClient;
    close(): Promise<void>;
}

export interface CreateCassandraClientOptions {
    /** Undo stack for inserts and keyspaces; without one nothing is cleaned up. */
    registry?: CleanupRegistry;
    /** Run ID in the default keyspace name of createKeyspace() (default: a new one). */
    runId?: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A plain identifier, lowercased as Cassandra folds unquoted names. Throws for anything else. */
export function identifier(name: string, what: string): string {
    if (!IDENTIFIER.test(name)) {
        throw new Error(`"${name}" isn't a plain ${what} name (letters, digits and _, starting with a letter or _); use execute() for anything else`);
    }
    return name.toLowerCase();
}

/** `ks.table` or `table` (in the session keyspace) → both parts, lowercased. */
export function splitTable(table: string, keyspace: string | undefined): { keyspace: string; table: string } {
    const parts = table.split('.');
    if (parts.length > 2) throw new Error(`"${table}" isn't a table name: use table or keyspace.table`);
    const name = identifier(parts[parts.length - 1], 'table');
    const ks = parts.length === 2 ? identifier(parts[0], 'keyspace') : keyspace;
    if (!ks) throw new Error(`"${table}" has no keyspace: write keyspace.${name}, or set cassandra.keyspace (PW_CASSANDRA_KEYSPACE) or call useKeyspace()`);
    return { keyspace: ks, table: name };
}

/** The keyspace name for a run ID: `propmaster_t0_9f2a1c0b`. */
export function testKeyspaceName(runId: string): string {
    return `propmaster_${runId.replace(/[^A-Za-z0-9_]/g, '_')}`.toLowerCase().slice(0, 48);
}

/** The replication map in CQL: `{'class': 'NetworkTopologyStrategy', 'replication_factor': 1}`. */
export function replicationCql(replication: Record<string, string | number>): string {
    const entries = Object.entries(replication);
    if (!entries.some(([k]) => k === 'class')) throw new Error('replication needs a class, e.g. { class: \'NetworkTopologyStrategy\', datacenter1: 3 }');
    return `{${entries.map(([k, v]) => {
        if (!/^[A-Za-z0-9_.]+$/.test(k) || !/^[A-Za-z0-9_.]+$/.test(String(v))) throw new Error(`replication ${k}: ${String(v)} has characters CQL doesn't allow here`);
        return `'${k}': ${typeof v === 'number' ? v : `'${v}'`}`;
    }).join(', ')}}`;
}

/** The INSERT for one row, with a `?` per column. */
export function buildCqlInsert(keyspace: string, table: string, row: CassandraRow, options: Pick<CassandraInsertOptions, 'ttl' | 'ifNotExists'> = {}): { cql: string; params: unknown[] } {
    const columns = Object.keys(row).filter((c) => row[c] !== undefined);
    if (!columns.length) throw new Error('the row has no columns');
    const names = columns.map((c) => identifier(c, 'column'));
    if (options.ttl !== undefined && (!Number.isInteger(options.ttl) || options.ttl <= 0)) throw new Error(`ttl must be a whole number of seconds above 0, not ${options.ttl}`);
    const cql = `INSERT INTO ${keyspace}.${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
        + `${options.ifNotExists ? ' IF NOT EXISTS' : ''}${options.ttl ? ` USING TTL ${options.ttl}` : ''}`;
    return { cql, params: columns.map((c) => row[c]) };
}

/** The WHERE clause and values that pick one row by its primary key. */
export function keyWhere(row: CassandraRow, key: CassandraPrimaryKey, table: string): { where: string; params: unknown[] } {
    const columns = [...key.partitionKeys, ...key.clusteringKeys];
    const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
    const missing = columns.filter((c) => lower[c] === undefined || lower[c] === null);
    if (missing.length) throw new Error(`the row has no ${missing.join(', ')}, part of the primary key of ${table} (${columns.join(', ')})`);
    return { where: columns.map((c) => `${c} = ?`).join(' AND '), params: columns.map((c) => lower[c]) };
}

/**
 * A driver value as a plain one: Uuid, TimeUuid, InetAddress, LocalDate,
 * LocalTime, BigDecimal and Duration as strings; Long and Integer (varint) as
 * numbers, or bigint beyond Number.MAX_SAFE_INTEGER; Tuple as an array; maps,
 * sets and lists inside out. Buffers and Dates stay as they are.
 */
export function toPlainValue(value: unknown): unknown {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    if (typeof value !== 'object') return value;
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(toPlainValue);
    if (value instanceof Map) return new Map([...value].map(([k, v]) => [toPlainValue(k), toPlainValue(v)]));
    if (value instanceof Set) return [...value].map(toPlainValue);
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    switch (name) {
        case 'Long':
        case 'Integer': {
            const text = String(value);
            const n = Number(text);
            return Number.isSafeInteger(n) ? n : BigInt(text);
        }
        case 'Uuid':
        case 'TimeUuid':
        case 'InetAddress':
        case 'LocalDate':
        case 'LocalTime':
        case 'BigDecimal':
        case 'Duration':
            return String(value);
        case 'Tuple':
            return (value as { values(): unknown[] }).values().map(toPlainValue);
        case 'Row':
        case 'Object':
        case undefined:
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlainValue(v)]));
        default:
            return value;
    }
}

/**
 * Bound values as the driver takes them: a BigInt (as `query()` returns for
 * values beyond 2^53) becomes its decimal string, which the driver accepts
 * for bigint and varint columns. Inside lists, sets and maps too.
 */
export function toDriverParams(params: CqlParams | undefined): CqlParams | undefined {
    const convert = (v: unknown): unknown => {
        if (typeof v === 'bigint') return v.toString();
        if (Array.isArray(v)) return v.map(convert);
        if (v instanceof Map) return new Map([...v].map(([k, x]) => [convert(k), convert(x)]));
        if (v instanceof Set) return new Set([...v].map(convert));
        if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x)]));
        }
        return v;
    };
    return params === undefined ? undefined : (convert(params) as CqlParams);
}

/** Short JSON for messages. */
export function previewRows(value: unknown, max = 300): string {
    const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A driver error as one readable line. */
export function cassandraReason(error: unknown): string {
    const e = error as { name?: string; message?: string; innerErrors?: Record<string, { message?: string } | undefined> } | null;
    if (!e) return String(error);
    if (e.name === 'NoHostAvailableError' && e.innerErrors && Object.keys(e.innerErrors).length) {
        return `no node answered: ${Object.entries(e.innerErrors).map(([host, inner]) => `${host} (${inner?.message ?? 'no reason'})`).join('; ')}`;
    }
    return e.message ?? String(error);
}

const contactPointsOf = (config: CassandraFixtureConfig): string[] => {
    const points = config.contactPoints?.length ? config.contactPoints : ['localhost'];
    const port = config.port ?? DEFAULT_CASSANDRA_PORT;
    return points.map((p) => (/:\d+$/.test(p) && !p.startsWith('[') ? p : `${p}:${port}`));
};

/**
 * Shuts down a client whose connect() failed. The driver leaves the control
 * connection's first socket open when the node isn't in `localDataCenter`
 * (cassandra-driver 4.x), which would keep the test process alive.
 */
async function closeFailedClient(driver: DriverClient): Promise<void> {
    await driver.shutdown().catch(() => undefined);
    const control = (driver as unknown as { controlConnection?: { connection?: { close(cb?: () => void): void } | null } }).controlConnection;
    const connection = control?.connection;
    if (connection) await new Promise<void>((resolve) => connection.close(() => resolve()));
}

/** Connects, creating `keyspace` first when `createKeyspace` is set. */
export async function createCassandraClient(config: CassandraFixtureConfig, options: CreateCassandraClientOptions = {}): Promise<CassandraClient> {
    const { registry } = options;
    const mod = await loadOptional<Driver & { default?: Driver }>('cassandra-driver', 'cassandraClient');
    const cassandra = (mod.default ?? mod) as Driver;
    const contactPoints = contactPointsOf(config);
    const localDataCenter = config.localDataCenter ?? DEFAULT_CASSANDRA_DATA_CENTER;
    const consistencyOf = (name: CqlOptions['consistency'] | undefined): DriverTypes.consistencies | undefined => {
        if (!name) return undefined;
        const level = (cassandra.types.consistencies as unknown as Record<string, DriverTypes.consistencies>)[name];
        if (level === undefined) throw new Error(`unknown consistency "${name}"; use one of ${Object.keys(cassandra.types.consistencies).filter((k) => Number.isNaN(Number(k))).join(', ')}`);
        return level;
    };
    let configured: string | undefined;
    try {
        configured = config.keyspace ? identifier(config.keyspace, 'keyspace') : undefined;
    } catch (error) {
        throw new FixtureInitError('cassandra', 'connect', { reason: (error as Error).message });
    }

    const driver = new cassandra.Client({
        contactPoints,
        localDataCenter,
        ...(config.username ? { credentials: { username: config.username, password: config.password ?? '' } } : {}),
        socketOptions: {
            connectTimeout: config.connectTimeout ?? 10_000,
            ...(config.requestTimeout ? { readTimeout: config.requestTimeout } : {}),
        },
        queryOptions: {
            prepare: true,
            ...(config.consistency ? { consistency: consistencyOf(config.consistency) } : {}),
        },
    });
    try {
        await driver.connect();
    } catch (error) {
        await closeFailedClient(driver);
        throw new FixtureInitError('cassandra', 'connect', { contactPoints: contactPoints.join(','), localDataCenter, reason: cassandraReason(error) }, error instanceof Error ? error : undefined);
    }

    const replicationDefault = config.replication ?? DEFAULT_REPLICATION;
    const runId = options.runId ?? newRunId();
    const timeoutDefault = config.timeout ?? DEFAULT_CASSANDRA_TIMEOUT;
    const track = (o?: KeepOption) => registry !== undefined && registry.autoCleanup && !o?.keep;
    let sessionKeyspace: string | undefined;
    // Keyspaces this client created: dropped whole after the test, so their rows need no undo.
    const ownKeyspaces = new Set<string>();
    const keys = new Map<string, Promise<CassandraPrimaryKey>>();

    const fail = (operation: FixtureOperationError['operation'], details: Record<string, unknown>, error: unknown): never => {
        if (error instanceof FixtureOperationError) throw error;
        throw new FixtureOperationError('cassandra', operation, { ...details, reason: cassandraReason(error) }, error instanceof Error ? error : undefined);
    };

    const execOptions = (o: Omit<CqlOptions, 'raw'> = {}) => ({
        prepare: true,
        ...(o.consistency ? { consistency: consistencyOf(o.consistency) } : {}),
        ...(o.fetchSize ? { fetchSize: o.fetchSize } : {}),
    });

    const readAll = async (cql: string, params: CqlParams | undefined, o: CqlOptions = {}): Promise<CassandraRow[]> => {
        const rows: CassandraRow[] = [];
        let pageState: string | undefined;
        do {
            const result = await driver.execute(cql, toDriverParams(params) as never, { ...execOptions(o), ...(pageState ? { pageState } : {}) });
            for (const row of result.rows ?? []) {
                const plain: CassandraRow = {};
                for (const column of row.keys()) plain[column] = o.raw ? row.get(column) : toPlainValue(row.get(column));
                rows.push(plain);
            }
            pageState = result.pageState ?? undefined;
        } while (pageState);
        return rows;
    };

    const primaryKey = (ks: string, table: string): Promise<CassandraPrimaryKey> => {
        const id = `${ks}.${table}`;
        let known = keys.get(id);
        if (!known) {
            known = driver.metadata.getTable(ks, table).then((meta) => {
                if (!meta) throw new Error(`table ${id} doesn't exist`);
                return { partitionKeys: meta.partitionKeys.map((c) => c.name), clusteringKeys: meta.clusteringKeys.map((c) => c.name) };
            });
            known.catch(() => keys.delete(id));
            keys.set(id, known);
        }
        return known;
    };

    const keyspaceExists = async (name: string) => {
        await driver.metadata.refreshKeyspace(name).catch(() => undefined);
        return Boolean(driver.metadata.keyspaces[name]);
    };

    const createKeyspace = async (name: string, replication: Record<string, string | number>) => {
        await driver.execute(`CREATE KEYSPACE IF NOT EXISTS ${name} WITH replication = ${replicationCql(replication)}`);
    };

    const client: CassandraClient = {
        driver,
        get keyspace() {
            return sessionKeyspace;
        },

        async query<T extends CassandraRow>(cql: string, params?: CqlParams, o?: CqlOptions) {
            try {
                return (await readAll(cql, params, o)) as T[];
            } catch (error) {
                return fail('query', { cql, ...(params ? { params: previewRows(params, 200) } : {}) }, error);
            }
        },

        async execute(cql, params, o) {
            try {
                const result = await driver.execute(cql, toDriverParams(params) as never, execOptions(o));
                return { applied: result.wasApplied() };
            } catch (error) {
                return fail('execute', { cql, ...(params ? { params: previewRows(params, 200) } : {}) }, error);
            }
        },

        async batch(statements, o = {}) {
            try {
                const result = await driver.batch(
                    statements.map((s) => ({ query: s.cql, params: toDriverParams(s.params) as never })),
                    { ...execOptions(o), logged: o.logged ?? true },
                );
                return { applied: result.wasApplied() };
            } catch (error) {
                return fail('batch', { statements: statements.length, first: statements[0]?.cql }, error);
            }
        },

        async insert(table, rows, o = {}) {
            const list = Array.isArray(rows) ? rows : [rows];
            let applied = 0;
            let details: Record<string, unknown> = { table };
            try {
                const { keyspace: ks, table: name } = splitTable(table, sessionKeyspace);
                const undo = track(o) && !ownKeyspaces.has(ks);
                const key = undo ? await primaryKey(ks, name) : undefined;
                for (const row of list) {
                    const { cql, params } = buildCqlInsert(ks, name, row, o);
                    details = { table: `${ks}.${name}`, cql, row: previewRows(row, 200) };
                    if (undo) {
                        // Remember what's there so the row can be put back as it was.
                        const { where, params: keyParams } = keyWhere(row, key!, `${ks}.${name}`);
                        const before = await driver.execute(`SELECT JSON * FROM ${ks}.${name} WHERE ${where}`, toDriverParams(keyParams) as never, { prepare: true });
                        const previous = before.rows[0]?.get('[json]') as string | undefined;
                        const result = await driver.execute(cql, toDriverParams(params) as never, execOptions());
                        if (!result.wasApplied()) continue;
                        applied++;
                        registry!.add(`cassandra ${previous ? 'restore ' : ''}${ks}.${name} ${previewRows(Object.fromEntries(keyParams.map((v, i) => [[...key!.partitionKeys, ...key!.clusteringKeys][i], v])), 120)}`, async () => {
                            if (previous) await driver.execute(`INSERT INTO ${ks}.${name} JSON ?`, [previous], { prepare: true });
                            else await driver.execute(`DELETE FROM ${ks}.${name} WHERE ${where}`, toDriverParams(keyParams) as never, { prepare: true });
                        });
                    } else {
                        const result = await driver.execute(cql, toDriverParams(params) as never, execOptions());
                        if (result.wasApplied()) applied++;
                    }
                }
                return { applied };
            } catch (error) {
                return fail('insert', details, error);
            }
        },

        async waitForRows<T extends CassandraRow>(cql: string, params?: CqlParams, o: CassandraWaitOptions<T> = {}) {
            const timeout = o.timeout ?? timeoutDefault;
            const wanted = o.count ?? 1;
            const deadline = Date.now() + timeout;
            let rows: T[] = [];
            for (;;) {
                try {
                    rows = (await readAll(cql, params, o)) as T[];
                } catch (error) {
                    return fail('waitForRows', { cql }, error);
                }
                if (rows.length >= wanted && (!o.until || o.until(rows))) return rows;
                if (Date.now() >= deadline) break;
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(deadline - Date.now(), 0))));
            }
            const what = rows.length < wanted ? `${wanted} row(s), found ${rows.length}` : `rows that pass the check, found ${rows.length} that don't`;
            return fail('waitForRows', { cql, ...(params ? { params: previewRows(params, 200) } : {}), timeout }, new Error(
                `waited ${timeout} ms for ${what}${rows.length ? `: ${previewRows(rows.slice(0, 5))}` : ''}`,
            ));
        },

        async waitForRow<T extends CassandraRow>(cql: string, params?: CqlParams, o: CassandraWaitForRowOptions<T> = {}) {
            const { until, ...rest } = o;
            const [row] = await client.waitForRows<T>(cql, params, { ...rest, count: 1, ...(until ? { until: (rows: T[]) => until(rows[0]) } : {}) });
            return row;
        },

        async createKeyspace(name, o = {}) {
            let ks = '';
            try {
                ks = name ? identifier(name, 'keyspace') : testKeyspaceName(runId);
                if (await keyspaceExists(ks)) return ks;
                await createKeyspace(ks, o.replication ?? replicationDefault);
            } catch (error) {
                return fail('createKeyspace', { keyspace: ks || name }, error);
            }
            if (track(o)) {
                ownKeyspaces.add(ks);
                registry!.add(`cassandra keyspace ${ks}`, async () => {
                    for (const id of keys.keys()) if (id.startsWith(`${ks}.`)) keys.delete(id);
                    await driver.execute(`DROP KEYSPACE IF EXISTS ${ks}`);
                });
            }
            return ks;
        },

        async useKeyspace(name) {
            try {
                const ks = identifier(name, 'keyspace');
                await driver.execute(`USE ${ks}`);
                sessionKeyspace = ks;
            } catch (error) {
                return fail('execute', { keyspace: name }, error);
            }
        },

        async dropKeyspace(name) {
            try {
                const ks = identifier(name, 'keyspace');
                for (const id of keys.keys()) if (id.startsWith(`${ks}.`)) keys.delete(id);
                await driver.execute(`DROP KEYSPACE IF EXISTS ${ks}`);
                if (sessionKeyspace === ks) sessionKeyspace = undefined;
            } catch (error) {
                return fail('execute', { keyspace: name }, error);
            }
        },

        async primaryKey(table) {
            try {
                const { keyspace: ks, table: name } = splitTable(table, sessionKeyspace);
                return await primaryKey(ks, name);
            } catch (error) {
                return fail('query', { table }, error);
            }
        },

        async close() {
            await driver.shutdown();
        },
    };

    if (configured) {
        try {
            if (config.createKeyspace && !(await keyspaceExists(configured))) await createKeyspace(configured, replicationDefault);
            await driver.execute(`USE ${configured}`);
            sessionKeyspace = configured;
        } catch (error) {
            await driver.shutdown().catch(() => undefined);
            const reason = cassandraReason(error);
            throw new FixtureInitError('cassandra', 'connect', {
                contactPoints: contactPoints.join(','),
                keyspace: configured,
                reason: /keyspace/i.test(reason) && !config.createKeyspace ? `${reason} (set createKeyspace: true or PW_CASSANDRA_CREATE_KEYSPACE=true to create it)` : reason,
            }, error instanceof Error ? error : undefined);
        }
    }
    return client;
}

/** The Cassandra config: the project option, else ConfigLoader (environments.json, .env, PW_CASSANDRA_*), else localhost. */
export async function resolveCassandraConfig(cassandra: CassandraFixtureConfig | undefined): Promise<CassandraFixtureConfig> {
    if (cassandra) return cassandra;
    const { ConfigLoader } = await import('../config/loader.js');
    try {
        return new ConfigLoader().load().cassandra ?? {};
    } catch {
        return {};
    }
}

/**
 * Fixture definition for test.extend(). The undo actions run before the
 * driver shuts down.
 */
export const cassandraFixture = {
    cassandraClient: async (
        { cassandra, stagehandContainers, dataCleanup }: { cassandra: CassandraFixtureConfig | undefined; stagehandContainers: ContainerManager; dataCleanup: CleanupRegistry },
        use: (client: CassandraClient) => Promise<void>,
        testInfo: { workerIndex: number },
    ) => {
        const config = await stagehandContainers.cassandra(await resolveCassandraConfig(cassandra));
        const client = await createCassandraClient(config, { registry: dataCleanup, runId: newRunId(testInfo.workerIndex) });
        let cleanupError: unknown;
        try {
            await use(client);
            await dataCleanup.flush();
        } catch (error) {
            cleanupError = error;
        }
        await client.close();
        if (cleanupError) throw cleanupError;
    },
};
