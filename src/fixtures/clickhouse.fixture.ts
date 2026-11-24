/**
 * ClickHouse fixture.
 *
 * `clickHouseClient` runs SQL against ClickHouse over its HTTP interface, in
 * the same shape as `databaseClient` and `cassandraClient`:
 *
 * - `query()` returns rows as plain objects. 64-bit (and wider) integers come
 *   back as numbers, or as bigint beyond 2^53 (never rounded), so `count()`
 *   compares with `toBe(3)`.
 * - `execute()` runs anything else (DDL, `ALTER`, `INSERT ... SELECT`) and
 *   reports how many rows it wrote.
 * - `insert()` writes rows (JSONEachRow) and deletes them after the test, by
 *   `key`, else `id`, else every column the row sets.
 * - `waitForRows()` polls until the application has written what the test
 *   expects (ClickHouse pipelines are often asynchronous), and fails with
 *   what is there instead.
 * - `createDatabase()` makes a database of the test's own, dropped afterwards;
 *   `createDatabase: true` in the config creates the configured one when it's
 *   missing (local runs, containers).
 *
 * Values are always bound as typed parameters (`{name:Type}`), never built
 * from strings. Uses @clickhouse/client, an optional peer dependency loaded
 * on first use.
 */

import type { ClickHouseClient as DriverClient } from '@clickhouse/client';
import type { ClickHouseFixtureConfig } from '../config/schema.js';
import type { ContainerManager } from '../containers/container-manager.js';
import { FixtureInitError, FixtureOperationError } from '../errors.js';
import type { CleanupRegistry, KeepOption } from '../test-data/registry.js';
import { newRunId } from '../test-data/factory.js';
import { loadOptional } from './optional-package.js';

type Driver = typeof import('@clickhouse/client');

export const DEFAULT_CLICKHOUSE_URL = 'http://localhost:8123';
export const DEFAULT_CLICKHOUSE_DATABASE = 'default';
export const DEFAULT_CLICKHOUSE_TIMEOUT = 10_000;

/** Values for `{name:Type}` placeholders, by name. */
export type ClickHouseParams = Record<string, unknown>;

export type ClickHouseRow = Record<string, unknown>;

export interface ClickHouseQueryOptions {
    /** ClickHouse settings for this statement, e.g. `{ final: 1 }` (on top of the config's). */
    settings?: Record<string, unknown>;
    /** Values exactly as ClickHouse's JSON gives them, with the server's own settings (64-bit integers as strings or numbers). */
    raw?: boolean;
}

export interface ClickHouseInsertOptions extends KeepOption {
    /**
     * Columns that pick out the inserted rows when they're deleted after the
     * test (default: `id` when the row has one, else every column the row sets
     * that can be compared).
     */
    key?: string | string[];
    /** ClickHouse settings for this insert, e.g. `{ async_insert: 1 }`. */
    settings?: Record<string, unknown>;
}

export interface ClickHouseWaitOptions<T> extends ClickHouseQueryOptions {
    /** Milliseconds to wait (default: the config's `timeout`, else 10000). */
    timeout?: number;
    /** How many rows to wait for (default: 1). */
    count?: number;
    /** Keep waiting until the rows also pass this check. */
    until?: (rows: T[]) => boolean;
}

export interface ClickHouseWaitForRowOptions<T> extends ClickHouseQueryOptions {
    timeout?: number;
    /** Keep waiting until the first row also passes this check (e.g. `(r) => r.status === 'shipped'`). */
    until?: (row: T) => boolean;
}

export interface ClickHouseColumn {
    name: string;
    type: string;
}

export interface ClickHouseClient {
    /** Runs a SELECT (or SHOW, DESCRIBE, EXPLAIN) and returns every row, as plain objects. */
    query<T extends ClickHouseRow = ClickHouseRow>(sql: string, params?: ClickHouseParams, options?: ClickHouseQueryOptions): Promise<T[]>;
    /** Runs a statement that returns no rows (DDL, ALTER, INSERT ... SELECT). Not undone. */
    execute(sql: string, params?: ClickHouseParams, options?: Omit<ClickHouseQueryOptions, 'raw'>): Promise<{ writtenRows: number }>;
    /**
     * Inserts one row or many and deletes them after the test (by `key`, else
     * `id`, else every column the row sets). Returns how many were written.
     */
    insert(table: string, rows: ClickHouseRow | ClickHouseRow[], options?: ClickHouseInsertOptions): Promise<{ inserted: number }>;
    /** Polls a query until it returns `count` rows (default 1) and they pass `until`. Throws on timeout with what was there. */
    waitForRows<T extends ClickHouseRow = ClickHouseRow>(sql: string, params?: ClickHouseParams, options?: ClickHouseWaitOptions<T>): Promise<T[]>;
    /** Polls until the query returns a row (passing `until`), and returns it. */
    waitForRow<T extends ClickHouseRow = ClickHouseRow>(sql: string, params?: ClickHouseParams, options?: ClickHouseWaitForRowOptions<T>): Promise<T>;
    /** Rows in a table (`table` or `database.table`), optionally only those matching `where` (column → value). */
    count(table: string, where?: ClickHouseRow): Promise<number>;
    /**
     * Creates a database (default name: one of this test's own, e.g.
     * `propmaster_t0_9f2a1c0b`) and returns its name. Dropped after the test
     * unless `{ keep: true }` or it already existed.
     */
    createDatabase(name?: string, options?: KeepOption): Promise<string>;
    /** Drops a database (not undone). */
    dropDatabase(name: string): Promise<void>;
    /** A table's columns and their ClickHouse types. */
    columns(table: string): Promise<ClickHouseColumn[]>;
    /** The database unqualified table names resolve against. */
    readonly database: string;
    /** The @clickhouse/client client, for anything else (streaming, other formats, exec). */
    readonly driver: DriverClient;
    close(): Promise<void>;
}

export interface CreateClickHouseClientOptions {
    /** Undo stack for inserts and databases; without one nothing is cleaned up. */
    registry?: CleanupRegistry;
    /** Run ID in the default database name of createDatabase() (default: a new one). */
    runId?: string;
}

interface TableInfo {
    columns: ClickHouseColumn[];
    engine: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A plain identifier (ClickHouse names are case-sensitive, so it's kept as written). Throws for anything else. */
export function identifier(name: string, what: string): string {
    if (!IDENTIFIER.test(name)) {
        throw new Error(`"${name}" isn't a plain ${what} name (letters, digits and _, starting with a letter or _); use execute() for anything else`);
    }
    return name;
}

/** `db.table` or `table` (in the configured database) → both parts. */
export function splitTable(table: string, database: string): { database: string; table: string } {
    const parts = table.split('.');
    if (parts.length > 2) throw new Error(`"${table}" isn't a table name: use table or database.table`);
    return {
        database: parts.length === 2 ? identifier(parts[0], 'database') : database,
        table: identifier(parts[parts.length - 1], 'table'),
    };
}

/** The database name for a run ID: `propmaster_t0_9f2a1c0b`. */
export function testDatabaseName(runId: string): string {
    return `propmaster_${runId.replace(/[^A-Za-z0-9_]/g, '_')}`.toLowerCase().slice(0, 64);
}

/** The type inside `Nullable(...)` and `LowCardinality(...)`. */
function innerType(type: string): string {
    let t = type.trim();
    for (;;) {
        const m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(t);
        if (!m) return t;
        t = m[1].trim();
    }
}

const WIDE_INTEGER = /^U?Int(64|128|256)$/;

/** A quoted 64-bit (or wider) integer as a number, or a bigint beyond 2^53. */
function toInteger(value: unknown): unknown {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return value;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : BigInt(value);
}

/**
 * A value from ClickHouse's JSON output as a plain one, given its column type:
 * Int64/UInt64/Int128/UInt128/Int256/UInt256 (quoted by ClickHouse) as
 * numbers, or bigint beyond Number.MAX_SAFE_INTEGER, also inside Array(...)
 * and Map(..., ...). Everything else stays as ClickHouse gives it (dates and
 * DateTimes as strings, Decimals as numbers).
 */
export function toPlainValue(value: unknown, type: string): unknown {
    if (value === null || value === undefined) return value ?? null;
    const t = innerType(type);
    if (WIDE_INTEGER.test(t)) return toInteger(value);
    const array = /^Array\((.*)\)$/.exec(t);
    if (array && Array.isArray(value)) return value.map((v) => toPlainValue(v, array[1]));
    const map = /^Map\((.*)\)$/.exec(t);
    if (map && value && typeof value === 'object' && !Array.isArray(value)) {
        const valueType = splitTopLevel(map[1])[1];
        if (valueType) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlainValue(v, valueType)]));
    }
    return value;
}

/** `String, Array(Tuple(UInt8, String))` → its two top-level parts. */
function splitTopLevel(types: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < types.length; i++) {
        const c = types[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
            out.push(types.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(types.slice(start).trim());
    return out;
}

/** Column types that can be matched with `=` on a bound parameter (no Map, JSON, Object, Dynamic, Variant, AggregateFunction, Nested). */
export function comparableType(type: string): boolean {
    return !/(^|\()\s*(Map|JSON|Object|Dynamic|Variant|AggregateFunction|SimpleAggregateFunction|Nested|Nothing)\b/.test(type)
        && !/^(Float32|Float64|BFloat16)$/.test(innerType(type));
}

/** The WHERE clause and parameters that pick rows by `columns`, typed from `types`. A null matches `IS NULL`. */
export function buildWhere(row: ClickHouseRow, columns: string[], types: Map<string, string>, table: string, prefix = 'k'): { where: string; params: ClickHouseParams } {
    if (!columns.length) throw new Error(`no column of ${table} can pick out the row: pass { key: [...] }, or { keep: true } to leave it`);
    const params: ClickHouseParams = {};
    const parts = columns.map((column, i) => {
        const type = types.get(column);
        if (!type) throw new Error(`${table} has no column ${column}`);
        const value = row[column];
        if (value === null || value === undefined) return `${column} IS NULL`;
        params[`${prefix}${i}`] = value;
        return `${column} = {${prefix}${i}:${innerType(type)}}`;
    });
    return { where: parts.join(' AND '), params };
}

/** Which columns identify inserted rows: `key`, else `id` when the row has it, else every comparable column the row sets. */
export function undoKey(row: ClickHouseRow, key: string | string[] | undefined, types: Map<string, string>): string[] {
    if (key !== undefined) return (Array.isArray(key) ? key : [key]).map((c) => identifier(c, 'column'));
    if (row.id !== undefined && row.id !== null && types.has('id')) return ['id'];
    return Object.keys(row).filter((c) => row[c] !== undefined && types.has(c) && comparableType(types.get(c)!));
}

/**
 * How rows inserted into a table with this engine are undone: `delete` for
 * the MergeTree family and Memory, `none` for Null (it keeps nothing), else
 * the reason they can't be (Log, TinyLog, StripeLog, Distributed, ...).
 */
export function undoMode(engine: string): 'delete' | 'none' | { unsupported: string } {
    if (/MergeTree$/.test(engine) || engine === 'Memory') return 'delete';
    if (engine === 'Null') return 'none';
    return { unsupported: `engine ${engine || 'unknown'} can't delete rows, so insert() couldn't undo them: pass { keep: true }, or use a table in a database of the test's own (createDatabase())` };
}

/** A URL's user info taken out (the driver warns about it, and it mustn't reach messages): `http://u:p@h:8123` → `http://h:8123`, u, p. */
export function splitCredentials(raw: string): { url: string; username?: string; password?: string } {
    try {
        const u = new URL(raw);
        if (!u.username && !u.password) return { url: raw };
        const username = u.username ? decodeURIComponent(u.username) : undefined;
        const password = u.password ? decodeURIComponent(u.password) : undefined;
        u.username = '';
        u.password = '';
        return { url: u.toString().replace(/\/$/, raw.endsWith('/') ? '/' : ''), username, password };
    } catch {
        return { url: raw.replace(/\/\/[^@/]*@/, '//') };
    }
}

/** Short JSON for messages. */
export function previewRows(value: unknown, max = 300): string {
    const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A driver error as one readable line: ClickHouse's message without its stack, or why the connection failed. */
export function clickHouseReason(error: unknown): string {
    const e = error as { message?: string; code?: string; type?: string; errors?: Array<{ message?: string }> } | null;
    if (!e) return String(error);
    // A host name with several addresses (localhost: ::1 and 127.0.0.1) fails with an AggregateError and no message of its own.
    const inner = Array.isArray(e.errors) ? e.errors.map((x) => x?.message).filter(Boolean).join('; ') : '';
    const message = (String(e.message || inner || error)).replace(/\s*Stack trace:[\s\S]*$/, '').trim();
    if (e.type && !message.includes(e.type)) return `${message} (${e.type})`;
    if (!e.type && e.code && /^E[A-Z]+$/.test(e.code) && !message.includes(e.code)) return `${message} (${e.code})`;
    return message;
}

/** BigInt values as decimal strings inside rows (JSON.stringify can't write BigInt; ClickHouse parses the strings). */
function jsonSafe(row: ClickHouseRow): ClickHouseRow {
    const convert = (v: unknown): unknown => {
        if (typeof v === 'bigint') return v.toString();
        if (Array.isArray(v)) return v.map(convert);
        if (v instanceof Date) return v;
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x)]));
        return v;
    };
    return convert(row) as ClickHouseRow;
}

/** Connects (and pings), creating `database` first when `createDatabase` is set. */
export async function createClickHouseClient(config: ClickHouseFixtureConfig, options: CreateClickHouseClientOptions = {}): Promise<ClickHouseClient> {
    const { registry } = options;
    const mod = await loadOptional<Driver & { default?: Driver }>('@clickhouse/client', 'clickHouseClient');
    const clickhouse = ((mod as { createClient?: unknown }).createClient ? mod : mod.default!) as Driver;
    const { url, username: urlUser, password: urlPassword } = splitCredentials(config.url || DEFAULT_CLICKHOUSE_URL);
    let database: string;
    try {
        database = identifier(config.database || DEFAULT_CLICKHOUSE_DATABASE, 'database');
    } catch (error) {
        throw new FixtureInitError('clickhouse', 'connect', { url, reason: (error as Error).message });
    }
    const where = { url, database };
    const make = (db: string) => clickhouse.createClient({
        url,
        username: config.username || urlUser || 'default',
        password: config.password ?? urlPassword ?? '',
        database: db,
        application: 'propmaster',
        // Failures reach the test as FixtureOperationError; the driver's own error log would repeat them.
        log: { level: clickhouse.ClickHouseLogLevel.OFF },
        ...(config.requestTimeout ? { request_timeout: config.requestTimeout } : {}),
        clickhouse_settings: { date_time_input_format: 'best_effort', ...(config.settings ?? {}) } as never,
    });

    if (config.createDatabase && database !== DEFAULT_CLICKHOUSE_DATABASE) {
        // The database doesn't exist yet, so this one connection uses `default`.
        const bootstrap = make(DEFAULT_CLICKHOUSE_DATABASE);
        try {
            await bootstrap.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
        } catch (error) {
            throw new FixtureInitError('clickhouse', 'connect', { ...where, reason: clickHouseReason(error) }, error instanceof Error ? error : undefined);
        } finally {
            await bootstrap.close().catch(() => undefined);
        }
    }

    const driver = make(database);
    try {
        // ping() only checks /ping; a query also checks the credentials and the database.
        await driver.query({ query: 'SELECT 1', format: 'JSON' }).then((r) => r.json());
    } catch (error) {
        await driver.close().catch(() => undefined);
        const reason = clickHouseReason(error);
        throw new FixtureInitError('clickhouse', 'connect', {
            ...where,
            reason: /UNKNOWN_DATABASE|does not exist/i.test(reason) && !config.createDatabase
                ? `${reason} (set createDatabase: true or PW_CLICKHOUSE_CREATE_DATABASE=true to create it)`
                : reason,
        }, error instanceof Error ? error : undefined);
    }

    const runId = options.runId ?? newRunId();
    const timeoutDefault = config.timeout ?? DEFAULT_CLICKHOUSE_TIMEOUT;
    const track = (o?: KeepOption) => registry !== undefined && registry.autoCleanup && !o?.keep;
    // Databases this client created: dropped whole after the test, so their rows need no undo.
    const ownDatabases = new Set<string>();
    const tableCache = new Map<string, Promise<TableInfo>>();

    const fail = (operation: FixtureOperationError['operation'], details: Record<string, unknown>, error: unknown): never => {
        if (error instanceof FixtureOperationError) throw error;
        throw new FixtureOperationError('clickhouse', operation, { ...details, reason: clickHouseReason(error) }, error instanceof Error ? error : undefined);
    };

    const readAll = async (sql: string, params: ClickHouseParams | undefined, o: ClickHouseQueryOptions = {}): Promise<ClickHouseRow[]> => {
        const result = await driver.query({
            query: sql,
            format: 'JSON',
            ...(params ? { query_params: params } : {}),
            // Quoted, so values beyond 2^53 arrive intact (newer servers default to bare numbers, which JSON.parse rounds).
            clickhouse_settings: { ...(o.raw ? {} : { output_format_json_quote_64bit_integers: 1 }), ...(o.settings ?? {}) } as never,
        });
        const json = await result.json<ClickHouseRow>();
        const rows = json.data ?? [];
        if (o.raw || !json.meta) return rows;
        const wide = json.meta.filter((m) => /U?Int(64|128|256)/.test(m.type));
        if (!wide.length) return rows;
        return rows.map((row) => {
            const plain = { ...row };
            for (const { name, type } of wide) if (name in plain) plain[name] = toPlainValue(plain[name], type);
            return plain;
        });
    };

    const tableInfo = (db: string, table: string): Promise<TableInfo> => {
        const id = `${db}.${table}`;
        let known = tableCache.get(id);
        if (!known) {
            known = Promise.all([
                readAll('SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {table:String} ORDER BY position', { db, table }),
                readAll('SELECT engine FROM system.tables WHERE database = {db:String} AND name = {table:String}', { db, table }),
            ]).then(([columns, [meta]]) => {
                if (!meta) throw new Error(`table ${id} doesn't exist`);
                return { columns: columns as unknown as ClickHouseColumn[], engine: String(meta.engine ?? '') };
            });
            known.catch(() => tableCache.delete(id));
            tableCache.set(id, known);
        }
        return known;
    };
    const columnsOf = async (db: string, table: string) => (await tableInfo(db, table)).columns;

    /** Lightweight DELETE where the engine has it (MergeTree), else a synchronous mutation. */
    const deleteWhere = async (db: string, table: string, whereSql: string, params: ClickHouseParams) => {
        try {
            await driver.command({ query: `DELETE FROM ${db}.${table} WHERE ${whereSql}`, query_params: params });
        } catch (error) {
            if (!/NOT_IMPLEMENTED|SUPPORT_IS_DISABLED|BAD_ARGUMENTS|lightweight/i.test(clickHouseReason(error))) throw error;
            await driver.command({ query: `ALTER TABLE ${db}.${table} DELETE WHERE ${whereSql}`, query_params: params, clickhouse_settings: { mutations_sync: '2' } as never });
        }
    };

    const dropDatabase = async (name: string) => {
        for (const id of tableCache.keys()) if (id.startsWith(`${name}.`)) tableCache.delete(id);
        await driver.command({ query: `DROP DATABASE IF EXISTS ${name}` });
    };

    const client: ClickHouseClient = {
        driver,
        database,

        async query<T extends ClickHouseRow>(sql: string, params?: ClickHouseParams, o?: ClickHouseQueryOptions) {
            try {
                return (await readAll(sql, params, o)) as T[];
            } catch (error) {
                return fail('query', { sql, ...(params ? { params: previewRows(params, 200) } : {}) }, error);
            }
        },

        async execute(sql, params, o = {}) {
            try {
                const result = await driver.command({
                    query: sql,
                    ...(params ? { query_params: params } : {}),
                    ...(o.settings ? { clickhouse_settings: o.settings as never } : {}),
                });
                // A table may have been dropped, recreated or altered: read its columns and engine afresh.
                if (/^\s*(CREATE|DROP|ALTER|RENAME|EXCHANGE|TRUNCATE)\b/i.test(sql)) tableCache.clear();
                return { writtenRows: Number(result.summary?.written_rows ?? 0) };
            } catch (error) {
                return fail('execute', { sql, ...(params ? { params: previewRows(params, 200) } : {}) }, error);
            }
        },

        async insert(table, rows, o = {}) {
            const list = Array.isArray(rows) ? rows : [rows];
            let details: Record<string, unknown> = { table };
            try {
                const { database: db, table: name } = splitTable(table, database);
                details = { table: `${db}.${name}`, rows: list.length, first: previewRows(list[0], 200) };
                if (!list.length) return { inserted: 0 };
                // Work out how to find the rows again before writing them, so a bad key fails before anything is written.
                const filters: Array<{ where: string; params: ClickHouseParams; label: string }> = [];
                const info = track(o) && !ownDatabases.has(db) ? await tableInfo(db, name) : undefined;
                const mode = info ? undoMode(info.engine) : 'none';
                if (typeof mode === 'object') throw new Error(`${db}.${name}: ${mode.unsupported}`);
                if (info && mode === 'delete') {
                    const types = new Map(info.columns.map((c) => [c.name, c.type]));
                    const seen = new Set<string>();
                    for (const row of list) {
                        const columns = undoKey(row, o.key, types);
                        const filter = buildWhere(row, columns, types, `${db}.${name}`);
                        const label = previewRows(Object.fromEntries(columns.map((c) => [c, row[c] ?? null])), 120);
                        if (seen.has(label)) continue;
                        seen.add(label);
                        filters.push({ ...filter, label });
                    }
                }
                const result = await driver.insert({
                    table: `${db}.${name}`,
                    values: list.map(jsonSafe),
                    format: 'JSONEachRow',
                    ...(o.settings ? { clickhouse_settings: o.settings as never } : {}),
                });
                for (const f of filters) {
                    registry!.add(`clickhouse ${db}.${name} ${f.label}`, () => deleteWhere(db, name, f.where, f.params));
                }
                const written = Number(result.summary?.written_rows ?? NaN);
                return { inserted: Number.isFinite(written) && written > 0 ? written : list.length };
            } catch (error) {
                return fail('insert', details, error);
            }
        },

        async waitForRows<T extends ClickHouseRow>(sql: string, params?: ClickHouseParams, o: ClickHouseWaitOptions<T> = {}) {
            const timeout = o.timeout ?? timeoutDefault;
            const wanted = o.count ?? 1;
            const deadline = Date.now() + timeout;
            let rows: T[] = [];
            for (;;) {
                try {
                    rows = (await readAll(sql, params, o)) as T[];
                } catch (error) {
                    return fail('waitForRows', { sql }, error);
                }
                if (rows.length >= wanted && (!o.until || o.until(rows))) return rows;
                if (Date.now() >= deadline) break;
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(deadline - Date.now(), 0))));
            }
            const what = rows.length < wanted ? `${wanted} row(s), found ${rows.length}` : `rows that pass the check, found ${rows.length} that don't`;
            return fail('waitForRows', { sql, ...(params ? { params: previewRows(params, 200) } : {}), timeout }, new Error(
                `waited ${timeout} ms for ${what}${rows.length ? `: ${previewRows(rows.slice(0, 5))}` : ''}`,
            ));
        },

        async waitForRow<T extends ClickHouseRow>(sql: string, params?: ClickHouseParams, o: ClickHouseWaitForRowOptions<T> = {}) {
            const { until, ...rest } = o;
            const [row] = await client.waitForRows<T>(sql, params, { ...rest, count: 1, ...(until ? { until: (rows: T[]) => until(rows[0]) } : {}) });
            return row;
        },

        async count(table, whereRow) {
            try {
                const { database: db, table: name } = splitTable(table, database);
                let whereSql = '';
                let params: ClickHouseParams = {};
                if (whereRow && Object.keys(whereRow).length) {
                    const types = new Map((await columnsOf(db, name)).map((c) => [c.name, c.type]));
                    ({ where: whereSql, params } = buildWhere(whereRow, Object.keys(whereRow).map((c) => identifier(c, 'column')), types, `${db}.${name}`, 'w'));
                }
                const [row] = await readAll(`SELECT count() AS n FROM ${db}.${name}${whereSql ? ` WHERE ${whereSql}` : ''}`, params);
                return Number(row?.n ?? 0);
            } catch (error) {
                return fail('count', { table, ...(whereRow ? { where: previewRows(whereRow, 200) } : {}) }, error);
            }
        },

        async createDatabase(name, o = {}) {
            let db = '';
            try {
                db = name ? identifier(name, 'database') : testDatabaseName(runId);
                const [exists] = await readAll('SELECT 1 AS found FROM system.databases WHERE name = {db:String}', { db });
                if (exists) return db;
                await driver.command({ query: `CREATE DATABASE IF NOT EXISTS ${db}` });
            } catch (error) {
                return fail('createDatabase', { database: db || name }, error);
            }
            if (track(o)) {
                ownDatabases.add(db);
                registry!.add(`clickhouse database ${db}`, () => dropDatabase(db));
            }
            return db;
        },

        async dropDatabase(name) {
            try {
                await dropDatabase(identifier(name, 'database'));
            } catch (error) {
                return fail('execute', { database: name }, error);
            }
        },

        async columns(table) {
            try {
                const { database: db, table: name } = splitTable(table, database);
                return await columnsOf(db, name);
            } catch (error) {
                return fail('query', { table }, error);
            }
        },

        async close() {
            await driver.close();
        },
    };
    return client;
}

/** The ClickHouse config: the project option, else ConfigLoader (environments.json, .env, PW_CLICKHOUSE_*), else localhost. */
export async function resolveClickHouseConfig(clickhouse: ClickHouseFixtureConfig | undefined): Promise<ClickHouseFixtureConfig> {
    if (clickhouse) return clickhouse;
    const { ConfigLoader } = await import('../config/loader.js');
    try {
        return new ConfigLoader().load().clickhouse ?? {};
    } catch {
        return {};
    }
}

/**
 * Fixture definition for test.extend(). The undo actions run before the
 * client closes.
 */
export const clickHouseFixture = {
    clickHouseClient: async (
        { clickhouse, stagehandContainers, dataCleanup }: { clickhouse: ClickHouseFixtureConfig | undefined; stagehandContainers: ContainerManager; dataCleanup: CleanupRegistry },
        use: (client: ClickHouseClient) => Promise<void>,
        testInfo: { workerIndex: number },
    ) => {
        const config = await stagehandContainers.clickhouse(await resolveClickHouseConfig(clickhouse));
        const client = await createClickHouseClient(config, { registry: dataCleanup, runId: newRunId(testInfo.workerIndex) });
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
